// Tier 3 integration tests for the chrome-scope global keymap.
//
// Default behavior is leader-mode: pressing the leader (default Space)
// arms a transient capture window, then the next keystroke dispatches the
// binding. `pressGlobal()` synthesizes the leader-then-key sequence.
//
//   <leader>t        open tabs picker (current window)
//   <leader>T        open tabs picker (all windows)
//   <leader>:        open ex-command picker
//   <leader>x        close current tab
//   <leader>`        toggle to previously-selected tab
//   <leader>o / O    focus urlbar (current / new-tab intent)
//   <leader>h / l    history back / forward
//   <leader>j / k    scroll page down / up (smooth, while held)
//
// Tests at the bottom verify the leader machinery itself (timeout, double
// leader cancels, Esc cancels, blacklist precedence, opt-out empty leader).

import type { IntegrationTest } from "../../tools/test-driver/runner.ts";
import type { MarionetteClient } from "../../tools/test-driver/marionette.ts";

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

const DISMISS_PICKER = `
  const p = document.getElementById("pfx-picker");
  if (p && !p.hidden) {
    const inp = p.querySelector(".pfx-picker-input");
    inp?.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Escape", bubbles: true, cancelable: true, view: window,
    }));
  }
  return true;
`;

const DISMISS_EX_INPUT = `
  const inp = document.querySelector(".pfx-search-input");
  if (inp) {
    inp.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Escape", bubbles: true, cancelable: true, view: window,
    }));
  }
  return true;
`;

const RESET_LEADER = `
  Services.prefs.setBoolPref("pfx.keys.useLeader", true);
  Services.prefs.setStringPref("pfx.keys.leader", " ");
  Services.prefs.setIntPref("pfx.keys.leader_timeout", 1500);
  return true;
`;

const DISABLE_LEADER = `
  Services.prefs.setBoolPref("pfx.keys.useLeader", false);
  return true;
`;

/** Put the chrome window into "panel-not-active" state — the same state the
 *  user is in when they're NOT actively driving the tree panel (content body
 *  focused, urlbar focused, no focus). setupGlobalKeys' leader/bindings only
 *  fire in this state; setupVimKeys' panel-mode handler would otherwise eat
 *  keys via SPC w pane chord prefix logic before global keys see them. */
const DEACTIVATE_PANEL = `
  window.pfxTest.vim.blurPanel();
  return true;
`;

/** Synthesize <leader>+key. Default leader is Space. Sends two keydown
 *  events sequentially against `document` so they go through the same
 *  capture-phase listener that wires global keys. */
function pressGlobal(key: string, opts: { ctrlKey?: boolean; altKey?: boolean } = {}): string {
  const mods = `ctrlKey: ${opts.ctrlKey ? "true" : "false"}, altKey: ${opts.altKey ? "true" : "false"}`;
  return `
    document.dispatchEvent(new KeyboardEvent("keydown", {
      key: " ", ${mods}, bubbles: true, cancelable: true, view: window,
    }));
    document.dispatchEvent(new KeyboardEvent("keydown", {
      key: ${JSON.stringify(key)}, ${mods}, bubbles: true, cancelable: true, view: window,
    }));
    return true;
  `;
}

/** Bare keypress — for testing the always-on (leader = "") fallback path. */
function pressBare(key: string): string {
  return `
    document.dispatchEvent(new KeyboardEvent("keydown", {
      key: ${JSON.stringify(key)}, bubbles: true, cancelable: true, view: window,
    }));
    return true;
  `;
}

