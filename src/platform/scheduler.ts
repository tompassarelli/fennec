// Palefox central scheduler.
//
// Owns the dirty-flag + microtask + ordering machinery that powers every
// domain reconciler. One scheduler per chrome window. Architectural
// commitment: many domain reconcilers, one scheduler.
//
// Dirty-flag protocol:
//   1. Adapter receives Firefox primitive event.
//   2. Adapter calls scheduler.markDirty("tabs", "TabOpen").
//   3. Scheduler dedupes (same domain marked multiple times = one reconcile).
//   4. Scheduler queues a microtask; subsequent markDirty calls coalesce
//      into the same upcoming reconcile pass.
//   5. Microtask runs reconcilers in DECLARED ORDER (prefs → windows →
//      tabs → snapshots → sidebar → command/picker derived).
//   6. Each reconciler reads stable Firefox primitives + rebuilds its
//      slice of the Palefox model.
//
// flush() is the consistency-sensitive escape hatch:
//
//   Palefox.windows.current().tabs.pin(id);
//   await Palefox.flush();
//   // model is reconciled with reality
//
// Outside of `await Palefox.flush()`, callers should assume their write
// is visible synchronously (write-through model updates) AND that the
// next microtask will reconcile against ground truth (rebuild from
// gBrowser.tabs et al.). If those two views ever diverge, the
// reconciler view wins.

import { createLogger, type Logger } from "../tabs/log.ts";

// =============================================================================
// INTERFACE
// =============================================================================

/** Stable identifier for a reconciler's domain. New domains added here as
 *  they're introduced; the order of this array is the order reconcilers
 *  run in. */
export type Domain =
  | "prefs"
  | "windows"
  | "tabs"
  | "snapshots"
  | "sidebar"
  | "command";

/** The order reconcilers run on each flush. Derived state (sidebar, command)
 *  comes after authoritative state (prefs, tabs) so it sees a settled view. */
export const DOMAIN_ORDER: readonly Domain[] = [
  "prefs",
  "windows",
  "tabs",
  "snapshots",
  "sidebar",
  "command",
];

export type Reconciler = {
  /** Domain this reconciler owns. */
  readonly domain: Domain;
  /** Reconcile from current Firefox primitive state. Sync — keep it fast.
   *  Throwing is fine; the scheduler logs and continues with the next
   *  domain (one bad reconciler doesn't poison the others). */
  readonly run: (reasons: readonly string[]) => void;
};

export type SchedulerAPI = {
  /** Register a reconciler for a domain. Multiple reconcilers per domain
   *  are allowed; they run in registration order within the domain. */
  register(reconciler: Reconciler): () => void;
  /** Flag a domain as needing reconciliation. Reason is a short tag
   *  ("TabOpen", "TabClose", "menu-popup-hidden") — multiple reasons
   *  collected per pass and passed to reconcilers for diagnostics. */
  markDirty(domain: Domain, reason: string): void;
  /** Force-run all pending reconcilers right now (synchronously) and
   *  await any in-flight microtask pass. Use when callers absolutely
   *  need the model settled before continuing — rare. */
  flush(): Promise<void>;
  /** Diagnostic — current scheduler state. */
  diag(): { pending: Record<Domain, readonly string[]>; nextFlushPending: boolean; lastReconcileMs: number | null };
  /** Tear down. Cancels any pending microtask reconcile. */
  destroy(): void;
};

// =============================================================================
// IMPLEMENTATION
// =============================================================================

export function makeScheduler(): SchedulerAPI {
  const log: Logger = createLogger("scheduler");
  const reconcilers = new Map<Domain, Reconciler[]>();
  const pending = new Map<Domain, string[]>();
  let pendingFlush: Promise<void> | null = null;
  let pendingResolve: (() => void) | null = null;
  let lastReconcileMs: number | null = null;
  let destroyed = false;

  function getDirty(domain: Domain): string[] {
    let arr = pending.get(domain);
    if (!arr) {
      arr = [];
      pending.set(domain, arr);
    }
    return arr;
  }

  function runOnce(): void {
    if (destroyed) return;
    const startedAt = performance.now();
    // Snapshot pending reasons and clear before running so reconcilers
    // can re-mark themselves dirty if they need a follow-up pass.
    const snapshot = new Map(pending);
    pending.clear();

    for (const domain of DOMAIN_ORDER) {
      const reasons = snapshot.get(domain);
      if (!reasons || reasons.length === 0) continue;
      const handlers = reconcilers.get(domain) ?? [];
      for (const r of handlers) {
        try {
          r.run(reasons);
        } catch (e) {
          log("reconciler:error", { domain, reasons, msg: String(e) });
        }
      }
    }

    lastReconcileMs = performance.now() - startedAt;
    log("reconcile:done", { ms: lastReconcileMs });
  }

  function schedule(): void {
    if (pendingFlush || destroyed) return;
    pendingFlush = new Promise<void>((resolve) => {
      pendingResolve = resolve;
      queueMicrotask(() => {
        try {
          runOnce();
        } finally {
          // If a reconciler markDirty'd something during runOnce, schedule
          // a follow-up pass. The new pendingFlush will be a fresh promise.
          const hadCarryover = [...pending.values()].some((arr) => arr.length > 0);
          pendingFlush = null;
          const localResolve = pendingResolve;
          pendingResolve = null;
          if (hadCarryover) schedule();
          localResolve?.();
        }
      });
    });
  }

  function register(reconciler: Reconciler): () => void {
    let list = reconcilers.get(reconciler.domain);
    if (!list) {
      list = [];
      reconcilers.set(reconciler.domain, list);
    }
    list.push(reconciler);
    log("register", { domain: reconciler.domain });
    return () => {
      const arr = reconcilers.get(reconciler.domain);
      if (!arr) return;
      const i = arr.indexOf(reconciler);
      if (i >= 0) arr.splice(i, 1);
    };
  }

  function markDirty(domain: Domain, reason: string): void {
    if (destroyed) return;
    getDirty(domain).push(reason);
    schedule();
  }

  async function flush(): Promise<void> {
    while (pendingFlush) {
      await pendingFlush;
    }
  }

  function diag() {
    const out = {} as Record<Domain, readonly string[]>;
    for (const d of DOMAIN_ORDER) {
      out[d] = pending.get(d) ?? [];
    }
    return {
      pending: out,
      nextFlushPending: pendingFlush !== null,
      lastReconcileMs,
    };
  }

  function destroy(): void {
    destroyed = true;
    pending.clear();
    reconcilers.clear();
  }

  return { register, markDirty, flush, diag, destroy };
}
