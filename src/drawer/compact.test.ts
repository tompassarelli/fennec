// Tier 2 tests for compact.ts (see docs/dev/testing.md).
//
// Uses the happy-dom harness from src/test/harness.ts to exercise compact's
// state machine without launching Firefox. Tests passing here validate the
// LOGIC; real-Firefox behavior is verified separately in Tier 3.
//
// What's covered:
//   toggle (vertical):  enable/disable, attribute set, pref written
//   toggle (horizontal): same shape on documentElement[data-pfx-compact-horizontal]
//   pinSidebar / pinToolbox during external popups
//   isCompactVertical / isCompactHorizontal queries
//   destroy: removes pref observers cleanly
//   pref observer: setBoolPref(COMPACT_PREF) toggles compact when in vertical mode
//
// Deliberately NOT covered here (Tier 3):
//   - Real timing of `transitionend` (happy-dom doesn't fire the right events)
//   - Real popover top-layer behavior
//   - Real CSS transition delays / collapse-protection wall-clock interactions

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { setupHarness, type Harness } from "../test/harness.ts";

let harness: Harness;

beforeEach(() => {
  harness = setupHarness();
});

afterEach(() => {
  harness.cleanup();
});

// === Test setup helper =======================================================

async function buildCompact(opts: { vertical?: boolean } = {}) {
  if (opts.vertical !== undefined) {
    harness.setPref("sidebar.verticalTabs", opts.vertical);
  }
  // Re-import after harness is set up so compact.ts sees mocked globals.
  const { makeCompact } = await import("./compact.ts");
  return makeCompact({
    sidebarMain: harness.document.getElementById("sidebar-main") as HTMLElement,
    navigatorToolbox: harness.document.getElementById("navigator-toolbox") as HTMLElement,
    urlbar: null,
  });
}

// === Toggle (vertical) =======================================================

describe("compactToggle — vertical mode", () => {
  test("first toggle enables compact + sets pref", async () => {
    const compact = await buildCompact({ vertical: true });
    expect(compact.isCompactVertical()).toBe(false);
    expect(harness.prefs.get("pfx.sidebar.compact")).toBeUndefined();

    compact.toggle();

    expect(compact.isCompactVertical()).toBe(true);
    expect(harness.prefs.get("pfx.sidebar.compact")).toBe(true);
    const sidebar = harness.document.getElementById("sidebar-main")!;
    expect(sidebar.hasAttribute("data-pfx-compact")).toBe(true);

    compact.destroy();
  });

  test("second toggle disables compact + writes false to pref", async () => {
    const compact = await buildCompact({ vertical: true });
    compact.toggle();
    compact.toggle();

    expect(compact.isCompactVertical()).toBe(false);
    expect(harness.prefs.get("pfx.sidebar.compact")).toBe(false);
    const sidebar = harness.document.getElementById("sidebar-main")!;
    expect(sidebar.hasAttribute("data-pfx-compact")).toBe(false);

    compact.destroy();
  });

  test("does NOT set horizontal-compact attributes in vertical mode", async () => {
    const compact = await buildCompact({ vertical: true });
    compact.toggle();
    expect(harness.document.documentElement.hasAttribute("data-pfx-compact-horizontal")).toBe(false);
    compact.destroy();
  });
});

// === Toggle (horizontal) =====================================================

describe("compactToggle — horizontal mode", () => {
  test("first toggle enables horizontal compact + sets pref", async () => {
    const compact = await buildCompact({ vertical: false });
    expect(compact.isCompactHorizontal()).toBe(false);
    expect(harness.prefs.get("pfx.toolbar.compact")).toBeUndefined();

    compact.toggle();

    expect(compact.isCompactHorizontal()).toBe(true);
    expect(harness.prefs.get("pfx.toolbar.compact")).toBe(true);
    expect(harness.document.documentElement.hasAttribute("data-pfx-compact-horizontal")).toBe(true);

    compact.destroy();
  });

  test("does NOT set vertical-compact attribute in horizontal mode", async () => {
    const compact = await buildCompact({ vertical: false });
    compact.toggle();
    const sidebar = harness.document.getElementById("sidebar-main")!;
    expect(sidebar.hasAttribute("data-pfx-compact")).toBe(false);
    compact.destroy();
  });
});

// === Pin during external popup ==============================================

describe("pinSidebar / pinToolbox", () => {
  test("pinSidebar sets pfx-has-hover when vertical compact is on", async () => {
    const compact = await buildCompact({ vertical: true });
    compact.toggle(); // enable
    const sidebar = harness.document.getElementById("sidebar-main")!;
    expect(sidebar.hasAttribute("pfx-has-hover")).toBe(false);

    compact.pinSidebar();
    expect(sidebar.hasAttribute("pfx-has-hover")).toBe(true);

    compact.destroy();
  });

  test("pinToolbox sets pfx-has-hover when horizontal compact is on", async () => {
    const compact = await buildCompact({ vertical: false });
    compact.toggle(); // enable
    const toolbox = harness.document.getElementById("navigator-toolbox")!;
    expect(toolbox.hasAttribute("pfx-has-hover")).toBe(false);

    compact.pinToolbox();
    expect(toolbox.hasAttribute("pfx-has-hover")).toBe(true);

    compact.destroy();
  });
});

// === Pref observer ==========================================================

