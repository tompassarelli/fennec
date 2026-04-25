// Legacy port from chrome/JS/palefox-tabs.uc.js — being incrementally split
// into modules in src/tabs/*.ts. Not @ts-nocheck'd: we lean on tsc to catch
// unbound references after each refactor pass.
// split into modules incrementally. The build wraps the file in IIFE; the
// existing init() bootstrap at the bottom handles delayed startup. Module
// scope is fine because top-level code below has no `return`s outside of
// nested functions.

import { createLogger } from "./log.ts";
import { INDENT, SAVE_FILE, CHORD_TIMEOUT, CLOSED_MEMORY, PIN_ATTR } from "./constants.ts";
import type { Row, SavedNode, Tab, TreeData } from "./types.ts";
import {
  state,
  treeOf, rowOf, hzDisplay, savedTabQueue, closedTabs,
  selection, movingTabs,
} from "./state.ts";
import {
  makeSaver,
  readTreeFromDisk,
  type Snapshot,
} from "./persist.ts";
import { makeDrag } from "./drag.ts";
import { buildContextMenu } from "./menu.ts";
import { makeRows } from "./rows.ts";
import { makeLayout } from "./layout.ts";
import { makeVim } from "./vim.ts";
import { makeEvents } from "./events.ts";
import {
  SS, tryRegisterPinAttr, pinTabId, readPinnedId,
  treeData, tabById, parentOfTab, levelOf, levelOfRow, dataOf,
  allTabs, allRows, hasChildren, subtreeRows, isHorizontal,
  tabUrl,
} from "./helpers.ts";

