// Tree helpers — pure functions over state. Most are read-only walks of the
// row DOM and tree metadata. The handful that mutate (treeData on first call,
// the pinAttr SessionStore registration) are clearly noted.
//
// This module has no init step. Callers import what they need; functions
// resolve their dependencies through state.ts and chrome globals.

import { PIN_ATTR } from "./constants.ts";
import { createLogger } from "./log.ts";
import { rowOf, state, treeOf } from "./state.ts";
import type { Group, Row, Tab, TreeData } from "./types.ts";

declare const ChromeUtils: any;
declare const gBrowser: any;
declare const Services: any;

const log = createLogger("tabs");

// =============================================================================
// SessionStore — palefox-id persistence via persistTabAttribute
// =============================================================================

/** SessionStore module. In some chrome-script contexts the global isn't
 *  exposed, so we fall back to ChromeUtils.importESModule. Returns null if
 *  neither path works; in that case persistTabAttribute is a no-op and we
 *  rely on URL matching for cross-session tab identification. */
export const SS = (() => {
  try {
    // @ts-ignore — the bare reference triggers a ReferenceError when the
    // global isn't present, hence the try/catch.
    if (typeof SessionStore !== "undefined") return SessionStore;
  } catch {}
  try {
    return ChromeUtils.importESModule(
      "resource:///modules/sessionstore/SessionStore.sys.mjs",
    ).SessionStore;
  } catch (e) {
    console.error("palefox-tabs: SessionStore unavailable", e);
    return null;
  }
})();

let pinAttrRegistered = false;
/** Idempotent: registers PIN_ATTR with SessionStore so palefox-ids survive
 *  browser restart, undoCloseTab, undoCloseWindow. No-op if SS is missing. */
export function tryRegisterPinAttr(): void {
  if (pinAttrRegistered || !SS?.persistTabAttribute) return;
  try {
    SS.persistTabAttribute(PIN_ATTR);
    pinAttrRegistered = true;
  } catch (e) {
    console.error("palefox-tabs: persistTabAttribute failed", e);
  }
}

/** Write a tab's palefox-id to the persistent XUL attribute. */
export function pinTabId(tab: Tab, id: number): void {
  try {
    tab.setAttribute(PIN_ATTR, String(id));
  } catch {}
}

/** Read a tab's persisted palefox-id, or 0 if none / unparseable. */
export function readPinnedId(tab: Tab): number {
  try {
    const v = tab.getAttribute?.(PIN_ATTR);
    if (v) {
      const n = Number(v);
      if (n) return n;
    }
  } catch {}
  return 0;
}

// =============================================================================
// Tab tree metadata
// =============================================================================

/** Get-or-init: fetches the TreeData for a tab. On first call for a tab,
 *  reads its persisted pfx-id (or assigns a fresh one), records the entry in
 *  treeOf, and advances state.nextTabId. Always returns a valid TreeData. */
export function treeData(tab: Tab): TreeData {
  if (!treeOf.has(tab)) {
    let id = readPinnedId(tab);
    if (id) {
      if (id >= state.nextTabId) state.nextTabId = id + 1;
      log("treeData:pfxId", { pfxId: id, label: tab.label, nextTabId: state.nextTabId });
    } else {
      id = state.nextTabId++;
      pinTabId(tab, id);
      log("treeData:fresh", { id, label: tab.label, nextTabId: state.nextTabId });
    }
    treeOf.set(tab, {
      id,
      parentId: null,
      name: null,
      state: null,
      collapsed: false,
    });
  }
  return treeOf.get(tab)!;
}

/** Look up a tab by palefox-id. Returns null if no match. O(N) over tabs. */
export function tabById(id: number | null | undefined): Tab | null {
  if (!id) return null;
  for (const t of gBrowser.tabs as Iterable<Tab>) {
    if (treeOf.get(t)?.id === id) return t;
  }
  return null;
}

/** Direct parent tab via parentId. Returns null if root or parent missing. */
export function parentOfTab(tab: Tab): Tab | null {
  return tabById(treeData(tab).parentId);
}