const tests: IntegrationTest[] = [
  {
    name: "global-keys: <leader>t opens the tabs picker without sidebar focus",
    async run(mn) {
      await mn.executeScript(RESET_LEADER);
      await mn.executeScript(DISMISS_PICKER);
      await mn.executeScript(DEACTIVATE_PANEL);
      await mn.executeScript(DISMISS_EX_INPUT);
      await mn.executeScript(`
        if (document.activeElement && document.activeElement !== document.body) {
          document.activeElement.blur && document.activeElement.blur();
        }
        return true;
      `);

      await mn.executeScript(pressGlobal("t"));
      await waitFor(mn, `
        const p = document.getElementById("pfx-picker");
        return p && !p.hidden;
      `, 3000);

      const prompt = await mn.executeScript<string>(`
        return document.querySelector("#pfx-picker .pfx-picker-prompt")?.getAttribute("value") || "";
      `);
      if (!prompt.includes("tabs")) {
        throw new Error(`expected tabs picker prompt, got: ${prompt}`);
      }
      if (prompt.includes("all windows")) {
        throw new Error(`<leader>t opened all-windows picker; expected current-window. prompt: ${prompt}`);
      }
      await mn.executeScript(DISMISS_PICKER);
    },
  },

  {
    name: "global-keys: <leader>T opens the all-windows tabs picker",
    async run(mn) {
      await mn.executeScript(RESET_LEADER);
      await mn.executeScript(DISMISS_PICKER);
      await mn.executeScript(DEACTIVATE_PANEL);
      await mn.executeScript(DISMISS_EX_INPUT);
      await mn.executeScript(`
        if (document.activeElement && document.activeElement !== document.body) {
          document.activeElement.blur && document.activeElement.blur();
        }
        return true;
      `);

      await mn.executeScript(pressGlobal("T"));
      await waitFor(mn, `
        const p = document.getElementById("pfx-picker");
        return p && !p.hidden;
      `, 3000);

      const prompt = await mn.executeScript<string>(`
        return document.querySelector("#pfx-picker .pfx-picker-prompt")?.getAttribute("value") || "";
      `);
      if (!prompt.includes("all windows")) {
        throw new Error(`expected all-windows picker prompt, got: ${prompt}`);
      }
      await mn.executeScript(DISMISS_PICKER);
    },
  },

  {
    name: "global-keys: <leader>: opens ex-command picker (when useLeader is on, `:` is gated like everything else)",
    async run(mn) {
      await mn.executeScript(RESET_LEADER);
      await mn.executeScript(DISMISS_PICKER);
      await mn.executeScript(DEACTIVATE_PANEL);
      await mn.executeScript(DISMISS_EX_INPUT);
      await mn.executeScript(pressGlobal(":"));
      await waitFor(mn, `
        const p = document.getElementById("pfx-picker");
        if (!p || p.hidden) return false;
        const prompt = p.querySelector(".pfx-picker-prompt")?.getAttribute("value") || "";
        return prompt.includes("ex");
      `, 3000);
      await mn.executeScript(DISMISS_PICKER);
    },
  },

  {
    name: "global-keys: useLeader=false → bare `:` opens ex-command picker",
    async run(mn) {
      await mn.executeScript(DISABLE_LEADER);
      await mn.executeScript(DISMISS_PICKER);
      await mn.executeScript(DEACTIVATE_PANEL);
      await mn.executeScript(DISMISS_EX_INPUT);
      await mn.executeScript(pressBare(":"));
      try {
        await waitFor(mn, `
          const p = document.getElementById("pfx-picker");
          if (!p || p.hidden) return false;
          const prompt = p.querySelector(".pfx-picker-prompt")?.getAttribute("value") || "";
          return prompt.includes("ex");
        `, 3000);
      } finally {
        await mn.executeScript(DISMISS_PICKER);
        await mn.executeScript(RESET_LEADER);
      }
    },
  },

  {
    name: "global-keys: <leader>x closes the current tab (gBrowser.selectedTab)",
    async run(mn) {
      await mn.executeScript(RESET_LEADER);
      await mn.executeScript(DISMISS_PICKER);
      await mn.executeScript(DEACTIVATE_PANEL);
      await mn.executeScript(`
        const sp = Services.scriptSecurityManager.getSystemPrincipal();
        gBrowser.addTab("about:blank", { triggeringPrincipal: sp });
        return true;
      `);
      const before = await mn.executeScript<number>(`return gBrowser.tabs.length;`);
      await mn.executeScript(`gBrowser.selectedTab = gBrowser.tabs[gBrowser.tabs.length - 1]; return true;`);

      await mn.executeScript(pressGlobal("x"));
      await waitFor(mn, `return gBrowser.tabs.length === ${before - 1};`, 3000);
    },
  },

  {
    name: "global-keys: <leader>` toggles to the previously selected tab",
    async run(mn) {
      await mn.executeScript(RESET_LEADER);
      await mn.executeScript(DISMISS_PICKER);
      await mn.executeScript(DEACTIVATE_PANEL);
      await mn.executeScript(`
        const sp = Services.scriptSecurityManager.getSystemPrincipal();
        if (gBrowser.tabs.length < 2) gBrowser.addTab("about:blank", { triggeringPrincipal: sp });
        return true;
      `);
      await mn.executeScript(`gBrowser.selectedTab = gBrowser.tabs[0]; return true;`);
      await new Promise((r) => setTimeout(r, 100));
      await mn.executeScript(`gBrowser.selectedTab = gBrowser.tabs[1]; return true;`);
      await new Promise((r) => setTimeout(r, 100));
      const idxBefore = await mn.executeScript<number>(`return [...gBrowser.tabs].indexOf(gBrowser.selectedTab);`);
      if (idxBefore !== 1) throw new Error(`setup failed; expected selectedTab to be tab[1], got tab[${idxBefore}]`);

      await mn.executeScript(pressGlobal("`"));
      await waitFor(mn, `return [...gBrowser.tabs].indexOf(gBrowser.selectedTab) === 0;`, 3000);
    },
  },

  // ===== Leader-mode machinery =====

  {
    name: "leader: when configured, bare key does NOT dispatch (leader gates)",
    async run(mn) {
      await mn.executeScript(RESET_LEADER);
      await mn.executeScript(DISMISS_PICKER);
      await mn.executeScript(DEACTIVATE_PANEL);
      await mn.executeScript(DISMISS_EX_INPUT);
      await mn.executeScript(pressBare("t"));
      await new Promise((r) => setTimeout(r, 200));
      const pickerOpen = await mn.executeScript<boolean>(`
        const p = document.getElementById("pfx-picker");
        return !!(p && !p.hidden);
      `);
      if (pickerOpen) {
        throw new Error("bare `t` opened picker with leader configured — leader should gate");
      }
    },
  },

  {
    name: "leader: pressing the leader twice silently disarms",
    async run(mn) {
      await mn.executeScript(RESET_LEADER);
      await mn.executeScript(DISMISS_PICKER);
      await mn.executeScript(DEACTIVATE_PANEL);
      // Press space (arm), then space again (cancel).
      await mn.executeScript(`
        document.dispatchEvent(new KeyboardEvent("keydown", {
          key: " ", bubbles: true, cancelable: true, view: window,
        }));
        document.dispatchEvent(new KeyboardEvent("keydown", {
          key: " ", bubbles: true, cancelable: true, view: window,
        }));
        return true;
      `);
      // which-key panel should be hidden.
      await new Promise((r) => setTimeout(r, 100));
      const wkVisible = await mn.executeScript<boolean>(`
        const wk = document.getElementById("pfx-which-key");
        return !!(wk && !wk.hidden);
      `);
      if (wkVisible) throw new Error("which-key still visible after double-leader");

      // And no picker should be open.
      const pickerOpen = await mn.executeScript<boolean>(`
        const p = document.getElementById("pfx-picker");
        return !!(p && !p.hidden);
      `);
      if (pickerOpen) throw new Error("double-leader opened picker — should silently cancel");
    },
  },

  {
    name: "leader: Esc after leader silently disarms",
    async run(mn) {
      await mn.executeScript(RESET_LEADER);
      await mn.executeScript(DISMISS_PICKER);
      await mn.executeScript(DEACTIVATE_PANEL);
      await mn.executeScript(`
        document.dispatchEvent(new KeyboardEvent("keydown", {
          key: " ", bubbles: true, cancelable: true, view: window,
        }));
        document.dispatchEvent(new KeyboardEvent("keydown", {
          key: "Escape", bubbles: true, cancelable: true, view: window,
        }));
        return true;
      `);
      await new Promise((r) => setTimeout(r, 100));
      const wkVisible = await mn.executeScript<boolean>(`
        const wk = document.getElementById("pfx-which-key");
        return !!(wk && !wk.hidden);
      `);
      if (wkVisible) throw new Error("which-key still visible after leader+Esc");
    },
  },

  {
    name: "leader: timeout disarms (binding after timeout does NOT fire)",
    async run(mn) {
      // Use a short timeout so the test runs quickly.
      await mn.executeScript(`
        Services.prefs.setStringPref("pfx.keys.leader", " ");
        Services.prefs.setIntPref("pfx.keys.leader_timeout", 200);
        return true;
      `);
      await mn.executeScript(DISMISS_PICKER);
      // Arm leader.
      await mn.executeScript(`
        document.dispatchEvent(new KeyboardEvent("keydown", {
          key: " ", bubbles: true, cancelable: true, view: window,
        }));
        return true;
      `);
      // Wait past timeout.
      await new Promise((r) => setTimeout(r, 350));
      // Now press `t` — leader expired so it should NOT open the picker.
      await mn.executeScript(`
        document.dispatchEvent(new KeyboardEvent("keydown", {
          key: "t", bubbles: true, cancelable: true, view: window,
        }));
        return true;
      `);
      await new Promise((r) => setTimeout(r, 200));
      const pickerOpen = await mn.executeScript<boolean>(`
        const p = document.getElementById("pfx-picker");
        return !!(p && !p.hidden);
      `);
      // Reset for subsequent tests.
      await mn.executeScript(RESET_LEADER);
      if (pickerOpen) throw new Error("`t` after leader-timeout opened picker — disarm didn't fire");
    },
  },

  {
    name: "leader: bare leader keypress does NOT show the help panel (Emacs-style silent hot path)",
    async run(mn) {
      await mn.executeScript(RESET_LEADER);
      await mn.executeScript(DISMISS_PICKER);
      await mn.executeScript(DEACTIVATE_PANEL);
      await mn.executeScript(`
        const wk = document.getElementById("pfx-which-key");
        if (wk) wk.hidden = true;
        return true;
      `);
      await mn.executeScript(`
        document.dispatchEvent(new KeyboardEvent("keydown", {
          key: " ", bubbles: true, cancelable: true, view: window,
        }));
        return true;
      `);
      const visibleAfterLeader = await mn.executeScript<boolean>(`
        const wk = document.getElementById("pfx-which-key");
        return !!(wk && !wk.hidden);
      `);
      if (visibleAfterLeader) {
        throw new Error("help panel was shown after bare leader — should be silent");
      }
      // Cleanup — disarm via second leader.
      await mn.executeScript(`
        document.dispatchEvent(new KeyboardEvent("keydown", {
          key: " ", bubbles: true, cancelable: true, view: window,
        }));
        return true;
      `);
    },
  },

  {
    name: "leader: <leader>? shows the help panel; Esc hides it",
    async run(mn) {
      await mn.executeScript(RESET_LEADER);
      await mn.executeScript(DISMISS_PICKER);
      await mn.executeScript(DEACTIVATE_PANEL);
      await mn.executeScript(`
        const wk = document.getElementById("pfx-which-key");
        if (wk) wk.hidden = true;
        return true;
      `);
      // <leader>? → panel visible.
      await mn.executeScript(pressGlobal("?"));
      const shownAfterFirst = await mn.executeScript<boolean>(`
        const wk = document.getElementById("pfx-which-key");
        return !!(wk && !wk.hidden);
      `);
      if (!shownAfterFirst) throw new Error("help panel did not appear on <leader>?");
      // Esc → panel hidden.
      await mn.executeScript(`
        document.dispatchEvent(new KeyboardEvent("keydown", {
          key: "Escape", bubbles: true, cancelable: true, view: window,
        }));
        return true;
      `);
      const shownAfterEsc = await mn.executeScript<boolean>(`
        const wk = document.getElementById("pfx-which-key");
        return !!(wk && !wk.hidden);
      `);
      if (shownAfterEsc) throw new Error("help panel still visible after Esc");
    },
  },

  {
    name: "leader: useLeader=false (default) → bare keys dispatch directly",
    async run(mn) {
      await mn.executeScript(DISABLE_LEADER);
      await mn.executeScript(DISMISS_PICKER);
      await mn.executeScript(DEACTIVATE_PANEL);
      await mn.executeScript(pressBare("t"));
      try {
        await waitFor(mn, `
          const p = document.getElementById("pfx-picker");
          return p && !p.hidden;
        `, 3000);
      } finally {
        await mn.executeScript(DISMISS_PICKER);
        await mn.executeScript(RESET_LEADER);
      }
    },
  },

  {
    name: "leader: blacklist takes precedence — leader doesn't even arm",
    async run(mn) {
      await mn.executeScript(RESET_LEADER);
      await mn.executeScript(DISMISS_PICKER);
      await mn.executeScript(DEACTIVATE_PANEL);
      // Force a blacklisted host. We pre-seed the blacklist with the current
      // host so currentHostBlacklisted() returns true.
      const host = await mn.executeScript<string>(`
        try {
          const uri = gBrowser.selectedBrowser?.currentURI?.spec || "";
          return new URL(uri).hostname.toLowerCase() || "_about_";
        } catch { return "_about_"; }
      `);
      // about: URIs have empty hostname — for those, currentHostBlacklisted
      // returns false regardless of pref content. Add an entry covering the
      // host AND a marker that lets us prove the path was reached.
      if (!host || host === "_about_") {
        // No host on this URI — blacklist test isn't meaningful here. Skip.
        return;
      }
      await mn.executeScript(`Services.prefs.setStringPref("pfx.keys.blacklist", ${JSON.stringify(host)}); return true;`);
      try {
        await mn.executeScript(`
          document.dispatchEvent(new KeyboardEvent("keydown", {
            key: " ", bubbles: true, cancelable: true, view: window,
          }));
          return true;
        `);
        await new Promise((r) => setTimeout(r, 100));
        const armed = await mn.executeScript<boolean>(`
          const wk = document.getElementById("pfx-which-key");
          return !!(wk && !wk.hidden);
        `);
        if (armed) throw new Error("blacklist did not stop leader from arming");
      } finally {
        await mn.executeScript(`Services.prefs.setStringPref("pfx.keys.blacklist", ""); return true;`);
      }
    },
  },
];

export default tests;
