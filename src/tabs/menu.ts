// Tab context menu — palefox items at top, native Firefox actions below.
//
// Public API:
//   buildContextMenu(deps) — constructs the menupopup, appends it to
//   #mainPopupSet, returns the element. Call once at init time.
//
// state.contextTab is the read-only "currently right-clicked tab" — it's
// written by the row-level contextmenu listener (in createTabRow / legacy)
// before openPopupAtScreen fires, so by the time popupshowing runs it's set.

import { rowOf, state } from "./state.ts";
import { dataOf, hasChildren, levelOfRow, subtreeRows } from "./helpers.ts";
import type { Row } from "./types.ts";

declare const Cc: any;
declare const Ci: any;
declare const document: Document;
declare const gBrowser: any;
declare const TabContextMenu: any;
declare const PlacesCommandHook: any;
declare const undoCloseTab: () => void;

// =============================================================================
// INTERFACE
// =============================================================================

export type MenuDeps = {
  /** Begin in-place renaming of the row. From legacy index.ts; will move when
   *  we extract the rename slice. */
  readonly startRename: (row: Row) => void;
  /** Toggle a row's collapsed state in the tree. */
  readonly toggleCollapse: (row: Row) => void;
  /** Build a new group row at a given indent level. */
  readonly createGroupRow: (name: string, level: number) => Row;
  /** Move the vim cursor to the given row. */
  readonly setCursor: (row: Row) => void;
  /** Update collapsed-row visibility throughout the panel. */
  readonly updateVisibility: () => void;
  /** Persist tree state to disk. */
  readonly scheduleSave: () => void;
};

// =============================================================================
// IMPLEMENTATION
// =============================================================================

export function buildContextMenu(deps: MenuDeps): HTMLElement {
  const {
    startRename, toggleCollapse, createGroupRow, setCursor,
    updateVisibility, scheduleSave,
  } = deps;

  const menu = document.createXULElement("menupopup") as HTMLElement;
  menu.id = "pfx-tab-menu";

  function mi(label: string, handler: () => void): HTMLElement {
    const item = document.createXULElement("menuitem") as HTMLElement;
    item.setAttribute("label", label);
    item.addEventListener("command", handler);
    return item;
  }
  const sep = () => document.createXULElement("menuseparator") as HTMLElement;

  // --- Palefox items ---
  const renameItem = mi("Rename Tab", () => {
    if (state.contextTab) {
      const row = rowOf.get(state.contextTab);
      if (row) startRename(row);
    }
  });
  const collapseItem = mi("Collapse", () => {
    if (!state.contextTab) return;
    const row = rowOf.get(state.contextTab);
    if (row) toggleCollapse(row);
  });
  const createGroupItem = mi("Create Group", () => {
    if (!state.contextTab) return;
    const row = rowOf.get(state.contextTab);
    if (!row) return;
    const grp = createGroupRow("New Group", levelOfRow(row));
    const st = subtreeRows(row);
    st[st.length - 1]!.after(grp);
    setCursor(grp);
    updateVisibility();
    scheduleSave();
    startRename(grp);
  });
  const closeKidsItem = mi("Close Children", () => {
    if (!state.contextTab) return;
    const row = rowOf.get(state.contextTab);
    if (!row) return;
    const kids = subtreeRows(row).slice(1);
    for (let i = kids.length - 1; i >= 0; i--) {
      const k = kids[i]!;
      if (k._tab) gBrowser.removeTab(k._tab);
      else k.remove();
    }
  });

  // --- Native actions (call Firefox APIs directly) ---
  const splitViewItem = mi("Add Split View", () => {
    if (!state.contextTab) return;
    TabContextMenu.contextTab = state.contextTab;
    TabContextMenu.contextTabs = [state.contextTab];
    TabContextMenu.moveTabsToSplitView();
  });
  const reloadItem = mi("Reload Tab", () => {
    if (state.contextTab) gBrowser.reloadTab(state.contextTab);
  });
  const muteItem = mi("Mute Tab", () => {
    if (state.contextTab) state.contextTab.toggleMuteAudio();
  });
  const pinItem = mi("Pin Tab", () => {
    if (!state.contextTab) return;
    if (state.contextTab.pinned) gBrowser.unpinTab(state.contextTab);
    else gBrowser.pinTab(state.contextTab);
  });
  const duplicateItem = mi("Duplicate Tab", () => {
    if (state.contextTab) gBrowser.duplicateTab(state.contextTab);
  });
  const bookmarkItem = mi("Bookmark Tab", () => {
    if (state.contextTab) PlacesCommandHook.bookmarkTabs([state.contextTab]);
  });
  const moveToWindowItem = mi("Move to New Window", () => {
    if (state.contextTab) gBrowser.replaceTabWithWindow(state.contextTab);
  });
  const copyLinkItem = mi("Copy Link", () => {
    if (!state.contextTab) return;
    const url = state.contextTab.linkedBrowser?.currentURI?.spec;
    if (url) {
      Cc["@mozilla.org/widget/clipboardhelper;1"]
        .getService(Ci.nsIClipboardHelper).copyString(url);
    }
  });
  const closeItem = mi("Close Tab", () => {
    if (state.contextTab) gBrowser.removeTab(state.contextTab);
  });
  const reopenItem = mi("Reopen Closed Tab", () => {
    undoCloseTab();
  });

  menu.append(
    renameItem, collapseItem, createGroupItem, closeKidsItem,
    sep(),
    splitViewItem, reloadItem, muteItem, pinItem, duplicateItem,
    sep(),
    bookmarkItem, copyLinkItem, moveToWindowItem,
    sep(),
    closeItem, reopenItem,
  );

  menu.addEventListener("popupshowing", () => {
    if (!state.contextTab) return;
    const row = rowOf.get(state.contextTab);
    const has = !!row && hasChildren(row);
    collapseItem.hidden = !has;
    closeKidsItem.hidden = !has;
    if (has && row) {
      const d = dataOf(row);
      collapseItem.setAttribute("label", d?.collapsed ? "Expand" : "Collapse");
    }
    muteItem.setAttribute(
      "label",
      state.contextTab.hasAttribute("muted") ? "Unmute Tab" : "Mute Tab",
    );
    pinItem.setAttribute(
      "label",
      state.contextTab.pinned ? "Unpin Tab" : "Pin Tab",
    );
    splitViewItem.hidden = !!state.contextTab.splitview;
  });

  document.getElementById("mainPopupSet")!.appendChild(menu);
  return menu;
}