/** Depth in the tree = number of parent-chain hops to root. Cycle-guarded. */
export function levelOf(tab: Tab): number {
  let lv = 0;
  let t: Tab | null = tab;
  const seen = new Set<Tab>();
  while (t && !seen.has(t)) {
    seen.add(t);
    const pid = treeData(t).parentId;
    if (!pid) break;
    const p = tabById(pid);
    if (!p) break;
    lv++;
    t = p;
  }
  return lv;
}

/** Polymorphic level: computed for tab rows, stored for group rows. */
export function levelOfRow(row: Row | null | undefined): number {
  if (!row) return 0;
  if (row._group) return row._group.level || 0;
  if (row._tab) return levelOf(row._tab);
  return 0;
}

/** Polymorphic data access: returns TreeData for tab rows, Group for group
 *  rows, or null. Use levelOfRow(row) when you need polymorphic level. */
export function dataOf(row: Row): TreeData | Group | null {
  if (row._group) return row._group;
  if (row._tab) return treeData(row._tab);
  return null;
}

// =============================================================================
// Row / tab walks
// =============================================================================

/** Snapshot of all live Firefox tabs in canonical order. */
export function allTabs(): Tab[] {
  return [...gBrowser.tabs] as Tab[];
}

/** All palefox rows (tabs + groups) in visual order: pinned container first,
 *  then the tree panel. Returns an array — safe to iterate while mutating. */
export function allRows(): Row[] {
  const pinned = state.pinnedContainer
    ? [...state.pinnedContainer.querySelectorAll<HTMLElement>(".pfx-tab-row")] as Row[]
    : [];
  const treeRows = state.panel
    ? [...state.panel.querySelectorAll<HTMLElement>(".pfx-tab-row, .pfx-group-row")] as Row[]
    : [];
  return [...pinned, ...treeRows];
}

/** True iff `row` has any descendants in the panel. */
export function hasChildren(row: Row): boolean {
  const next = row.nextElementSibling as Row | null;
  if (!next || next === state.spacer) return false;
  return levelOfRow(next) > levelOfRow(row);
}

/** Get `row` plus all deeper rows immediately following it (level-based walk).
 *  Works for mixed tab+group subtrees because levelOfRow is polymorphic. */
export function subtreeRows(row: Row | null | undefined): Row[] {
  if (!row) return [];
  const lv = levelOfRow(row);
  const out: Row[] = [row];
  let next = row.nextElementSibling as Row | null;
  while (next && next !== state.spacer) {
    if (levelOfRow(next) <= lv) break;
    out.push(next);
    next = next.nextElementSibling as Row | null;
  }
  return out;
}

// =============================================================================
// UI-mode checks
// =============================================================================

/** True when the panel is in horizontal layout mode. */
export function isHorizontal(): boolean {
  return !!state.panel?.hasAttribute("pfx-horizontal");
}

// =============================================================================
// Tab URL — survives pending/lazy-restored tabs by consulting SessionStore
// =============================================================================

/** Best-effort URL for a tab. Falls back through:
 *    1. Live linkedBrowser URL (if not about:blank).
 *    2. SessionStore.getTabState entry list (for pending/lazy-restored tabs
 *       that haven't navigated yet).
 *    3. The raw spec (which may still be about:blank — caller decides).
 */
export function tabUrl(tab: Tab): string {
  if (!tab) return "";
  const spec = tab.linkedBrowser?.currentURI?.spec;
  if (spec && spec !== "about:blank") return spec;
  if (SS) {
    try {
      const raw = SS.getTabState(tab);
      if (raw) {
        const ts = JSON.parse(raw);
        const entries = ts.entries;
        if (Array.isArray(entries) && entries.length) {
          const idx = Math.max(0, Math.min(entries.length - 1, (ts.index || 1) - 1));
          const entryUrl = entries[idx]?.url;
          if (entryUrl) return entryUrl;
        }
      }
    } catch (e) {
      console.error("palefox-tabs: getTabState failed", e);
    }
  }
  return spec || "";
}
