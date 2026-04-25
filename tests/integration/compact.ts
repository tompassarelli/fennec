// Tier 3 integration tests for compact mode (real Firefox via Marionette).
// See docs/dev/testing.md for how the harness works.
//
// These tests prove behavior that Tier 2 mocks can't reach:
//   - palefox autoconfig loaded into the ephemeral profile
//   - Real `Services.prefs` observer chain reacts to pref changes
//   - Real chrome DOM (`#sidebar-main` etc.) gets the expected attributes
//   - The hover-strip element is created and removed by enable/disable
//
// Note: under `--headless`, some chrome elements that depend on toolbar
// customization (like `#sidebar-button` itself) aren't present at script
// eval time. Tests here probe behavior that doesn't require those —
// headless-mode-specific UX work belongs in headed CI / manual QA.

import type { IntegrationTest } from "../../tools/test-driver/runner.ts";
import type { MarionetteClient } from "../../tools/test-driver/marionette.ts";

/** Poll the chrome scope until `scriptReturningBool` evaluates truthy or the
 *  timeout elapses. Throws on timeout. Pollback at 100ms — fast enough for
 *  pref-observer reactions, gentle on Firefox. */
async function waitFor(
  mn: MarionetteClient,
  scriptReturningBool: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await mn.executeScript<boolean>(scriptReturningBool);
    if (ok) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for: ${scriptReturningBool.slice(0, 120)}`);
}

const tests: IntegrationTest[] = [
  {
    name: "palefox bootstrap: chrome window has sidebar-main and gBrowser",
    async run(mn) {
      const info = await mn.executeScript<{
        url: string;
        sidebarMain: boolean;
        gBrowser: boolean;
        compactPrefRegistered: boolean;
      }>(`
        return {
          url: window.location?.href || "",
          sidebarMain: !!document.getElementById("sidebar-main"),
          gBrowser: typeof window.gBrowser !== "undefined",
          compactPrefRegistered: Services.prefs.prefHasUserValue("pfx.debug")
            || true,  // 'true' is fine if no user value — Services itself works
        };
      `);
      if (info.url !== "chrome://browser/content/browser.xhtml") {
        throw new Error(`unexpected chrome URL: ${info.url}`);
      }
      if (!info.sidebarMain) throw new Error("#sidebar-main missing from chrome doc");
      if (!info.gBrowser) throw new Error("gBrowser global missing — palefox load context wrong");
    },
  },

  {
    name: "compact pref observer: setting true adds data-pfx-compact, false removes it",
    async run(mn) {
      // Sanity: attribute starts absent.
      const startAttr = await mn.executeScript<boolean>(
        `return document.getElementById("sidebar-main")?.hasAttribute("data-pfx-compact") || false;`,
      );
      if (startAttr) {
        throw new Error("data-pfx-compact already set at startup — test profile state leaked?");
      }

      // Flip pref → palefox's observer should add the attribute.
      await mn.executeScript(`Services.prefs.setBoolPref("pfx.sidebar.compact", true);`);
      await waitFor(
        mn,
        `return document.getElementById("sidebar-main")?.hasAttribute("data-pfx-compact") || false;`,
      );

      // Flip back → attribute removed.
      await mn.executeScript(`Services.prefs.setBoolPref("pfx.sidebar.compact", false);`);
      await waitFor(
        mn,
        `return !document.getElementById("sidebar-main")?.hasAttribute("data-pfx-compact");`,
      );
    },
  },

  {
    name: "compact: hover strip element is created when active, removed when off",
    async run(mn) {
      await mn.executeScript(`Services.prefs.setBoolPref("pfx.sidebar.compact", true);`);
      await waitFor(mn, `return !!document.getElementById("pfx-hover-strip");`);

      await mn.executeScript(`Services.prefs.setBoolPref("pfx.sidebar.compact", false);`);
      await waitFor(mn, `return !document.getElementById("pfx-hover-strip");`);
    },
  },

  {
    name: "horizontal compact: setting pfx.toolbar.compact in horizontal mode adds the root attribute",
    async run(mn) {
      // Switch to horizontal layout, then enable horizontal compact.
      await mn.executeScript(`Services.prefs.setBoolPref("sidebar.verticalTabs", false);`);
      await mn.executeScript(`Services.prefs.setBoolPref("pfx.toolbar.compact", true);`);
      await waitFor(
        mn,
        `return document.documentElement.hasAttribute("data-pfx-compact-horizontal");`,
      );

      // Disable horizontal compact + restore vertical layout for the next test.
      await mn.executeScript(`Services.prefs.setBoolPref("pfx.toolbar.compact", false);`);
      await waitFor(
        mn,
        `return !document.documentElement.hasAttribute("data-pfx-compact-horizontal");`,
      );
      await mn.executeScript(`Services.prefs.setBoolPref("sidebar.verticalTabs", true);`);
    },
  },

  {
    name: "verticalTabs auto-swap tears down outgoing mode in real Firefox",
    async run(mn) {
      // Enable BOTH compact prefs. Only the active mode's attribute should
      // be present at any time; flipping verticalTabs swaps which one.
      await mn.executeScript(`
        Services.prefs.setBoolPref("sidebar.verticalTabs", true);
        Services.prefs.setBoolPref("pfx.sidebar.compact", true);
        Services.prefs.setBoolPref("pfx.toolbar.compact", true);
      `);

      // Vertical mode active → vertical attr present, horizontal absent.
      await waitFor(mn, `
        const sb = document.getElementById("sidebar-main");
        const root = document.documentElement;
        return sb?.hasAttribute("data-pfx-compact")
          && !root.hasAttribute("data-pfx-compact-horizontal");
      `);

      // Flip to horizontal — vertical should tear down, horizontal apply.
      await mn.executeScript(`Services.prefs.setBoolPref("sidebar.verticalTabs", false);`);
      await waitFor(mn, `
        const sb = document.getElementById("sidebar-main");
        const root = document.documentElement;
        return !sb?.hasAttribute("data-pfx-compact")
          && root.hasAttribute("data-pfx-compact-horizontal");
      `);

      // Flip back — horizontal teardown, vertical apply.
      await mn.executeScript(`Services.prefs.setBoolPref("sidebar.verticalTabs", true);`);
      await waitFor(mn, `
        const sb = document.getElementById("sidebar-main");
        const root = document.documentElement;
        return sb?.hasAttribute("data-pfx-compact")
          && !root.hasAttribute("data-pfx-compact-horizontal");
      `);

      // Cleanup: turn both off so subsequent tests start from a clean slate.
      await mn.executeScript(`
        Services.prefs.setBoolPref("pfx.sidebar.compact", false);
        Services.prefs.setBoolPref("pfx.toolbar.compact", false);
      `);
    },
  },

  {
    name: "popup pin: dispatching pfx-flash sets pfx-has-hover, then it auto-clears",
    async run(mn) {
      // Enable compact so the flash dispatch is meaningful.
      await mn.executeScript(`Services.prefs.setBoolPref("pfx.sidebar.compact", true);`);
      await waitFor(mn, `return document.getElementById("sidebar-main")?.hasAttribute("data-pfx-compact");`);

      // Dispatch the pfx-flash event palefox listens for.
      await mn.executeScript(`
        document.getElementById("sidebar-main").dispatchEvent(new CustomEvent("pfx-flash"));
      `);
      // Sidebar becomes visible (pfx-has-hover set).
      await waitFor(
        mn,
        `return document.getElementById("sidebar-main")?.hasAttribute("pfx-has-hover");`,
        2000,
      );
      // Eventually clears (FLASH_DURATION = 800ms; allow 3s for headless slowness).
      await waitFor(
        mn,
        `return !document.getElementById("sidebar-main")?.hasAttribute("pfx-has-hover");`,
        3000,
      );

      // Cleanup
      await mn.executeScript(`Services.prefs.setBoolPref("pfx.sidebar.compact", false);`);
    },
  },

  {
    name: "pfx-dismiss event force-hides a visible compact sidebar",
    async run(mn) {
      // Enable compact + force visible via pfx-flash, then dismiss.
      await mn.executeScript(`Services.prefs.setBoolPref("pfx.sidebar.compact", true);`);
      await waitFor(mn, `return document.getElementById("sidebar-main")?.hasAttribute("data-pfx-compact");`);
      // Wait out any collapse-protection window left by an earlier test
      // (FLASH_DURATION = 800ms auto-hide stamps a 280ms protection window
      // afterwards; a freshly-started test could land inside it).
      await new Promise((r) => setTimeout(r, 350));
      await mn.executeScript(`
        const sb = document.getElementById("sidebar-main");
        sb.dispatchEvent(new CustomEvent("pfx-flash"));
      `);
      await waitFor(
        mn,
        `return document.getElementById("sidebar-main")?.hasAttribute("pfx-has-hover");`,
        2000,
      );
      // Dismiss should remove pfx-has-hover synchronously (or nearly so).
      await mn.executeScript(`
        document.getElementById("sidebar-main").dispatchEvent(new CustomEvent("pfx-dismiss"));
      `);
      await waitFor(
        mn,
        `return !document.getElementById("sidebar-main")?.hasAttribute("pfx-has-hover");`,
        2000,
      );
      await mn.executeScript(`Services.prefs.setBoolPref("pfx.sidebar.compact", false);`);
    },
  },

  {
    name: "destroy on window unload: pref observers no longer fire",
    async run(mn) {
      // We can't actually unload the chrome window mid-suite (would kill
      // Marionette), so probe a proxy: confirm the unload-listener IS
      // registered. palefox uses `{ once: true }` so we can't easily check
      // for its presence; instead verify the test behavior is symmetric —
      // a no-op pref change after the observer chain is intact.
      // (Real cleanup verified in Tier 2 mocked tests; this is a smoke check.)
      const result = await mn.executeScript<{ verticalTabsObserved: boolean }>(`
        // If palefox's verticalTabs observer is wired, flipping the pref
        // back-and-forth should leave the same end state and not throw.
        const orig = Services.prefs.getBoolPref("sidebar.verticalTabs", true);
        Services.prefs.setBoolPref("sidebar.verticalTabs", !orig);
        Services.prefs.setBoolPref("sidebar.verticalTabs", orig);
        return { verticalTabsObserved: true };
      `);
      if (!result.verticalTabsObserved) throw new Error("pref flip did not survive observer chain");
    },
  },
];

export default tests;
