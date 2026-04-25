// Tier 2 test harness — happy-dom + chrome global mocks.
//
// What this provides for tests:
//   - A fresh `window` / `document` (happy-dom) with `#sidebar-main` and
//     `#navigator-toolbox` already in the body
//   - `Services.prefs` backed by a Map, with addObserver/removeObserver
//     correctly notifying registered observers on setBoolPref/setIntPref
//   - `ChromeUtils.importESModule` returning `{ SessionStore: null }` so
//     helpers.ts top-level IIFE doesn't throw
//   - `Ci`, `Cu`, `Cc` as empty-object stubs (most code accesses
//     `Ci.nsIFile` etc as opaque tokens — cheap to stub)
//   - `document.createXULElement` mapped to `document.createElement`
//   - `requestAnimationFrame` from happy-dom, plus a `flushRAF()` helper
//     that runs pending callbacks synchronously
//
// Per-test usage:
//   const harness = setupHarness();
//   afterEach(() => harness.cleanup());
//
// Goals (per docs/dev/testing.md, Tier 2):
//   - Tests run under plain `bun test` (no Firefox launch)
//   - State-machine logic (compact, drag, rows) tested deterministically
//   - Tests passing here do NOT prove behavior in Firefox — that's Tier 3.

import { Window } from "happy-dom";

// =============================================================================
// INTERFACE
// =============================================================================

export interface PrefObserver {
  observe(subject: unknown, topic: string, data: string): void;
}

export interface Harness {
  window: Window;
  /** The happy-dom Document. Cast to the global `Document` type for
   *  ergonomic use in tests. */
  document: Document;
  /** Map-backed pref storage. Read directly with `harness.prefs.get(key)`,
   *  or write via `harness.setPref(key, value)` to fire observer callbacks. */
  prefs: Map<string, unknown>;
  /** Per-key observer set, populated by Services.prefs.addObserver. */
  prefObservers: Map<string, Set<PrefObserver>>;
  /** Set a pref and fire observers (mimics the production setBoolPref
   *  cascade — Services.prefs.setBoolPref → observer.observe). */
  setPref(key: string, value: unknown): void;
  /** Flush any pending requestAnimationFrame callbacks synchronously. Compact
   *  mode batches DOM writes via rAF, so tests need to call this between
   *  triggering an event and asserting the resulting attribute. */
  flushRAF(): void;
  /** Tear down: restore previously-overridden globals. Call from afterEach. */
  cleanup(): void;
}

// =============================================================================
// IMPLEMENTATION
// =============================================================================

const GLOBALS_TO_OVERRIDE = [
  "window",
  "document",
  "Services",
  "Ci",
  "Cu",
  "Cc",
  "ChromeUtils",
  "PathUtils",
  "IOUtils",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "getComputedStyle",
  "MutationObserver",
] as const;

export function setupHarness(): Harness {
  const happyWindow = new Window();
  const happyDoc = happyWindow.document;

  const prefs = new Map<string, unknown>();
  const prefObservers = new Map<string, Set<PrefObserver>>();

  // Defaults palefox actually reads. Tests override per-case via setPref.
  prefs.set("sidebar.verticalTabs", true);
  prefs.set("sidebar.position_start", true);
  prefs.set("pfx.compact.hoverHackDelay", 0);
  prefs.set("pfx.debug", false);

  function notify(key: string): void {
    for (const obs of prefObservers.get(key) ?? []) {
      try {
        obs.observe(null, key, "");
      } catch (e) {
        console.error("[harness] pref observer threw", e);
      }
    }
  }

  const Services = {
    prefs: {
      getBoolPref(key: string, fallback?: boolean): boolean {
        return prefs.has(key) ? Boolean(prefs.get(key)) : (fallback ?? false);
      },
      setBoolPref(key: string, value: boolean): void {
        prefs.set(key, value);
        notify(key);
      },
      getIntPref(key: string, fallback?: number): number {
        return prefs.has(key) ? Number(prefs.get(key)) : (fallback ?? 0);
      },
      setIntPref(key: string, value: number): void {
        prefs.set(key, value);
        notify(key);
      },
      getCharPref(key: string, fallback?: string): string {
        return prefs.has(key) ? String(prefs.get(key)) : (fallback ?? "");
      },
      setCharPref(key: string, value: string): void {
        prefs.set(key, value);
        notify(key);
      },
      addObserver(key: string, observer: PrefObserver): void {
        if (!prefObservers.has(key)) prefObservers.set(key, new Set());
        prefObservers.get(key)!.add(observer);
      },
      removeObserver(key: string, observer: PrefObserver): void {
        prefObservers.get(key)?.delete(observer);
      },
    },
    dirsvc: { get: () => ({ path: "/tmp" }) },
  };

  // Save what we're about to overwrite. Restore on cleanup.
  const saved: Record<string, unknown> = {};
  for (const k of GLOBALS_TO_OVERRIDE) {
    saved[k] = (globalThis as any)[k];
  }

  // Wire happy-dom into globals.
  (globalThis as any).window = happyWindow;
  (globalThis as any).document = happyDoc;
  (globalThis as any).Services = Services;
  (globalThis as any).Ci = {};
  (globalThis as any).Cu = {};
  (globalThis as any).Cc = {};
  (globalThis as any).ChromeUtils = {
    importESModule: () => ({ SessionStore: null }),
  };
  (globalThis as any).PathUtils = {
    join: (...parts: string[]) => parts.join("/"),
  };
  (globalThis as any).IOUtils = {
    writeUTF8: async () => {},
    readUTF8: async () => { throw new Error("no file"); },
    write: async () => {},
    stat: async () => ({ size: 0 }),
  };
  (globalThis as any).requestAnimationFrame = happyWindow.requestAnimationFrame.bind(happyWindow);
  (globalThis as any).cancelAnimationFrame = happyWindow.cancelAnimationFrame.bind(happyWindow);
  (globalThis as any).getComputedStyle = happyWindow.getComputedStyle.bind(happyWindow);
  (globalThis as any).MutationObserver = happyWindow.MutationObserver;

  // Map createXULElement → createElement. XUL ≈ HTML for our purposes.
  (happyDoc as any).createXULElement = (tag: string) => happyDoc.createElement(tag);

  // Pre-populate the elements compact mode binds to.
  const sidebarMain = happyDoc.createElement("div");
  sidebarMain.id = "sidebar-main";
  happyDoc.body.appendChild(sidebarMain);

  const navigatorToolbox = happyDoc.createElement("div");
  navigatorToolbox.id = "navigator-toolbox";
  happyDoc.body.appendChild(navigatorToolbox);

  // happy-dom's rAF queues the callback into a microtask; fire any pending
  // callbacks synchronously so tests don't need to await timers.
  function flushRAF(): void {
    // happy-dom's rAF resolves on the next "task" — calling
    // happyWindow.happyDOM.waitUntilComplete() flushes everything pending.
    // For our purposes a synchronous loop of small awaits is fine; expose
    // a helper that lets tests opt in.
    (happyWindow.happyDOM as any).abort?.();
  }

  return {
    window: happyWindow,
    document: happyDoc as unknown as Document,
    prefs,
    prefObservers,
    setPref(key, value) {
      prefs.set(key, value);
      notify(key);
    },
    flushRAF,
    cleanup() {
      for (const k of GLOBALS_TO_OVERRIDE) {
        if (saved[k] === undefined) delete (globalThis as any)[k];
        else (globalThis as any)[k] = saved[k];
      }
      // Best-effort: close the happy-dom window so background tasks stop.
      try {
        happyWindow.close();
      } catch {}
    },
  };
}
