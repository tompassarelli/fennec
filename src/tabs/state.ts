// Shared mutable state for src/tabs/* modules.
//
// Strategy: WeakMaps and collections live as named exports — they're
// pass-by-reference, so importers see writes immediately. Scalar singletons
// (panel, cursor, etc.) stay inside the legacy index.ts for now and migrate
// into a `state` object here only when a typed slice needs to write them.
//
// Growth principle: this file expands ONLY when a typed module forces it.
// We don't lift state preemptively.

import type { Row, SavedNode, Tab, TreeData } from "./types.ts";

// --- Mutable singletons (set in init, read everywhere) ---

/** Shared, mutable singletons for the tabs subsystem. Fields are written from
 *  init() (DOM refs) or from event/menu handlers (cursor/contextTab/nextTabId).
 *  Readers see updates because object property reads aren't bindings.
 *
 *  panel/spacer/pinnedContainer: typed as non-null. They start as `null` but
 *  every code path that reads them runs AFTER init() has assigned. Casting
 *  the initial null avoids "possibly null" noise at every read site.
 *
 *  cursor/contextTab: legitimately null when no row has focus / no menu is
 *  open. Callers must null-check.
 *
 *  Grow this object only when a typed module needs to share writes — single-
 *  module mutables stay local. */
export const state: {
  panel: HTMLElement;
  spacer: HTMLElement;
  pinnedContainer: HTMLElement;
  contextTab: Tab | null;
  /** Currently right-clicked group row — set by createGroupRow's contextmenu
   *  listener before opening the pfx-group-menu. Null otherwise. */
  contextGroupRow: Row | null;
  cursor: Row | null;
  nextTabId: number;
  /** True from startup until sessionstore-windows-restored fires. Gates the
   *  FIFO fallback in popSavedForTab so user-opened tabs don't consume stale
   *  entries from a previous session. */
  inSessionRestore: boolean;
  /** Snapshot of the tab nodes loaded from disk this session. Consumed by
   *  the sessionstore-initiating-manual-restore observer (Ctrl+Shift+T at
   *  window level) to repopulate savedTabQueue. */
  lastLoadedNodes: SavedNode[];
} = {
  panel: null as unknown as HTMLElement,
  spacer: null as unknown as HTMLElement,
  pinnedContainer: null as unknown as HTMLElement,
  contextTab: null,
  contextGroupRow: null,
  cursor: null,
  nextTabId: 1,
  inSessionRestore: true,
  lastLoadedNodes: [],
};

// --- Tab metadata, keyed by native Firefox tab ---

/** Per-tab tree metadata. Set on first treeData(tab) call; mutated by event
 *  handlers and persist's applySavedToTab. */
export const treeOf = new WeakMap<Tab, TreeData>();

/** Tab → palefox row element. Set by createTabRow, deleted by onTabClose. */
export const rowOf = new WeakMap<Tab, Row>();

/** Row → tab whose visuals to show (used in horizontal-mode collapse, where a
 *  collapsed parent row may visually mirror a different descendant tab). */
export const hzDisplay = new WeakMap<Row, Tab>();

// --- Session-restore + persistence collections ---

/** Saved-tab nodes left over from last session's tree file after the load-time
 *  positional match. Consumed by event handlers as session-restore tabs arrive. */
export const savedTabQueue: SavedNode[] = [];

/** Recently-closed tabs (FIFO, capped by CLOSED_MEMORY in constants.ts). Used
 *  to restore tree hierarchy on Ctrl+Shift+T. */
export const closedTabs: SavedNode[] = [];

// --- UI selection / move guards ---

/** Rows in the current visual multi-select. Consumed by drag/drop, vim
 *  range-ops, and clearSelection on context changes. */
export const selection = new Set<Row>();

/** Tabs currently being moved by palefox via gBrowser.moveTabTo. During a move,
 *  Firefox transiently toggles `busy` on the tab — we suppress the busy-sync and
 *  tree-resync for tabs in this set, then do one clean resync after the move
 *  settles. Pattern cribbed from Sidebery (src/services/tabs.fg.move.ts). */
export const movingTabs = new Set<Tab>();
