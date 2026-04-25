// Content-focus bridge — JSWindowActor-style frame script that reports the
// editable-status of content's active element back to chrome.
//
// Why: palefox keys live in chrome scope, but we need Tridactyl/Vimium-style
// "is the user typing into something" detection that's only knowable from
// content scope. e10s isolation means chrome can't read content DOM. So we
// inject a tiny frame script that owns the same logic Vimium uses
// (lib/dom_utils.js::isFocusable + walking shadow roots) and forwards a
// boolean to chrome via the message manager.
//
// Logic mirrors:
//   - Vimium:   content_scripts/mode_insert.js (permanent InsertMode)
//                + lib/dom_utils.js (isFocusable / isEditable / isSelectable)
//   - Tridactyl: src/lib/dom.ts::isTextEditable
//
// Both run in content scope. We can't, so this is the closest we get:
// content-scope helper + chrome-scope cache + chrome-scope read in the
// keymap bail. State is cached per-browser-element, so tab switches pick
// up the right tab's cached state automatically.

import { createLogger, type Logger } from "./log.ts";

declare const Services: any;
declare const gBrowser: any;

// =============================================================================
// INTERFACE
// =============================================================================

export type ContentFocusAPI = {
  /** True iff the currently selected tab's content has focus on an editable
   *  element (input, textarea, contentEditable, role=textbox/application).
   *  False otherwise — including when content has focus on body / a button /
   *  a link / nothing at all. */
  contentInputFocused(): boolean;
  /** Tear down message listeners + frame script. Called from window.unload. */
  destroy(): void;
};

// =============================================================================
// FRAME SCRIPT (runs in every content frame)
// =============================================================================

// IIFE serialized into a data: URL. Matches Vimium's isSelectable/isEditable
// almost line-for-line, plus the deep-active-element walk that handles
// shadow DOM (mode_insert.js::getActiveElement). Reports state on every
// focusin/focusout/click/pagehide so chrome's cache stays current as the
// user tabs through inputs, focuses & blurs, navigates, etc.
const FRAME_SCRIPT_SRC = `
"use strict";
(function() {
  // --- editability check (mirrors Vimium lib/dom_utils.js) ---
  const UNSELECTABLE_INPUT_TYPES = new Set([
    "button","checkbox","color","file","hidden","image","radio","reset","submit"
  ]);

  function isSelectable(el) {
    if (!(el instanceof Element)) return false;
    const tag = el.nodeName ? el.nodeName.toLowerCase() : "";
    if (tag === "input") return !UNSELECTABLE_INPUT_TYPES.has((el.type || "").toLowerCase());
    if (tag === "textarea") return true;
    if (el.isContentEditable) return true;
    return false;
  }

  function isEditable(el) {
    if (isSelectable(el)) return true;
    if (!(el instanceof Element)) return false;
    const tag = el.nodeName ? el.nodeName.toLowerCase() : "";
    if (tag === "select") return true;
    // ARIA: role=textbox is a custom-rolled input field, role=application means
    // the element manages its own keyboard (Google Docs, sheets, etc.).
    const role = el.getAttribute && el.getAttribute("role");
    if (role === "textbox" || role === "searchbox" || role === "application") return true;
    return false;
  }

  // Walk shadow roots (Vimium content_scripts/mode_insert.js::getActiveElement).
  function deepActiveElement() {
    let a = content.document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) {
      a = a.shadowRoot.activeElement;
    }
    return a;
  }

  let lastReported = null;
  function report() {
    const editable = isEditable(deepActiveElement());
    if (editable === lastReported) return;
    lastReported = editable;
    sendAsyncMessage("Palefox:FocusState", { editable });
  }

  addEventListener("focusin",  report, true);
  addEventListener("focusout", report, true);
  addEventListener("click",    report, true);
  addEventListener("DOMContentLoaded", report, true);
  addEventListener("pagehide", () => {
    lastReported = false;
    sendAsyncMessage("Palefox:FocusState", { editable: false });
  }, true);

  // Initial report on script load.
  report();
})();
`;

// =============================================================================
// IMPLEMENTATION
// =============================================================================

export function makeContentFocus(): ContentFocusAPI {
  const log: Logger = createLogger("contentFocus");
  // Per-browser cache. WeakMap so closing a tab GCs the entry naturally.
  const editablePerBrowser = new WeakMap<Element, boolean>();

  const dataUrl = "data:application/javascript;charset=utf-8," + encodeURIComponent(FRAME_SCRIPT_SRC);

  // gBrowser.messageManager broadcasts to all <browser> frame loaders in this
  // chrome window AND auto-attaches to newly-opened tabs (allowDelayedLoad=true).
  const mm = (gBrowser as { messageManager?: any }).messageManager;
  if (!mm) {
    log("init:no-message-manager");
    return {
      contentInputFocused: () => false,
      destroy: () => {},
    };
  }

  function onFocusState(msg: { target: Element; data: { editable: boolean } }): void {
    editablePerBrowser.set(msg.target, !!msg.data.editable);
  }

  mm.loadFrameScript(dataUrl, /* allowDelayedLoad */ true);
  mm.addMessageListener("Palefox:FocusState", onFocusState);
  log("init", { dataUrlSize: dataUrl.length });

  // When the user switches tabs, the cached state for the newly-selected
  // browser is used immediately (no message needed). Just for safety,
  // ask the new tab's frame script to re-report after switch — covers the
  // race where the script hasn't loaded yet for a brand-new tab.
  function onTabSelect(): void {
    try {
      const browser = gBrowser.selectedBrowser as { messageManager?: any };
      // sendAsyncMessage to a single browser's frame script asking it to re-report.
      // We don't define a "Palefox:Probe" handler in the frame script (avoid
      // bloat); instead, the cache value just stays whatever the last report
      // was. If user opens a new tab, default is "not editable" until the
      // first focusin fires there.
      // (Kept here as a hook in case we add probe later.)
      void browser;
    } catch {}
  }
  gBrowser.tabContainer?.addEventListener("TabSelect", onTabSelect);

  function contentInputFocused(): boolean {
    try {
      const browser = (gBrowser as { selectedBrowser?: Element }).selectedBrowser;
      if (!browser) return false;
      return editablePerBrowser.get(browser) === true;
    } catch {
      return false;
    }
  }

  function destroy(): void {
    try {
      mm.removeMessageListener("Palefox:FocusState", onFocusState);
      mm.removeDelayedFrameScript?.(dataUrl);
    } catch (e) {
      log("destroy:error", { msg: String(e) });
    }
    gBrowser.tabContainer?.removeEventListener("TabSelect", onTabSelect);
  }

  return { contentInputFocused, destroy };
}