describe("compact pref observer", () => {
  test("flipping pfx.sidebar.compact pref toggles compact when vertical", async () => {
    const compact = await buildCompact({ vertical: true });
    expect(compact.isCompactVertical()).toBe(false);

    harness.setPref("pfx.sidebar.compact", true);
    expect(compact.isCompactVertical()).toBe(true);

    harness.setPref("pfx.sidebar.compact", false);
    expect(compact.isCompactVertical()).toBe(false);

    compact.destroy();
  });

  test("flipping vertical-compact pref is a no-op when in horizontal mode", async () => {
    const compact = await buildCompact({ vertical: false });
    harness.setPref("pfx.sidebar.compact", true);
    expect(compact.isCompactVertical()).toBe(false);
    compact.destroy();
  });

  test("flipping pfx.toolbar.compact pref toggles horizontal compact when in horizontal mode", async () => {
    const compact = await buildCompact({ vertical: false });
    expect(compact.isCompactHorizontal()).toBe(false);

    harness.setPref("pfx.toolbar.compact", true);
    expect(compact.isCompactHorizontal()).toBe(true);

    harness.setPref("pfx.toolbar.compact", false);
    expect(compact.isCompactHorizontal()).toBe(false);

    compact.destroy();
  });
});

// === verticalTabs auto-swap =================================================

describe("sidebar.verticalTabs auto-swap", () => {
  test("flipping verticalTabs tears down vertical and applies horizontal pref", async () => {
    const compact = await buildCompact({ vertical: true });
    // Save prefs that should be applied on swap
    harness.setPref("pfx.sidebar.compact", true);   // applies → enables vertical
    harness.setPref("pfx.toolbar.compact", true);   // saved for when we swap

    expect(compact.isCompactVertical()).toBe(true);
    expect(compact.isCompactHorizontal()).toBe(false);

    // Flip the layout pref
    harness.setPref("sidebar.verticalTabs", false);

    expect(compact.isCompactVertical()).toBe(false);
    expect(compact.isCompactHorizontal()).toBe(true);

    compact.destroy();
  });

  test("flipping back to vertical swaps the surface again", async () => {
    const compact = await buildCompact({ vertical: false });
    harness.setPref("pfx.sidebar.compact", true);
    harness.setPref("pfx.toolbar.compact", true);

    // Now in horizontal mode with horizontal compact on
    expect(compact.isCompactHorizontal()).toBe(true);

    // Flip to vertical
    harness.setPref("sidebar.verticalTabs", true);

    expect(compact.isCompactHorizontal()).toBe(false);
    expect(compact.isCompactVertical()).toBe(true);

    compact.destroy();
  });
});

// === destroy ================================================================

describe("destroy", () => {
  test("removes pref observers", async () => {
    const compact = await buildCompact({ vertical: true });
    expect(harness.prefObservers.get("pfx.sidebar.compact")?.size ?? 0).toBeGreaterThan(0);
    expect(harness.prefObservers.get("pfx.toolbar.compact")?.size ?? 0).toBeGreaterThan(0);
    expect(harness.prefObservers.get("sidebar.verticalTabs")?.size ?? 0).toBeGreaterThan(0);

    compact.destroy();

    expect(harness.prefObservers.get("pfx.sidebar.compact")?.size ?? 0).toBe(0);
    expect(harness.prefObservers.get("pfx.toolbar.compact")?.size ?? 0).toBe(0);
    expect(harness.prefObservers.get("sidebar.verticalTabs")?.size ?? 0).toBe(0);
  });

  test("after destroy, pref changes are no-ops", async () => {
    const compact = await buildCompact({ vertical: true });
    compact.destroy();

    harness.setPref("pfx.sidebar.compact", true);
    expect(compact.isCompactVertical()).toBe(false);
  });
});

// === Initial mode application ==============================================

describe("applyCompactForCurrentMode (init)", () => {
  test("applies vertical compact at construction when pref is on + verticalTabs", async () => {
    harness.setPref("sidebar.verticalTabs", true);
    harness.setPref("pfx.sidebar.compact", true);

    const { makeCompact } = await import("./compact.ts");
    const compact = makeCompact({
      sidebarMain: harness.document.getElementById("sidebar-main") as HTMLElement,
      navigatorToolbox: harness.document.getElementById("navigator-toolbox") as HTMLElement,
      urlbar: null,
    });

    expect(compact.isCompactVertical()).toBe(true);
    compact.destroy();
  });

  test("applies horizontal compact at construction when pref is on + horizontal layout", async () => {
    harness.setPref("sidebar.verticalTabs", false);
    harness.setPref("pfx.toolbar.compact", true);

    const { makeCompact } = await import("./compact.ts");
    const compact = makeCompact({
      sidebarMain: harness.document.getElementById("sidebar-main") as HTMLElement,
      navigatorToolbox: harness.document.getElementById("navigator-toolbox") as HTMLElement,
      urlbar: null,
    });

    expect(compact.isCompactHorizontal()).toBe(true);
    compact.destroy();
  });

  test("does nothing at construction when both prefs off", async () => {
    const compact = await buildCompact({ vertical: true });
    expect(compact.isCompactVertical()).toBe(false);
    expect(compact.isCompactHorizontal()).toBe(false);
    compact.destroy();
  });
});
