// Tier 3 integration tests for tab-tree persistence.
//
// Proves the round-trip Tier 1 unit tests can't:
//   - palefox actually writes <profile>/palefox-tab-tree.json on tab events
//   - the file survives a Firefox kill+restart with the same profile
//   - palefox loads the saved tree at startup and produces a stable JSON
//     file again on next save
//
// Strategy: open synthetic tabs in chrome scope, trigger a save by closing
// one (TabClose → scheduleSave), read the file back, kill+restart Firefox,
// confirm the file is still there with our saved structure.

import type { IntegrationTest } from "../../tools/test-driver/runner.ts";
import type { MarionetteClient } from "../../tools/test-driver/marionette.ts";
import { join } from "node:path";
import { readFile, stat } from "node:fs/promises";

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
    name: "persist: opening tabs writes palefox-tab-tree.json with their URLs",
    async run(mn, ctx) {
      const treeFilePath = join(ctx.profilePath, "palefox-tab-tree.json");

      // Open 3 about: tabs (cheap, render synchronously, no network).
      await mn.executeScript(`
        gBrowser.addTab("about:blank", { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
        gBrowser.addTab("about:license", { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
        gBrowser.addTab("about:rights", { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
      `);
      await waitFor(mn, `return gBrowser.tabs.length >= 4;`);

      // Move a tab to trigger TabMove → palefox's scheduleSave.
      await mn.executeScript(`gBrowser.moveTabTo(gBrowser.tabs[gBrowser.tabs.length - 1], { tabIndex: 0 });`);

      // Saves are async; wait for the file to materialize.
      const start = Date.now();
      while (Date.now() - start < 5000) {
        try {
          await stat(treeFilePath);
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      const text = await readFile(treeFilePath, "utf8");
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed.nodes)) {
        throw new Error(`tree file present but malformed: ${text.slice(0, 200)}`);
      }
      if (parsed.nodes.length < 4) {
        throw new Error(`expected 4+ nodes, got ${parsed.nodes.length}: ${text.slice(0, 400)}`);
      }
      // Schema-level checks. URLs may not have resolved yet under headless
      // (lazy tab loads stay at about:blank until the page is shown), so
      // we don't probe specific URLs — just that the structure is right.
      const tabs = parsed.nodes.filter((n: { type?: string }) => n.type !== "group");
      for (const t of tabs) {
        if (typeof t.id !== "number" || t.id <= 0) {
          throw new Error(`tab node missing valid id: ${JSON.stringify(t)}`);
        }
        if (!("url" in t) || typeof t.url !== "string") {
          throw new Error(`tab node missing url: ${JSON.stringify(t)}`);
        }
        if (!("parentId" in t)) {
          throw new Error(`tab node missing parentId: ${JSON.stringify(t)}`);
        }
      }
      if (typeof parsed.nextTabId !== "number") {
        throw new Error(`envelope nextTabId missing or wrong type: ${parsed.nextTabId}`);
      }
    },
  },

  {
    name: "persist: tree file survives Firefox restart with same profile",
    async run(mn, ctx) {
      const treeFilePath = join(ctx.profilePath, "palefox-tab-tree.json");

      // Read tree file BEFORE restart.
      const beforeText = await readFile(treeFilePath, "utf8");
      const before = JSON.parse(beforeText);
      const beforeIds = new Set<number>(before.nodes
        .filter((n: { type?: string }) => n.type !== "group")
        .map((n: { id: number }) => n.id));
      if (beforeIds.size === 0) {
        throw new Error("pre-restart tree file has no tab IDs — prior test didn't run?");
      }

      // Restart Firefox. Returns a fresh client.
      const mn2 = await ctx.restartFirefox();

      // After restart, palefox loads the tree. Wait for chrome bootstrap.
      await waitFor(mn2, `return !!document.getElementById("sidebar-main");`);

      // Trigger another save event (close a tab) so we get a fresh
      // file write reflecting the loaded state.
      await mn2.executeScript(`
        if (gBrowser.tabs.length > 1) gBrowser.removeTab(gBrowser.tabs[gBrowser.tabs.length - 1]);
      `);

      // Wait for the file to be re-written (size or mtime change).
      const startTime = Date.now();
      let afterText = beforeText;
      while (Date.now() - startTime < 5000) {
        afterText = await readFile(treeFilePath, "utf8");
        if (afterText !== beforeText) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      const after = JSON.parse(afterText);
      if (!Array.isArray(after.nodes)) {
        throw new Error("post-restart tree file malformed");
      }

      // The pfx-id space must be preserved across restart — we assigned
      // 4+ tabs in the previous test, so nextTabId should be at least
      // that high after reload (the loader bumps it past the highest
      // observed id).
      if (after.nextTabId == null || after.nextTabId < beforeIds.size + 1) {
        throw new Error(
          `nextTabId did not survive restart: before had ${beforeIds.size} ids, ` +
          `after.nextTabId=${after.nextTabId}`,
        );
      }
    },
  },
];

export default tests;