const pfxLog = createLogger("tabs");

  // (constants moved to ./constants.ts)

  // --- DOM references ---

  // Cast non-null; the early return below validates at runtime. Keeping the
  // type as HTMLElement (instead of HTMLElement | null) means inner functions
  // don't all need their own null checks across closure boundaries.
  const sidebarMain = document.getElementById("sidebar-main") as HTMLElement;
  // The build wraps this file in an IIFE, so this top-level `return` is
  // actually inside the function. TS doesn't see the wrapper.
  // @ts-expect-error TS1108 — intentional early-out from the IIFE.
  if (!sidebarMain) return;

  // (debug log moved to ./log.ts; pfxLog imported above)

  // --- State ---
  // (treeOf, rowOf, hzDisplay imported from ./state.ts)
  // (state.panel, state.spacer, state.pinnedContainer, state.contextTab,
  //  state.cursor, state.nextTabId all live in the imported `state` object)
  // (vim chord state, modeline, search/refile, cursor handoff — all in ./vim.ts)

  // (selection and movingTabs imported from ./state.ts)

  // (closedTabs imported from ./state.ts; capped by CLOSED_MEMORY constant)

  // (savedTabQueue imported from ./state.ts — ordered queue of saved-tab nodes
  // left over from last session's tree file. Session-restore tabs arriving later
  // via onTabOpen consume entries from this queue.)
  // (lastLoadedNodes + inSessionRestore moved to state.ts; events.ts and
  // loadFromDisk both touch them.)

  // Pin a tab's palefox id via SessionStore so it survives browser restart /
  // undoCloseTab / undoCloseWindow. Lets us match live tabs → saved state
  // exactly by id, bypassing URL-comparison fragility for pending tabs.
  // SessionStore.setTabValue/getTabValue aren't exposed on the SessionStore
  // object we can reach from chrome scripts in this Firefox build. Pin via
  // a DOM attribute instead — Firefox's SessionStore tracks a small set of
  // tab attributes via persistTabAttribute. If we can register ours there we
  // get free cross-session persistence; otherwise this is a no-op and we
  // rely on URL matching. (PIN_ATTR in ./constants.ts)
  // --- Selection ---

  function clearSelection() {
    for (const r of selection) r.removeAttribute("pfx-multi");
    selection.clear();
  }

  function selectRange(toRow) {
    const fromRow = state.cursor || rowOf.get(gBrowser.selectedTab);
    if (!fromRow) return;
    const rows = allRows().filter(r => !r.hidden);
    const fromIdx = rows.indexOf(fromRow);
    const toIdx = rows.indexOf(toRow);
    if (fromIdx < 0 || toIdx < 0) return;

    clearSelection();
    const start = Math.min(fromIdx, toIdx);
    const end = Math.max(fromIdx, toIdx);
    for (let i = start; i <= end; i++) {
      selection.add(rows[i]);
      rows[i].setAttribute("pfx-multi", "true");
    }
  }

  function buildPanel() {
    while (state.panel.firstChild !== state.spacer) state.panel.firstChild!.remove();
    while (state.pinnedContainer.firstChild) state.pinnedContainer.firstChild.remove();
    for (const tab of gBrowser.tabs) {
      const row = Rows.createTabRow(tab);
      if (tab.pinned && state.pinnedContainer) {
        state.pinnedContainer.appendChild(row);
      } else {
        state.panel.insertBefore(row, state.spacer);
      }
    }
    if (state.pinnedContainer) {
      state.pinnedContainer.hidden = !state.pinnedContainer.querySelector(".pfx-tab-row");
    }
    Rows.updateVisibility();
  }


  // --- Persistence ---

  // Write-on-every-change: pulls a fresh snapshot for every flush, coalesces
  // overlapping schedules. Implementation in ./persist.ts; the closure here
  // just supplies live state.
  const scheduleSave = makeSaver(() => ({
    tabs: [...gBrowser.tabs],
    rows: () => allRows(),
    savedTabQueue,
    closedTabs,
    nextTabId: state.nextTabId,
    tabUrl,
    treeData,
  }));

  // drag ↔ Rows ↔ vim form a small cycle of mutual deps:
  //   - rows needs drag.setupDrag (each row gets DnD wired) AND vim's row-
  //     action handlers (activateVim, cloneAsChild, startRename, selectRange)
  //   - drag needs Rows.scheduleTreeResync after a drop settles
  //   - vim needs the rows API (createGroupRow, sync*, toggleCollapse, …)
  //     AND the layout API (setUrlbarTopLayer)
  // We break the cycle with `let` declarations + thunks. Each thunk is only
  // invoked later at runtime, by which point all factories have been wired.
  let Rows: import("./rows.ts").RowsAPI;
  let vim: import("./vim.ts").VimAPI;
  const drag = makeDrag({
    clearSelection,
    scheduleTreeResync: () => Rows.scheduleTreeResync(),
    scheduleSave,
  });
  Rows = makeRows({
    setupDrag: drag.setupDrag,
    activateVim:    (row) => vim.activateVim(row),
    selectRange,
    clearSelection,
    cloneAsChild:   (tab) => vim.cloneAsChild(tab),
    startRename:    (row) => vim.startRename(row),
    scheduleSave,
  });
  const layout = makeLayout({
    sidebarMain,
    rows: Rows,
  });
  vim = makeVim({
    rows: Rows,
    layout,
    scheduleSave,
    clearSelection,
    selectRange,
    sidebarMain,
  });
  const events = makeEvents({
    rows: Rows,
    vim,
    scheduleSave,
  });

  async function loadFromDisk() {
    const parsed = await readTreeFromDisk();
    if (!parsed) return;
    try {
      if (parsed.nextTabId != null) state.nextTabId = parsed.nextTabId;
      closedTabs.length = 0;
      closedTabs.push(...parsed.closedTabs);

      const tabs = allTabs();
      const tabNodes = parsed.tabNodes.map(s => ({ ...s }));
      state.lastLoadedNodes = tabNodes.map(s => ({ ...s }));

      // Belt-and-suspenders: advance state.nextTabId past every saved node ID before
      // any tab calls treeData(). saved.nextTabId covers this normally, but if
      // it was missing/stale, fresh startup tabs (localhost, etc.) would get an
      // ID that collides with a restored session tab's pfx-id attribute, causing
      // the wrong tab to resolve as parent in the tree.
      for (const s of tabNodes) {
        if (s.id && s.id >= state.nextTabId) state.nextTabId = s.id + 1;
      }
      pfxLog("loadFromDisk", { nextTabId: state.nextTabId, savedNextTabId: parsed.nextTabId, tabNodes: tabNodes.length, liveTabs: tabs.length, tabNodeIds: tabNodes.map(s => s.id), liveTabPfxIds: tabs.map(t => t.getAttribute?.("pfx-id") || 0) });

      const applied = new Set();
      const apply = (tab, s, i) => {
        const id = s.id || state.nextTabId++;
        treeOf.set(tab, {
          id,
          parentId: s.parentId ?? null,
          name: s.name || null,
          state: s.state || null,
          collapsed: !!s.collapsed,
        });
        pinTabId(tab, id);
        applied.add(i);
      };

      // Sidebery-style positional blindspot match. Walk live tabs and saved
      // nodes pairwise. For each pair: accept if URLs agree OR live tab is
      // pending (about:blank, hasn't loaded yet). Pending tabs always match
      // by position — Firefox restores in saved order, so positions agree
      // even when URLs haven't resolved yet. On URL mismatch with a live
      // URL present, scan ±5 live tabs for a URL match (user opened extras).
      let li = 0;
      for (let ni = 0; ni < tabNodes.length; ni++) {
        if (li >= tabs.length) break;
        const s = tabNodes[ni];
        const live = tabs[li];
        const liveUrl = live.linkedBrowser?.currentURI?.spec || "";
        const pending = liveUrl === "about:blank";
        if (liveUrl === s.url || pending) {
          apply(live, s, ni);
          li++;
          continue;
        }
        // ±5 lookahead for a direct URL match
        let off = 0;
        for (let j = 1; j <= 5 && li + j < tabs.length; j++) {
          const u = tabs[li + j].linkedBrowser?.currentURI?.spec || "";
          if (u === s.url) { off = j; break; }
        }
        if (off) { apply(tabs[li + off], s, ni); li += off + 1; }
        // else: saved node has no live counterpart yet — falls into savedTabState
      }

      console.log(
        `palefox-tabs: loaded ${tabNodes.length} saved tab nodes, ` +
        `matched ${applied.size} to live tabs (of ${tabs.length}).`
      );

      // Leftover nodes (no live match at init). Stash each node's original
      // index in gBrowser.tabs (= its position in the saved tabNodes list,
      // since we serialize in gBrowser.tabs order). Later-arriving session-
      // restore tabs match by their current gBrowser.tabs index.
      savedTabQueue.length = 0;
      tabNodes.forEach((s, i) => {
        if (applied.has(i)) return;
        s._origIdx = i;
        savedTabQueue.push(s);
      });

      // Full node list drives buildFromSaved for groups + order.
      loadedNodes = parsed.nodes;
    } catch (e) {
      console.error("palefox-tabs: loadFromDisk apply error", e);
    }
  }

  let loadedNodes: readonly SavedNode[] | null = null;

  // Build the state.panel from gBrowser.tabs (canonical order). Interleave groups
  // at their saved afterTabId anchors. Unanchored groups go to the top.
  function buildFromSaved() {
    if (!loadedNodes || !state.panel) return false;

    const groupNodes = loadedNodes.filter(n => n.type === "group");

    // Bucket groups by their anchor tab id. `null` = "top of state.panel."
    const leadingGroups: SavedNode[] = [];
    const groupsAfter = new Map<number, SavedNode[]>();
    for (const g of groupNodes) {
      if (g.afterTabId == null) leadingGroups.push(g);
      else {
        const arr = groupsAfter.get(g.afterTabId) || [];
        arr.push(g);
        groupsAfter.set(g.afterTabId, arr);
      }
    }

    const mkGroup = (g: SavedNode): Row => {
      const row = Rows.createGroupRow(g.name || "", g.level || 0);
      row._group!.state = g.state || null;
      row._group!.collapsed = !!g.collapsed;
      Rows.syncGroupRow(row);
      return row;
    };

    while (state.panel.firstChild !== state.spacer) state.panel.firstChild!.remove();
    while (state.pinnedContainer.firstChild) state.pinnedContainer.firstChild.remove();

    for (const g of leadingGroups) state.panel.insertBefore(mkGroup(g), state.spacer);

    for (const tab of gBrowser.tabs) {
      const row = Rows.createTabRow(tab);
      if (tab.pinned && state.pinnedContainer) {
        state.pinnedContainer.appendChild(row);
      } else {
        state.panel.insertBefore(row, state.spacer);
        const tid = treeData(tab).id;
        const groups = groupsAfter.get(tid);
        if (groups) for (const g of groups) state.panel.insertBefore(mkGroup(g), state.spacer);
      }
    }
    if (state.pinnedContainer) {
      state.pinnedContainer.hidden = !state.pinnedContainer.querySelector(".pfx-tab-row");
    }

    loadedNodes = null;
    Rows.scheduleTreeResync();
    Rows.updateVisibility();
    return true;
  }



  // --- Init ---

  async function init() {
    tryRegisterPinAttr();
    await loadFromDisk();
    await new Promise((r) => requestAnimationFrame(r));

    state.pinnedContainer = document.createXULElement("hbox");
    state.pinnedContainer.id = "pfx-pinned-container";
    state.pinnedContainer.hidden = true;
    drag.setupPinnedContainerDrop(state.pinnedContainer);

    state.panel = document.createXULElement("vbox");
    state.panel.id = "pfx-tab-panel";

    state.spacer = document.createXULElement("box");
    state.spacer.id = "pfx-tab-spacer";
    state.spacer.setAttribute("flex", "1");
    state.panel.appendChild(state.spacer);
    drag.setupPanelDrop(state.panel);

    layout.positionPanel();

    // Re-position when toolbox moves in/out of sidebar, or expand/collapse
    new MutationObserver(() => layout.positionPanel()).observe(sidebarMain, {
      childList: true,
      attributes: true,
      attributeFilter: ["sidebar-launcher-expanded"],
    });

    // Switch between horizontal/vertical layout
    Services.prefs.addObserver("sidebar.verticalTabs", {
      observe() { layout.positionPanel(); },
    });

    // Build from saved data (preserves groups + order) or fresh
    if (!buildFromSaved()) buildPanel();

    buildContextMenu({
      startRename: vim.startRename,
      toggleCollapse: Rows.toggleCollapse,
      createGroupRow: Rows.createGroupRow,
      setCursor: vim.setCursor,
      updateVisibility: Rows.updateVisibility,
      scheduleSave,
    });
    vim.createModeline();
    vim.setupVimKeys();
    vim.focusPanel();

    // events.ts wires all gBrowser.tabContainer listeners + the sessionstore
    // observers. The returned closure removes the observers on window unload
    // (the listeners die with the window).
    const teardownEvents = events.install();

    // Click on state.spacer activates vim with last row.
    state.spacer.addEventListener("click", () => {
      const visible = allRows().filter(r => !r.hidden);
      if (visible.length) vim.activateVim(visible[visible.length - 1]!);
    });

    window.addEventListener("unload", teardownEvents, { once: true });

    console.log("palefox-tabs: initialized");
  }

  if (gBrowserInit.delayedStartupFinished) {
    init();
  } else {
    const obs = (subject, topic) => {
      if (topic === "browser-delayed-startup-finished" && subject === window) {
        Services.obs.removeObserver(obs, topic);
        init();
      }
    };
    Services.obs.addObserver(obs, "browser-delayed-startup-finished");
  }
