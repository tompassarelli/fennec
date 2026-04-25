// @ts-nocheck
// Legacy port from chrome/JS/palefox-drawer.uc.js — keeping ts-nocheck while
// we incrementally add types. The build wraps the file in IIFE; the inner
// init() function exists so the early-return guard below is valid (top-level
// return is illegal in modules).

function init() {
  // --- Element references ---

  const sidebarMain = document.getElementById("sidebar-main");
  const navigatorToolbox = document.getElementById("navigator-toolbox");
  const urlbarContainer = document.getElementById("urlbar-container");
  const navBar = document.getElementById("nav-bar");
  const urlbar = document.getElementById("urlbar");

  if (!sidebarMain || !navigatorToolbox || !urlbarContainer || !navBar) {
    console.error("palefox-drawer: missing required elements");
    return;
  }

  const sidebarMainElement = sidebarMain.querySelector("sidebar-main");

  // Hide the resize splitter inside sidebar-main's shadow DOM.
  // Shadow root may not exist yet — poll briefly until it does.
  function hideSidebarSplitter() {
    const sr = sidebarMainElement?.shadowRoot;
    if (!sr) return setTimeout(hideSidebarSplitter, 100);
    const s = new CSSStyleSheet();
    s.replaceSync(`
      #sidebar-tools-and-extensions-splitter { display: none !important; }
    `);
    sr.adoptedStyleSheets.push(s);
  }
  hideSidebarSplitter();

  // Save original DOM positions before any moves, for collapse restoration.
  const toolboxParent = navigatorToolbox.parentNode;
  const toolboxNext = navigatorToolbox.nextSibling;
  const urlbarParent = urlbarContainer.parentNode;
  const urlbarNext = urlbarContainer.nextSibling;

  // --- Urlbar width sync ---
  // Firefox (UrlbarInput.mjs) periodically sets --urlbar-width on #urlbar.
  // We override it to account for sidebar padding. Only active when the
  // urlbar is inside the sidebar (expanded layout).

  const gap =
    parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue("--pfx-gap")
    ) || 6;

  let urlbarToolbar = null;
  let resizeObs = null;
  let mutationObs = null;
  let updating = false;

  function syncUrlbarWidth() {
    if (!urlbar || updating) return;
    if (urlbar.hasAttribute("breakout-extend")) return;
    updating = true;
    const inset = parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue("--pfx-sidebar-inset")
    ) || 10;
    const w = Math.max(0, sidebarMain.getBoundingClientRect().width - inset * 2);
    urlbar.style.setProperty("--urlbar-width", w + "px");
    updating = false;
  }

  // --- Context menu fix ---
  // sidebar-main's LitElement intercepts contextmenu events. Only block
  // propagation when the toolbox is actually inside the sidebar.
  navigatorToolbox.addEventListener("contextmenu", (e) => {
    if (navigatorToolbox.parentNode === sidebarMain) {
      e.stopPropagation();
    }
  });

  // --- Layout: expand (move toolbox into sidebar) ---

  function expand() {
    sidebarMain.insertBefore(navigatorToolbox, sidebarMainElement);

    // The urlbar breakout requires this.closest("toolbar") to return a
    // <toolbar> (UrlbarInput.mjs:487). Wrap it in a new toolbar.
    urlbarToolbar = document.createXULElement("toolbar");
    urlbarToolbar.id = "pfx-urlbar-toolbar";
    urlbarToolbar.classList.add("browser-toolbar");
    urlbarToolbar.appendChild(urlbarContainer);
    navBar.after(urlbarToolbar);

    if (urlbar) {
      resizeObs = new ResizeObserver(syncUrlbarWidth);
      resizeObs.observe(sidebarMain);
      mutationObs = new MutationObserver(syncUrlbarWidth);
      mutationObs.observe(urlbar, {
        attributes: true,
        attributeFilter: ["style"],
      });
    }
  }

  // --- Layout: collapse (restore toolbox to native horizontal position) ---

  function collapse() {
    if (resizeObs) {
      resizeObs.disconnect();
      resizeObs = null;
    }
    if (mutationObs) {
      mutationObs.disconnect();
      mutationObs = null;
    }

    // Restore urlbar-container to its original position in #nav-bar
    if (urlbarNext && urlbarNext.parentNode === urlbarParent) {
      urlbarParent.insertBefore(urlbarContainer, urlbarNext);
    } else {
      urlbarParent.appendChild(urlbarContainer);
    }

    if (urlbarToolbar) {
      urlbarToolbar.remove();
      urlbarToolbar = null;
    }

    // Ensure correct order: urlbar-container → spring2 → unified-extensions-button
    const spring2 = document.getElementById("customizableui-special-spring2");
    const extBtn = document.getElementById("unified-extensions-button");
    if (spring2) urlbarContainer.after(spring2);
    if (spring2 && extBtn) spring2.after(extBtn);

    // Restore navigator-toolbox to its original position (before #browser)
    if (toolboxNext && toolboxNext.parentNode === toolboxParent) {
      toolboxParent.insertBefore(navigatorToolbox, toolboxNext);
    } else {
      toolboxParent.appendChild(navigatorToolbox);
    }
  }

  // --- Draggable sidebar overlay ---
  // -moz-window-dragging only works on light DOM XUL elements.
  // The empty tab area is inside a shadow root, so we overlay a
  // transparent light DOM box over it and keep its geometry in sync.
  // Pref: pfx.view.draggable-sidebar (default true, Zen-compatible)

  let dragOverlay = null;
  let dragResizeObs = null;
  let dragMutationObs = null;
  const arrowscrollbox = document.getElementById("tabbrowser-arrowscrollbox");

  function updateDragOverlay() {
    if (!dragOverlay || !arrowscrollbox) return;
    const containerRect = sidebarMain.getBoundingClientRect();
    const asbRect = arrowscrollbox.getBoundingClientRect();

    // Find the last visible tab to calculate where empty space starts
    const tabs = arrowscrollbox.querySelectorAll("tab.tabbrowser-tab");
    const lastTab = tabs.length ? tabs[tabs.length - 1] : null;

    let top;
    if (lastTab) {
      const tabRect = lastTab.getBoundingClientRect();
      top = tabRect.bottom;
    } else {
      top = asbRect.top;
    }

    const bottom = asbRect.bottom;
    const height = Math.max(0, bottom - top);

    dragOverlay.style.left = (asbRect.left - containerRect.left) + "px";
    dragOverlay.style.top = (top - containerRect.top) + "px";
    dragOverlay.style.width = asbRect.width + "px";
    dragOverlay.style.height = height + "px";
    dragOverlay.style.display = height > 0 ? "" : "none";
  }

  function draggableEnable() {
    if (dragOverlay) return;
    dragOverlay = document.createXULElement("box");
    dragOverlay.id = "pfx-drag-overlay";
    sidebarMain.appendChild(dragOverlay);
    if (arrowscrollbox) {
      dragResizeObs = new ResizeObserver(updateDragOverlay);
      dragResizeObs.observe(arrowscrollbox);
      dragMutationObs = new MutationObserver(updateDragOverlay);
      dragMutationObs.observe(arrowscrollbox, { childList: true });
    }
    updateDragOverlay();
  }

  function draggableDisable() {
    if (!dragOverlay) return;
    dragResizeObs?.disconnect();
    dragMutationObs?.disconnect();
    dragResizeObs = null;
    dragMutationObs = null;
    dragOverlay.remove();
    dragOverlay = null;
  }

  const DRAGGABLE_PREF = "pfx.view.draggable-sidebar";

  if (Services.prefs.getBoolPref(DRAGGABLE_PREF, true)) {
    draggableEnable();
  }

  const draggableObserver = {
    observe() {
      if (Services.prefs.getBoolPref(DRAGGABLE_PREF, true)) {
        draggableEnable();
      } else {
        draggableDisable();
      }
    },
  };
  Services.prefs.addObserver(DRAGGABLE_PREF, draggableObserver);

  // --- Sidebar width preference ---

  const WIDTH_PREF = "pfx.sidebar.width";
  const defaultWidth = Services.prefs.getIntPref(WIDTH_PREF, 300);

  // Apply saved width on startup
  if (sidebarMain.hasAttribute("sidebar-launcher-expanded")) {
    sidebarMain.style.width = defaultWidth + "px";
  }

  // Save width when the user resizes the sidebar
  new ResizeObserver(() => {
    if (!sidebarMain.hasAttribute("sidebar-launcher-expanded")) return;
    const w = Math.round(sidebarMain.getBoundingClientRect().width);
    if (w > 0) Services.prefs.setIntPref(WIDTH_PREF, w);
  }).observe(sidebarMain);

  // --- Initialize layout based on current sidebar state ---

  if (sidebarMain.hasAttribute("sidebar-launcher-expanded")) {
    expand();
  }

  // Watch for expand/collapse attribute changes
  new MutationObserver(() => {
    const expanded = sidebarMain.hasAttribute("sidebar-launcher-expanded");
    if (expanded && !urlbarToolbar) {
      expand();
    } else if (!expanded && urlbarToolbar) {
      collapse();
    }
  }).observe(sidebarMain, {
    attributes: true,
    attributeFilter: ["sidebar-launcher-expanded"],
  });

  // === Compact Mode ===
  //
  // Ported from Zen Browser's ZenCompactMode.mjs, adapted for non-fork.
  //
  // STATE MODEL (inverted from naive show/hide):
  //   data-pfx-compact present → sidebar hidden by CSS default
  //   pfx-has-hover present    → sidebar visible (overrides hidden)
  //   No pfx-has-hover         → sidebar hidden
  //
  // This eliminates race conditions: enabling compact mode just sets
  // data-pfx-compact. The sidebar is immediately hidden because
  // pfx-has-hover is absent. Nothing can "undo" a hide — showing
  // requires explicitly ADDING pfx-has-hover.
  //
  // FLOW:
  //   hover strip mouseenter → setHover(true) → sidebar slides in
  //   sidebar mouseover      → setHover(true) + cancel any pending hide
  //   sidebar mouseleave     → flash(300ms) → setHover(false) → slides out
  //
  // ZEN FEATURES WE SKIP (fork-specific, not applicable):
  //   - zen-user-show: manual sidebar pin (we don't have this UX)
  //   - zen-has-empty-tab: auto-show on new tab
  //   - zen-compact-animating: animation spam guard
  //   - floating urlbar handling (_hasHoveredUrlbar)
  //   - macOS window button bounds checks
  //   - supress-primary-adjustment: Zen layout engine flag
  //   - screen edge detection (_getCrossedEdge): we use hover strip instead
  //   - _isTabBeingDragged flag: we use querySelector in isGuarded() instead

  const COMPACT_PREF = "pfx.sidebar.compact";
  const HORIZONTAL_COMPACT_PREF = "pfx.toolbar.compact";
  const DEBUG_PREF   = "pfx.debug";

  // Match Zen's defaults exactly so the feel transfers. Zen pref names in
  // parens, our values match upstream so users coming from Zen don't have
  // to re-train their muscle memory.
  // - keepHoverDuration  (zen.view.compact.sidebar-keep-hover.duration)
  const KEEP_HOVER_DURATION = 150;
  // Wayland / X11 spurious-mouseleave debounce. Wraps the per-tick check
  // in setTimeout(_, hoverHackDelay()) so users on flaky compositors can
  // tune. Zen pref equivalent: zen.view.compact.hover-hack-delay (default 0).
  function hoverHackDelay() {
    return Services.prefs.getIntPref("pfx.compact.hoverHackDelay", 0);
  }

  // After an off-screen / strip trigger, schedule an auto-hide after
  // this long — cursor never has to enter the sidebar for the cycle to
  // complete. Cancelled by `clearFlash()` if cursor enters the sidebar.
  // Matches Zen's `zen.view.compact.toolbar-hide-after-hover.duration`
  // (default 1000ms) used in `flashElement(target, hideAfterHoverDuration)`.
  const OFFSCREEN_SHOW_DURATION = 1000;

  // Once a collapse is committed (pfx-has-hover removed), block reveal
  // attempts until the close animation finishes. Without this, a hover
  // event fired mid-collapse races with the slide-out and produces a
  // flicker / partial open. Matches the CSS --pfx-transition-duration
  // (250ms) plus a small margin. Same protective intent as Firefox's
  // _addHoverStateBlocker pattern in browser-sidebar.js (~line 1452).
  const COLLAPSE_PROTECTION_DURATION = 280;
  let _collapseProtectedUntil = 0;
  let _collapseProtectedHzUntil = 0;

  // Horizontal-compact state (parallel to vertical). Lives alongside the
  // existing sidebar compact infrastructure; only one mode is active at
  // a time (auto-swapped on `sidebar.verticalTabs` pref change).
  let hoverStripTop = null;
  let urlbarCompactObserverHz = null;
  let _hzFlashTimer = null;

  // Programmatic-flash duration for callers that want to draw attention
  // to the sidebar (matches Zen's
  // `zen.view.compact.toolbar-flash-popup.duration` default of 800ms).
  // Dispatch via `sidebarMain.dispatchEvent(new CustomEvent("pfx-flash"))`
  // — sidebar appears for FLASH_DURATION then auto-hides (cancelled
  // if cursor enters during the window).
  const FLASH_DURATION = 800;

  // Batched file logger. Uses IOUtils.write with { mode: "append" }
  // so we never rebuild the whole file — read-then-write was O(n²)
  // over the session and pegged CPU once the log grew past a few MB.
  let _logPath = null;
  const _logLines = [];
  let _logFlushPending = false;
  function _logFlush() {
    const batch = _logLines.splice(0);
    if (!batch.length) { _logFlushPending = false; return; }
    if (!_logPath) {
      _logPath = PathUtils.join(
        Services.dirsvc.get("ProfD", Ci.nsIFile).path,
        "palefox-debug.log",
      );
    }
    const blob = new TextEncoder().encode(batch.join("\n") + "\n");
    IOUtils.write(_logPath, blob, { mode: "appendOrCreate" })
      .then(() => {
        if (_logLines.length) _logFlush();
        else _logFlushPending = false;
      })
      .catch((e) => {
        console.error("[PFX:drawer] log write failed", e);
        _logFlushPending = false;
      });
  }

  function dbg(event, data = {}) {
    if (!Services.prefs.getBoolPref(DEBUG_PREF, false)) return;
    // Payload reads only cheap attributes / scalars. NEVER call isGuarded()
    // here — it calls reconcilePopups() which calls dbg(), which would
    // recurse infinitely. If a caller wants `guarded` in the log, pass it
    // explicitly in `data`.
    const payload = {
      compact:      sidebarMain.hasAttribute("data-pfx-compact"),
      hover:        sidebarMain.hasAttribute("pfx-has-hover"),
      openPopups:   _openPopups,
      flashPending: flashTimer !== null,
      ...data,
    };
    console.log("[PFX:drawer]", event, payload);
    _logLines.push(`${Date.now()} [drawer] ${event} ${JSON.stringify(payload)}`);
    if (!_logFlushPending) {
      _logFlushPending = true;
      Promise.resolve().then(_logFlush);
    }
  }

  let hoverStrip = null;
  let flashTimer = null;
  let urlbarCompactObserver = null;

  // Blocks hover-triggered show during and immediately after compactToggle().
  // Held until the sidebar's CSS transform transition completes (~250ms).
  // Zen equivalent: _ignoreNextHover (ZenCompactMode.mjs:623)
  let _ignoreNextHover = false;

  // Other scripts can dismiss the sidebar by dispatching "pfx-dismiss"
  sidebarMain.addEventListener("pfx-dismiss", () => {
    _ignoreNextHover = true;
    setHover(false);
    clearFlash();
    setTimeout(() => { _ignoreNextHover = false; }, KEEP_HOVER_DURATION + 100);
  });

  // Other scripts can flash the sidebar visible by dispatching "pfx-flash".
  // Useful for "draw the user's attention" actions (mic prompt, download
  // started, etc.). Sidebar appears for FLASH_DURATION then auto-hides.
  // Cancellable by cursor entry (clearFlash() in onSidebarEnter).
  sidebarMain.addEventListener("pfx-flash", () => {
    if (!sidebarMain.hasAttribute("data-pfx-compact")) return;
    flashSidebar(FLASH_DURATION);
  });

  // Guards: conditions that should prevent the sidebar from hiding.
  //
  // _openPopups is a write-only counter that gets fed by document-wide
  // popupshown/popuphidden events. The Mozilla XUL stack occasionally drops
  // a popuphidden (right-click → click outside before popup fully shown,
  // panels destroyed by GC, etc.) which leaves the counter elevated and
  // the sidebar guarded forever.
  //
  // The fix (per docs/compact-mode-dissertation.md F-A): treat the counter
  // as a hint, not the source of truth. Reconcile from the DOM whenever
  // we're about to use the value.
  let _openPopups = 0;
  function _isIgnoredPopup(e) {
    const el = e.composedPath?.()[0] ?? e.target;
    return el.localName === "tooltip" || el.id === "tab-preview-panel";
  }
  document.addEventListener("popupshown", (e) => {
    if (_isIgnoredPopup(e)) return;
    _openPopups++;
    dbg("popupshown", { id: e.target.id, tag: e.target.localName, _openPopups });
  });
  document.addEventListener("popuphidden", (e) => {
    if (_isIgnoredPopup(e)) return;
    _openPopups = Math.max(0, _openPopups - 1);
    dbg("popuphidden", { id: e.target.id, tag: e.target.localName, _openPopups });
  });

  // Counter-based popup detection. The popupshown/popuphidden events
  // fire reliably for ALL popup types (toolbar context menus, our own
  // menus, autocomplete, etc.), so the counter is the right primary
  // signal. The reconcile-from-DOM-attribute approach was too narrow
  // (didn't match toolbar context menu attributes) and broke every
  // toolbar button's right-click → "keep sidebar visible" behavior.
  //
  // Counter leaks (the P1 risk from the dissertation) are caught at
  // hide-time by reconcileCounterIfStale() rather than on every
  // isGuarded() call.
  function reconcileCounterIfStale() {
    if (_openPopups <= 0) return;
    // Cheap DOM check: any popup-like element actually rendered?
    const live = document.querySelector(
      "panel[panelopen='true'], panel[open='true'], " +
      "menupopup[state='open'], menupopup[state='showing'], " +
      "menupopup[open='true']"
    );
    if (!live) {
      // Counter is elevated but no popup is actually open — leaked.
      dbg("reconcileCounterIfStale:reset", { stale: _openPopups });
      _openPopups = 0;
    }
  }

  function isGuarded() {
    if (_openPopups > 0) return true;
    if (urlbar?.hasAttribute("breakout-extend")) return true;
    if (document.querySelector("toolbarbutton[open='true']")) return true;
    if (document.querySelector(".tabbrowser-tab[multiselected]")) return true;
    if (document.querySelector("[pfx-dragging]")) return true;
    return false;
  }

  // Reconcile the sidebar to a coherent state.
  //   trigger:  caller-supplied label for diagnostics
  //   force:    if true, hide regardless of current cursor position
  // After this returns, pfx-has-hover is set iff (cursor-on-sidebar OR
  // cursor-on-hoverstrip OR active-flash OR isGuarded()). _ignoreNextHover
  // is cleared. Pending watchdog is cancelled.
  // This is the single point through which any timer / safety / external
  // event funnels its "the state might be stale" conclusion.
  function reconcileCompactState(trigger) {
    if (!sidebarMain.hasAttribute("data-pfx-compact")) return;
    const before = {
      hover: sidebarMain.hasAttribute("pfx-has-hover"),
      flashPending: flashTimer !== null,
      _ignoreNextHover,
      _openPopups,
    };
    // Always clear the toggle-period guard — the safety timer shouldn't
    // outlive the transition window.
    _ignoreNextHover = false;
    // Leak check before evaluating guards.
    reconcileCounterIfStale();
    // If a guard is active OR the cursor is over the sidebar/strip, keep
    // it visible. Otherwise force-hide.
    const cursorOver = sidebarMain.matches(":hover")
      || hoverStrip?.matches(":hover");
    const guarded = isGuarded();
    if (guarded || cursorOver) {
      // Make sure pfx-has-hover is set so it stays visible.
      if (!sidebarMain.hasAttribute("pfx-has-hover")) {
        sidebarMain.setAttribute("pfx-has-hover", "true");
      }
      // And schedule a watchdog to re-check in 1s — handles "guard goes
      // away while we're not looking" (P4, P5, P6).
      scheduleHideWatchdog();
    } else if (flashTimer !== null) {
      // A flash auto-hide is already scheduled — let it run instead of
      // tearing the attribute down underneath it.
      dbg("reconcileCompactState:flashPending");
    } else {
      // Route through setHover(false) so the collapse-protection window
      // stamps consistently, regardless of which path requested the hide.
      setHover(false);
      cancelHideWatchdog();
    }
    dbg("reconcileCompactState", {
      trigger,
      before,
      cursorOver, guarded,
      after: {
        hover: sidebarMain.hasAttribute("pfx-has-hover"),
        flashPending: flashTimer !== null,
        _ignoreNextHover,
      },
    });
  }

  // Watchdog: if the sidebar is shown but a guard is what's keeping it
  // open, re-evaluate after 1s (catches external state desync — urlbar
  // breakout-extend that never cleared, [pfx-dragging] left dangling
  // because dragend dropped, etc.).
  let hideWatchdogTimer = null;
  function scheduleHideWatchdog() {
    if (hideWatchdogTimer) return;
    hideWatchdogTimer = setTimeout(() => {
      hideWatchdogTimer = null;
      reconcileCompactState("hide-watchdog-1s");
    }, 1000);
  }
  function cancelHideWatchdog() {
    if (hideWatchdogTimer) {
      clearTimeout(hideWatchdogTimer);
      hideWatchdogTimer = null;
    }
  }

  // Set/remove the visibility attribute. CSS reacts to this:
  //   [data-pfx-compact]:not([pfx-has-hover]) → hidden
  //   [data-pfx-compact][pfx-has-hover]       → visible
  // Zen equivalent: _setElementExpandAttribute (ZenCompactMode.mjs:693)
  // Zen's version is generic (any element, any attribute, handles
  // implicit hover, toolbar panel state). Ours is trivial because
  // we have one sidebar and one attribute.
  function setHover(value) {
    dbg("setHover", {
      value,
      collapseProtectedRemaining: Math.max(0, _collapseProtectedUntil - Date.now()),
    });
    if (value && _ignoreNextHover) {
      // Zen pattern (animateCompactMode:455): actively force-hide when
      // _ignoreNextHover is set, rather than just early-returning from callers.
      // Defensive catch for any show path that bypasses per-caller guards.
      sidebarMain.removeAttribute("pfx-has-hover");
      return;
    }
    if (value) {
      // Reveal — DROP if a collapse animation is still in flight. Once
      // collapse executes, it runs to completion uninterrupted; reveal
      // events that fire mid-collapse are discarded. The user can hover
      // again after the protection window expires if they still want
      // the sidebar shown. This is per the project rule documented in
      // docs/compact-mode-dissertation.md.
      const collapseRemaining = _collapseProtectedUntil - Date.now();
      if (collapseRemaining > 0) {
        dbg("setHover:revealDropped", { collapseRemaining });
        return;
      }
      sidebarMain.setAttribute("pfx-has-hover", "true");
      return;
    }
    // Collapse — only stamp the protection window if the attribute was
    // actually present (i.e., we're committing to an animated close).
    // No-op cases (already hidden) shouldn't lock out reveals.
    if (sidebarMain.hasAttribute("pfx-has-hover")) {
      sidebarMain.removeAttribute("pfx-has-hover");
      _collapseProtectedUntil = Date.now() + COLLAPSE_PROTECTION_DURATION;
    }
  }

  // Keep sidebar visible for `duration` ms, then hide.
  // If called again while already flashing, resets the timer without
  // re-triggering the show (avoids visual glitch from redundant show).
  // Zen equivalent: flashElement (ZenCompactMode.mjs:672)
  // Zen's version is generic (any element, any attribute, keyed by ID).
  // Ours is hardcoded to the sidebar since it's our only flashable element.
  function flashSidebar(duration) {
    if (flashTimer) {
      clearTimeout(flashTimer);
      dbg("flashSidebar:extend", { duration });
    } else {
      dbg("flashSidebar:show", { duration });
      requestAnimationFrame(() => setHover(true));
    }
    flashTimer = setTimeout(() => {
      requestAnimationFrame(() => {
        // Leak check: if counter says popups exist but DOM shows none,
        // reset the counter so the hide can proceed.
        reconcileCounterIfStale();
        if (isGuarded()) {
          dbg("flashSidebar:hide-blocked");
          // F-D: schedule a watchdog so the guard's eventual clearing
          // still triggers a hide. Without this the sidebar can stay
          // visible indefinitely if (e.g.) a popuphidden event was
          // dropped or a [pfx-dragging] attribute outlived its dragend.
          scheduleHideWatchdog();
        } else {
          setHover(false);
        }
        flashTimer = null;
      });
    }, duration);
  }

  function clearFlash() {
    clearTimeout(flashTimer);
    flashTimer = null;
  }

  // Mouse enters sidebar. Verify hover is real, then show.
  // Zen equivalent: onEnter (ZenCompactMode.mjs:762)
  //
  // setTimeout(0): Zen calls this HOVER_HACK_DELAY (default 0ms).
  // Defers to next tick so we can verify :hover — on Linux/Wayland,
  // spurious mouseover events fire during tab drags (Mozilla bug 1818517).
  // The :hover check catches these false positives.
  //
  // event.target.closest("panel"): Zen check — ignore mouseover from
  // popup panels (context menus, dropdowns) that overlap the sidebar.
  //
  // requestAnimationFrame: Zen batches all DOM writes to rAF to avoid
  // layout thrashing. We follow the same pattern.
  function onSidebarEnter(event) {
    const targetId = event.target?.id || event.target?.localName;
    dbg("onSidebarEnter:entry", { targetId, _ignoreNextHover, flashPending: flashTimer !== null });
    setTimeout(() => {
      if (!event.target.matches(":hover")) {
        dbg("onSidebarEnter:abort", { reason: "not-hovered-after-tick", targetId });
        return;
      }
      if (event.target.closest("panel")) {
        dbg("onSidebarEnter:abort", { reason: "from-panel", targetId });
        return;
      }
      clearFlash();
      requestAnimationFrame(() => {
        if (_ignoreNextHover) {
          dbg("onSidebarEnter:abort", { reason: "ignore-next-hover-rAF", targetId });
          return;
        }
        if (sidebarMain.hasAttribute("pfx-has-hover")) {
          dbg("onSidebarEnter:abort", { reason: "already-has-hover", targetId });
          return;
        }
        dbg("onSidebarEnter:show", { targetId });
        setHover(true);
      });
    }, hoverHackDelay());
  }

  // Mouse leaves sidebar. Verify leave is real, then schedule hide.
  // Zen equivalent: onLeave (ZenCompactMode.mjs:788)
  //
  // setTimeout(0) + :hover check: same false-positive guard as onEnter.
  //
  // flashSidebar instead of immediate hide: the sidebar lingers for
  // KEEP_HOVER_DURATION ms. If the mouse re-enters during this window,
  // onSidebarEnter calls clearFlash() and the hide is cancelled.
  // This prevents flicker when the mouse briefly crosses the edge.
  //
  // Zen skips: macOS window button bounds check, floating urlbar check,
  // supress-primary-adjustment, dragleave handling. All fork-specific.
  function onSidebarLeave(event) {
    const targetId = event.target?.id || event.target?.localName;
    // Differentiate by where the cursor went. relatedTarget === null means
    // the cursor exited the window entirely (off-screen) — give a longer
    // grace window so the user has time to come back. Non-null means they
    // moved to another element inside Firefox (content area) — short
    // linger only.
    const exitedWindow = !event.relatedTarget;
    const lingerMs = exitedWindow ? OFFSCREEN_SHOW_DURATION : KEEP_HOVER_DURATION;
    dbg("onSidebarLeave:entry", { targetId, _ignoreNextHover, exitedWindow, lingerMs });
    setTimeout(() => {
      if (event.target.matches(":hover")) {
        dbg("onSidebarLeave:abort", { reason: "still-hovered-after-tick", targetId });
        return;
      }
      if (_ignoreNextHover) {
        dbg("onSidebarLeave:abort", { reason: "ignore-next-hover", targetId });
        return;
      }
      if (isGuarded()) {
        dbg("onSidebarLeave:abort", { reason: "guarded", targetId });
        return;
      }
      dbg("onSidebarLeave:flash", { targetId, duration: lingerMs });
      flashSidebar(lingerMs);
    }, hoverHackDelay());
  }

  function compactEnable() {
    dbg("compactEnable");
    // Setting this attribute without pfx-has-hover causes CSS to
    // immediately hide the sidebar. No race condition possible.
    sidebarMain.setAttribute("data-pfx-compact", "");

    // The urlbar has popover="manual" which places it in the CSS top layer.
    // Top layer elements are immune to ancestor transforms. Remove popover
    // so the urlbar moves with the sidebar's transform. We restore it
    // dynamically during breakout so the dropdown renders above everything.
    if (urlbar && !urlbarCompactObserver) {
      urlbar.removeAttribute("popover");
      urlbarCompactObserver = new MutationObserver(() => {
        if (!sidebarMain.hasAttribute("data-pfx-compact")) return;
        if (urlbar.hasAttribute("breakout-extend")) {
          dbg("urlbar:breakout-open");
          urlbar.setAttribute("popover", "manual");
          if (!urlbar.matches(":popover-open")) urlbar.showPopover();
        } else {
          dbg("urlbar:breakout-close");
          urlbar.removeAttribute("popover");
          // Breakout closed — if mouse isn't over the sidebar, hide it.
          // Fixes: click urlbar → click away → sidebar stays stuck visible
          // (the earlier mouseleave was blocked by the breakout guard).
          if (!sidebarMain.matches(":hover")) {
            flashSidebar(KEEP_HOVER_DURATION);
          }
        }
      });
      urlbarCompactObserver.observe(urlbar, { attributes: true, attributeFilter: ["breakout-extend"] });
    }

    // Hover strip: invisible box at left edge, sits behind the sidebar
    // (z-index 9 < sidebar's 10). When sidebar has pointer-events:none
    // (hidden state), mouse events pass through to the strip.
    // Zen uses screen edge detection instead (mouseleave on documentElement,
    // _getCrossedEdge). Our approach is simpler — a physical DOM element.
    //
    // F-E: ensure the strip is in the DOM whenever compact is on. If a prior
    // call orphaned the strip (parent re-attached, exception during enable),
    // re-attach it so hover-trigger still works.
    if (!hoverStrip || !hoverStrip.isConnected) {
      hoverStrip = document.createXULElement("box");
      hoverStrip.id = "pfx-hover-strip";
      sidebarMain.parentNode.appendChild(hoverStrip);
      hoverStrip.addEventListener("mouseenter", () => {
        dbg("hoverStrip:mouseenter", {
          _ignoreNextHover, flashPending: flashTimer !== null,
          hasHover: sidebarMain.hasAttribute("pfx-has-hover"),
        });
        if (_ignoreNextHover) {
          dbg("hoverStrip:abort", { reason: "ignore-next-hover-sync" });
          return;
        }
        // Edge trigger: show + auto-hide after OFFSCREEN_SHOW_DURATION.
        // If the cursor enters the sidebar during that window,
        // onSidebarEnter calls clearFlash() to cancel the auto-hide.
        // If the cursor never enters (off-screen, fast flick), the
        // auto-hide closes the sidebar after the duration.
        flashSidebar(OFFSCREEN_SHOW_DURATION);
      });
    }

    sidebarMain.addEventListener("mouseover", onSidebarEnter);
    sidebarMain.addEventListener("mouseleave", onSidebarLeave);

    // Backup activation: if the cursor flicks fast enough to skip the
    // hover strip's bounds, mouseenter never fires. documentElement
    // mouseleave catches the cursor exiting the window — if it exited
    // close to the LEFT edge (where the sidebar lives), trigger the
    // same flashSidebar(OFFSCREEN_SHOW_DURATION) the strip would.
    document.documentElement.addEventListener("mouseleave", onDocMouseLeave);
  }

  function onDocMouseLeave(e) {
    if (!sidebarMain.hasAttribute("data-pfx-compact")) return;
    if (sidebarMain.hasAttribute("pfx-has-hover")) return; // already shown
    if (_ignoreNextHover) return;
    // Only trigger when cursor exited near the left edge (within the
    // hover-strip width × ~3 to give a margin). Avoids false-positives
    // from cursor exiting top / right / bottom.
    const triggerWidth = parseInt(
      getComputedStyle(document.documentElement)
        .getPropertyValue("--pfx-compact-trigger-width") || "8",
      10,
    );
    if (e.clientX > triggerWidth * 3) return;
    dbg("onDocMouseLeave:show", { clientX: e.clientX });
    flashSidebar(OFFSCREEN_SHOW_DURATION);
  }

  function compactDisable() {
    dbg("compactDisable");
    clearFlash();
    cancelHideWatchdog();
    sidebarMain.removeAttribute("data-pfx-compact");
    sidebarMain.removeAttribute("pfx-has-hover");

    // Disconnect the urlbar breakout observer — must happen before
    // restoring popover so it doesn't fire on the attribute change below.
    urlbarCompactObserver?.disconnect();
    urlbarCompactObserver = null;

    // Restore popover so the urlbar returns to the top layer
    if (urlbar) {
      urlbar.setAttribute("popover", "manual");
      if (!urlbar.matches(":popover-open")) urlbar.showPopover();
    }

    if (hoverStrip) {
      hoverStrip.remove();
      hoverStrip = null;
    }

    sidebarMain.removeEventListener("mouseover", onSidebarEnter);
    sidebarMain.removeEventListener("mouseleave", onSidebarLeave);
    document.documentElement.removeEventListener("mouseleave", onDocMouseLeave);
  }

  // === Horizontal compact ===
  // Parallel implementation: navigator-toolbox autohides upward, top hover
  // strip reveals it. Shares helpers (_ignoreNextHover, isGuarded, popup
  // counter); has its own flash timer / hover strip / collapse-protection.

  function setToolboxHover(value) {
    dbg("setToolboxHover", { value });
    if (value && _ignoreNextHover) {
      navigatorToolbox.removeAttribute("pfx-has-hover");
      return;
    }
    if (value) {
      if (Date.now() < _collapseProtectedHzUntil) {
        dbg("setToolboxHover:revealDropped");
        return;
      }
      navigatorToolbox.setAttribute("pfx-has-hover", "true");
      return;
    }
    if (navigatorToolbox.hasAttribute("pfx-has-hover")) {
      navigatorToolbox.removeAttribute("pfx-has-hover");
      _collapseProtectedHzUntil = Date.now() + COLLAPSE_PROTECTION_DURATION;
    }
  }

  function flashToolbox(duration) {
    if (_hzFlashTimer) {
      clearTimeout(_hzFlashTimer);
      dbg("flashToolbox:extend", { duration });
    } else {
      dbg("flashToolbox:show", { duration });
      requestAnimationFrame(() => setToolboxHover(true));
    }
    _hzFlashTimer = setTimeout(() => {
      requestAnimationFrame(() => {
        reconcileCounterIfStale();
        if (isGuarded()) {
          dbg("flashToolbox:hide-blocked");
          scheduleHideWatchdogHz();
        } else {
          setToolboxHover(false);
        }
        _hzFlashTimer = null;
      });
    }, duration);
  }

  function clearFlashToolbox() {
    if (_hzFlashTimer) clearTimeout(_hzFlashTimer);
    _hzFlashTimer = null;
  }

  // Horizontal-mode counterpart to reconcileCompactState. Same shape, but
  // operates on navigatorToolbox + hoverStripTop and uses the horizontal
  // collapse-protection / flash / watchdog state.
  function reconcileCompactStateHorizontal(trigger) {
    if (!document.documentElement.hasAttribute("data-pfx-compact-horizontal")) return;
    const before = {
      hover: navigatorToolbox.hasAttribute("pfx-has-hover"),
      flashPending: _hzFlashTimer !== null,
      _ignoreNextHover,
      _openPopups,
    };
    _ignoreNextHover = false;
    reconcileCounterIfStale();
    const cursorOver = navigatorToolbox.matches(":hover")
      || hoverStripTop?.matches(":hover");
    const guarded = isGuarded();
    if (guarded || cursorOver) {
      if (!navigatorToolbox.hasAttribute("pfx-has-hover")) {
        navigatorToolbox.setAttribute("pfx-has-hover", "true");
      }
      scheduleHideWatchdogHz();
    } else if (_hzFlashTimer !== null) {
      dbg("reconcileCompactStateHorizontal:flashPending");
    } else {
      setToolboxHover(false);
      cancelHideWatchdogHz();
    }
    dbg("reconcileCompactStateHorizontal", {
      trigger, before, cursorOver, guarded,
      after: {
        hover: navigatorToolbox.hasAttribute("pfx-has-hover"),
        flashPending: _hzFlashTimer !== null,
        _ignoreNextHover,
      },
    });
  }

  let hideWatchdogTimerHz = null;
  function scheduleHideWatchdogHz() {
    if (hideWatchdogTimerHz) return;
    hideWatchdogTimerHz = setTimeout(() => {
      hideWatchdogTimerHz = null;
      reconcileCompactStateHorizontal("hide-watchdog-1s-hz");
    }, 1000);
  }
  function cancelHideWatchdogHz() {
    if (hideWatchdogTimerHz) {
      clearTimeout(hideWatchdogTimerHz);
      hideWatchdogTimerHz = null;
    }
  }

  function onToolboxEnter(event) {
    setTimeout(() => {
      if (!event.target.matches(":hover")) return;
      if (event.target.closest("panel")) return;
      clearFlashToolbox();
      requestAnimationFrame(() => {
        if (_ignoreNextHover) return;
        if (navigatorToolbox.hasAttribute("pfx-has-hover")) return;
        setToolboxHover(true);
      });
    }, hoverHackDelay());
  }

  function onToolboxLeave(event) {
    const exitedWindow = !event.relatedTarget;
    const lingerMs = exitedWindow ? OFFSCREEN_SHOW_DURATION : KEEP_HOVER_DURATION;
    setTimeout(() => {
      if (event.target.matches(":hover")) return;
      if (_ignoreNextHover) return;
      if (isGuarded()) return;
      flashToolbox(lingerMs);
    }, hoverHackDelay());
  }

  function onDocMouseLeaveTop(e) {
    if (!document.documentElement.hasAttribute("data-pfx-compact-horizontal")) return;
    if (navigatorToolbox.hasAttribute("pfx-has-hover")) return;
    if (_ignoreNextHover) return;
    const triggerHeight = parseInt(
      getComputedStyle(document.documentElement)
        .getPropertyValue("--pfx-compact-trigger-width") || "8",
      10,
    );
    if (e.clientY > triggerHeight * 3) return;
    dbg("onDocMouseLeaveTop:show", { clientY: e.clientY });
    flashToolbox(OFFSCREEN_SHOW_DURATION);
  }

  function compactEnableHorizontal() {
    if (document.documentElement.hasAttribute("data-pfx-compact-horizontal")) return;
    dbg("compactEnableHorizontal");
    document.documentElement.setAttribute("data-pfx-compact-horizontal", "");

    if (urlbar && !urlbarCompactObserverHz) {
      urlbar.removeAttribute("popover");
      urlbarCompactObserverHz = new MutationObserver(() => {
        if (!document.documentElement.hasAttribute("data-pfx-compact-horizontal")) return;
        if (urlbar.hasAttribute("breakout-extend")) {
          urlbar.setAttribute("popover", "manual");
          if (!urlbar.matches(":popover-open")) urlbar.showPopover();
        } else {
          urlbar.removeAttribute("popover");
        }
      });
      urlbarCompactObserverHz.observe(urlbar, { attributes: true, attributeFilter: ["breakout-extend"] });
    }

    if (!hoverStripTop || !hoverStripTop.isConnected) {
      hoverStripTop = document.createXULElement("box");
      hoverStripTop.id = "pfx-hover-strip-top";
      document.documentElement.appendChild(hoverStripTop);
      hoverStripTop.addEventListener("mouseenter", () => {
        if (_ignoreNextHover) return;
        flashToolbox(OFFSCREEN_SHOW_DURATION);
      });
    }

    navigatorToolbox.addEventListener("mouseover", onToolboxEnter);
    navigatorToolbox.addEventListener("mouseleave", onToolboxLeave);
    document.documentElement.addEventListener("mouseleave", onDocMouseLeaveTop);
  }

  function compactDisableHorizontal() {
    if (!document.documentElement.hasAttribute("data-pfx-compact-horizontal")) return;
    dbg("compactDisableHorizontal");
    clearFlashToolbox();
    cancelHideWatchdogHz();
    document.documentElement.removeAttribute("data-pfx-compact-horizontal");
    navigatorToolbox.removeAttribute("pfx-has-hover");

    urlbarCompactObserverHz?.disconnect();
    urlbarCompactObserverHz = null;
    if (urlbar) {
      urlbar.setAttribute("popover", "manual");
      if (!urlbar.matches(":popover-open")) urlbar.showPopover();
    }

    if (hoverStripTop) {
      hoverStripTop.remove();
      hoverStripTop = null;
    }

    navigatorToolbox.removeEventListener("mouseover", onToolboxEnter);
    navigatorToolbox.removeEventListener("mouseleave", onToolboxLeave);
    document.documentElement.removeEventListener("mouseleave", onDocMouseLeaveTop);
  }

  function compactToggle() {
    const vertical = Services.prefs.getBoolPref("sidebar.verticalTabs", true);
    if (vertical) {
      const active = sidebarMain.hasAttribute("data-pfx-compact");
      dbg("compactToggle:vertical", { wasActive: active });
      if (active) {
        compactDisable();
        Services.prefs.setBoolPref(COMPACT_PREF, false);
      } else {
        _ignoreNextHover = true;
        compactEnable();
        Services.prefs.setBoolPref(COMPACT_PREF, true);
        // F-B: safety timer + transitionend both funnel through
        // reconcileCompactState(). See dissertation.
        const safetyTimer = setTimeout(
          () => reconcileCompactState("safety-timer-400ms"),
          400,
        );
        sidebarMain.addEventListener("transitionend", function onTransitionEnd(e) {
          if (e.target !== sidebarMain || e.propertyName !== "transform") return;
          sidebarMain.removeEventListener("transitionend", onTransitionEnd);
          clearTimeout(safetyTimer);
          reconcileCompactState("transitionend-transform");
        });
      }
    } else {
      const active = document.documentElement.hasAttribute("data-pfx-compact-horizontal");
      dbg("compactToggle:horizontal", { wasActive: active });
      if (active) {
        compactDisableHorizontal();
        Services.prefs.setBoolPref(HORIZONTAL_COMPACT_PREF, false);
      } else {
        _ignoreNextHover = true;
        compactEnableHorizontal();
        Services.prefs.setBoolPref(HORIZONTAL_COMPACT_PREF, true);
        const safetyTimer = setTimeout(
          () => reconcileCompactStateHorizontal("safety-timer-400ms-hz"),
          400,
        );
        navigatorToolbox.addEventListener("transitionend", function onTransitionEnd(e) {
          if (e.target !== navigatorToolbox || e.propertyName !== "transform") return;
          navigatorToolbox.removeEventListener("transitionend", onTransitionEnd);
          clearTimeout(safetyTimer);
          reconcileCompactStateHorizontal("transitionend-transform-hz");
        });
      }
    }
  }

  // Initialize from pref on startup. Only the pref matching the current
  // tab-layout mode is honored — the other mode's pref is remembered for
  // when the user switches.
  function applyCompactForCurrentMode() {
    const vertical = Services.prefs.getBoolPref("sidebar.verticalTabs", true);
    if (vertical) {
      if (Services.prefs.getBoolPref(COMPACT_PREF, false)
          && !sidebarMain.hasAttribute("data-pfx-compact")) {
        compactEnable();
      }
    } else {
      if (Services.prefs.getBoolPref(HORIZONTAL_COMPACT_PREF, false)
          && !document.documentElement.hasAttribute("data-pfx-compact-horizontal")) {
        compactEnableHorizontal();
      }
    }
  }
  applyCompactForCurrentMode();

  // Live-toggle via about:config without restart. Each pref only takes
  // effect if its mode is currently active; otherwise it's saved for
  // later (when the user switches modes).
  const compactObserver = {
    observe() {
      const vertical = Services.prefs.getBoolPref("sidebar.verticalTabs", true);
      if (!vertical) return; // pref change applies on next mode-swap
      const enabled = Services.prefs.getBoolPref(COMPACT_PREF, false);
      const active = sidebarMain.hasAttribute("data-pfx-compact");
      if (enabled && !active) compactEnable();
      else if (!enabled && active) compactDisable();
    },
  };
  Services.prefs.addObserver(COMPACT_PREF, compactObserver);

  const compactObserverHz = {
    observe() {
      const vertical = Services.prefs.getBoolPref("sidebar.verticalTabs", true);
      if (vertical) return;
      const enabled = Services.prefs.getBoolPref(HORIZONTAL_COMPACT_PREF, false);
      const active = document.documentElement.hasAttribute("data-pfx-compact-horizontal");
      if (enabled && !active) compactEnableHorizontal();
      else if (!enabled && active) compactDisableHorizontal();
    },
  };
  Services.prefs.addObserver(HORIZONTAL_COMPACT_PREF, compactObserverHz);

  // Auto-swap when the user flips between vertical and horizontal tabs.
  // Tear down the mode that's leaving, apply the pref for the mode that's
  // arriving. Avoids dangling state (e.g. data-pfx-compact-horizontal still
  // on root after swap to vertical mode).
  const verticalTabsObserver = {
    observe() {
      const vertical = Services.prefs.getBoolPref("sidebar.verticalTabs", true);
      dbg("verticalTabs:change", { vertical });
      if (vertical) {
        compactDisableHorizontal();
      } else {
        compactDisable();
      }
      applyCompactForCurrentMode();
    },
  };
  Services.prefs.addObserver("sidebar.verticalTabs", verticalTabsObserver);

  // Remove pref observers when this window closes so they don't fire
  // against dead DOM nodes after the window is gone.
  window.addEventListener("unload", () => {
    Services.prefs.removeObserver(DRAGGABLE_PREF, draggableObserver);
    Services.prefs.removeObserver(COMPACT_PREF, compactObserver);
    Services.prefs.removeObserver(HORIZONTAL_COMPACT_PREF, compactObserverHz);
    Services.prefs.removeObserver("sidebar.verticalTabs", verticalTabsObserver);
    cancelHideWatchdog();
    cancelHideWatchdogHz();
    clearFlash();
    clearFlashToolbox();
  }, { once: true });

  // F-F: sizemodechange (minimize/maximize/restore) reconciles
  // unconditionally. The previous logic only cleared if not :hover'd, but
  // hover state itself can be stale across mode changes.
  window.addEventListener("sizemodechange", () => {
    reconcileCompactState("sizemodechange");
  });

  // F-C: window blur. The user can move focus to another window without
  // crossing the sidebar edge (Alt-Tab, click another window) — no
  // mouseleave fires on the sidebar so it stays open. Reconcile on blur
  // to catch that.
  //
  // The `blur` event bubbles up from any element that loses focus
  // (inputs, popups, etc). Only react when the window itself is the
  // target — otherwise we'd reconcile dozens of times per second of
  // user activity, repeatedly clearing pfx-has-hover and pegging CPU.
  window.addEventListener("blur", (e) => {
    if (e.target !== window) return;
    reconcileCompactState("window-blur");
  });

  // === Sidebar Button ===
  // Hide the native button, create our own. Avoids fighting XUL command
  // wiring. Left-click: toggle compact mode (dispatches per layout).
  // Right-click: our own custom #pfx-sidebar-button-menu (wired below).

  const sidebarButton = document.getElementById("sidebar-button");
  if (sidebarButton) {
    // Grab the icon style before hiding
    const ogIcon = sidebarButton.querySelector(".toolbarbutton-icon");
    const ogIconStyle = ogIcon ? getComputedStyle(ogIcon).listStyleImage : null;

    sidebarButton.style.display = "none";

    const pfxButton = document.createXULElement("toolbarbutton");
    pfxButton.id = "pfx-sidebar-button";
    pfxButton.className = sidebarButton.className;
    pfxButton.setAttribute(
      "tooltiptext",
      "Toggle compact mode (right-click for more)"
    );
    // Copy CUI attributes so Firefox's popupshowing logic recognizes
    // our button as a real toolbar widget
    for (const attr of [
      "cui-areatype",
      "widget-id",
      "widget-type",
      "removable",
      "overflows",
    ]) {
      if (sidebarButton.hasAttribute(attr)) {
        pfxButton.setAttribute(attr, sidebarButton.getAttribute(attr));
      }
    }
    if (ogIconStyle) {
      pfxButton.style.listStyleImage = ogIconStyle;
    }
    sidebarButton.after(pfxButton);

    pfxButton.addEventListener("click", (e) => {
      if (e.button !== 0) return;
      compactToggle();
    });

    // Custom context menu — owned by us, not overloaded onto Firefox's
    // toolbar-context-menu. The previous overloading approach fought
    // Firefox's UA popupshowing handler over which items were visible,
    // which caused the menu to morph between paints (clicks landed on
    // the wrong items). We own this menupopup completely.
    const pfxMenu = document.createXULElement("menupopup");
    pfxMenu.id = "pfx-sidebar-button-menu";

    function mi(id, label, onCommand) {
      const item = document.createXULElement("menuitem");
      item.id = id;
      item.setAttribute("label", label);
      item.addEventListener("command", onCommand);
      return item;
    }

    const compactItem = mi("pfx-toggle-compact", "Enable Compact",
      () => compactToggle());

    // Vertical mode only — toggles sidebar-launcher-expanded by clicking
    // the (display:none'd) native button while it's briefly un-hidden.
    const collapseItem = mi("pfx-collapse-layout", "Collapse Layout", () => {
      dbg("collapseItem:command");
      try {
        const prevDisplay = sidebarButton.style.display;
        sidebarButton.style.display = "";
        sidebarButton.click();
        sidebarButton.style.display = prevDisplay;
      } catch (e) {
        console.error("[PFX:drawer] collapse layout failed", e);
      }
    });

    // Both modes — toggles the bookmarks/history sidebar widget.
    const sidebarItem = mi("pfx-toggle-sidebar", "Enable Sidebar", () => {
      dbg("sidebarItem:command");
      try {
        const win = window;
        if (win.SidebarController?.toggle) { win.SidebarController.toggle(); return; }
        if (win.SidebarUI?.toggle) { win.SidebarUI.toggle(); return; }
        const cmd = document.getElementById("cmd_toggleSidebar");
        if (cmd?.doCommand) { cmd.doCommand(); return; }
        console.error("[PFX:drawer] no sidebar-toggle API available");
      } catch (e) { console.error("[PFX:drawer] sidebar toggle failed", e); }
    });

    const layoutItem = mi("pfx-toggle-tab-layout", "Horizontal Tabs", () => {
      const vertical = Services.prefs.getBoolPref("sidebar.verticalTabs", true);
      Services.prefs.setBoolPref("sidebar.verticalTabs", !vertical);
    });

    // Customize Sidebar passthrough — invokes Firefox's command directly
    // so users still have access to the upstream UI.
    const customizeItem = mi("pfx-customize-sidebar", "Customize Sidebar", () => {
      try {
        const native = document.getElementById("toolbar-context-customize-sidebar");
        native?.doCommand?.() ?? native?.click?.();
      } catch (e) { console.error("palefox: customize sidebar failed", e); }
    });

    pfxMenu.append(
      compactItem,
      collapseItem,
      sidebarItem,
      layoutItem,
      document.createXULElement("menuseparator"),
      customizeItem,
    );

    // Append to mainPopupSet so it's at the document root (rendered in
    // the top layer like all chrome popups).
    const popupSet = document.getElementById("mainPopupSet");
    popupSet?.appendChild(pfxMenu);

    // Wire the button to our menu. Firefox's context-menu plumbing reads
    // the `context` attribute and opens the named popup on right-click.
    pfxButton.setAttribute("context", "pfx-sidebar-button-menu");

    // Update labels / hidden state on every open. With our own menu there's
    // no fight with Firefox's UA handler — popupshowing fires, we update,
    // menu paints with the right labels, click hits the right item.
    pfxMenu.addEventListener("popupshowing", () => {
      const vertical = Services.prefs.getBoolPref("sidebar.verticalTabs", true);
      const isCompactVertical = sidebarMain.hasAttribute("data-pfx-compact");
      const isCompactHorizontal = document.documentElement.hasAttribute("data-pfx-compact-horizontal");
      const isCompact = vertical ? isCompactVertical : isCompactHorizontal;
      compactItem.setAttribute("label",
        isCompact ? "Disable Compact" : "Enable Compact");

      collapseItem.hidden = !vertical;
      if (vertical) {
        const expanded = sidebarMain.hasAttribute("sidebar-launcher-expanded");
        collapseItem.setAttribute("label",
          expanded ? "Collapse Layout" : "Expand Layout");
      }

      const sidebarOpen = window.SidebarController?.isOpen
        ?? (!sidebarMain.hidden
            && sidebarMain.getBoundingClientRect().width > 0);
      sidebarItem.setAttribute("label",
        sidebarOpen ? "Disable Sidebar" : "Enable Sidebar");

      layoutItem.setAttribute("label",
        vertical ? "Horizontal Tabs" : "Vertical Tabs");

      // Pin the active surface visible while our menu is open. The
      // _openPopups counter does this implicitly, but mouseleave +
      // flashSidebar's callback can race with popupshown — the
      // explicit attribute set + clearFlash makes "menu open ⇒ visible"
      // a deterministic invariant.
      if (isCompactVertical) {
        sidebarMain.setAttribute("pfx-has-hover", "true");
        clearFlash();
      }
      if (isCompactHorizontal) {
        navigatorToolbox.setAttribute("pfx-has-hover", "true");
        clearFlashToolbox();
      }

      dbg("pfxMenu:popupshowing", { vertical, isCompactVertical, isCompactHorizontal, sidebarOpen });
    });

    pfxMenu.addEventListener("popuphidden", () => {
      // After our menu closes, reconcile the active surface so it can
      // hide if the cursor isn't on it and no other guard is active.
      reconcileCompactState("pfxMenu:popuphidden");
      reconcileCompactStateHorizontal("pfxMenu:popuphidden");
    });
  }

  // === HTTP Not-Secure Warning ===
  // Shows a banner after 2s on insecure pages. Hides immediately
  // when the page becomes secure (e.g. redirect to HTTPS).

  const identityBox = document.getElementById("identity-box");
  let insecureTimer = null;
  let insecureBanner = null;

  function showInsecureBanner() {
    if (insecureBanner) return;
    insecureBanner = document.createXULElement("hbox");
    insecureBanner.id = "pfx-insecure-banner";
    insecureBanner.setAttribute("align", "center");
    insecureBanner.setAttribute("pack", "center");
    insecureBanner.textContent = "\uD83E\uDD8A Palefox - HTTP Alert: Not Secure";
    const browser = document.getElementById("browser");
    browser.parentNode.insertBefore(insecureBanner, browser);
  }

  function hideInsecureBanner() {
    clearTimeout(insecureTimer);
    insecureTimer = null;
    if (insecureBanner) {
      insecureBanner.remove();
      insecureBanner = null;
    }
  }

  function checkInsecure() {
    const uri = gBrowser.selectedBrowser?.currentURI?.spec || "";
    const isInternal = uri.startsWith("about:") || uri.startsWith("chrome:");
    const isCustomizing = document.documentElement.hasAttribute("customizing");
    const isInsecure = identityBox?.classList.contains("notSecure")
      && !isInternal && !isCustomizing;
    if (isInsecure && !insecureTimer && !insecureBanner) {
      insecureTimer = setTimeout(showInsecureBanner, 2000);
    } else if (!isInsecure) {
      hideInsecureBanner();
    }
  }

  if (identityBox) {
    new MutationObserver(checkInsecure).observe(identityBox, {
      attributes: true,
      attributeFilter: ["class"],
    });
    // Also check on tab switch
    gBrowser.tabContainer.addEventListener("TabSelect", checkInsecure);
  }

  console.log("palefox-drawer: initialized");
}

init();
