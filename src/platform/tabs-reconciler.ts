// Tabs reconciler — bridges Firefox tab events into the scheduler.
//
// **Phase 1 minimal contract:** subscribe to `gBrowser.tabContainer`'s tab
// events and call `scheduler.markDirty("tabs", reason)`. The actual model
// rebuild logic stays in `src/tabs/events.ts` for now; M2 migrates that
// logic INTO this reconciler over time.
//
// The point of this reconciler shipping in Phase 1 is to establish the
// dirty-flag protocol — every adapter call site that today directly
// mutates `treeOf` will eventually go through `markDirty` instead, and
// this reconciler will own the rebuild. We're putting the seam in place.

import { createLogger, type Logger } from "../tabs/log.ts";
import type { SchedulerAPI } from "./scheduler.ts";

declare const gBrowser: {
  tabContainer: { addEventListener(t: string, fn: EventListener): void; removeEventListener(t: string, fn: EventListener): void };
};

// =============================================================================
// INTERFACE
// =============================================================================

export type TabsReconcilerDeps = {
  readonly scheduler: SchedulerAPI;
};

export type TabsReconcilerAPI = {
  /** Tear down event listeners + unregister reconciler. */
  destroy(): void;
};

// =============================================================================
// IMPLEMENTATION
// =============================================================================

export function makeTabsReconciler(deps: TabsReconcilerDeps): TabsReconcilerAPI {
  const log: Logger = createLogger("reconciler/tabs");
  const { scheduler } = deps;

  // Phase 1: minimal reconciler — logs reasons, no model rebuild yet.
  // The current event-handler logic in src/tabs/events.ts continues to
  // mutate `treeOf` directly. M2 will move that logic into this reconciler.
  const unregister = scheduler.register({
    domain: "tabs",
    run(reasons) {
      log("reconcile", { reasons });
      // Future: read gBrowser.tabs, walk treeOf, sync.
    },
  });

  function onTabEvent(this: void, e: Event): void {
    scheduler.markDirty("tabs", e.type);
  }

  for (const ev of ["TabOpen", "TabClose", "TabMove", "TabSelect", "TabAttrModified", "TabPinned", "TabUnpinned"]) {
    gBrowser.tabContainer.addEventListener(ev, onTabEvent as EventListener);
  }

  function destroy(): void {
    for (const ev of ["TabOpen", "TabClose", "TabMove", "TabSelect", "TabAttrModified", "TabPinned", "TabUnpinned"]) {
      gBrowser.tabContainer.removeEventListener(ev, onTabEvent as EventListener);
    }
    unregister();
  }

  return { destroy };
}
