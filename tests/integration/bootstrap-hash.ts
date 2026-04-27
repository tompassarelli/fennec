// Tier 3 integration tests for the hash-pinned bootstrap (program/config.template.js).
//
// These verify the security gate actually fires: a tampered or unexpected
// file in the watched directories should cause palefox to refuse to load.
// Without these, a future refactor that breaks the hash check (or accidentally
// makes it permissive) would slip through unnoticed.
//
// These tests run against the test rig Firefox set up by
// tools/test-driver/firefox-rig.ts, which has the hash-pinned bootstrap
// installed in its (user-owned) install root. Marionette tests use a
// fresh ephemeral profile per test, so tampering happens in the temp
// profile and never touches the developer's daily Firefox.

import { copyFile, readFile, writeFile, unlink, rm } from "node:fs/promises";
import { join } from "node:path";
import type { IntegrationTest } from "../../tools/test-driver/runner.ts";
import type { MarionetteClient } from "../../tools/test-driver/marionette.ts";

async function pfxTestExposed(mn: MarionetteClient): Promise<boolean> {
  return await mn.executeScript<boolean>(
    `return typeof window.pfxTest !== "undefined";`,
  );
}

async function waitForPalefox(mn: MarionetteClient, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pfxTestExposed(mn)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("palefox failed to load (pfxTest never exposed) within timeout");
}

// Sanity: poll for ~3s to confirm palefox stayed unloaded. Without a poll
// we'd race against palefox's deferred init and could pass a "did not load"
// assertion the moment Firefox started, before palefox's gBrowserInit hook
// would normally fire.
async function assertPalefoxDidNotLoad(mn: MarionetteClient): Promise<void> {
  await new Promise((r) => setTimeout(r, 3000));
  if (await pfxTestExposed(mn)) {
    throw new Error(
      "expected palefox to be REJECTED by hash-pinned bootstrap, but " +
      "pfxTest is exposed — bootstrap is either stock fx-autoconfig (run " +
      "`bun run build && ./install.sh` to install hash-pinned variant) " +
      "or the gate has been broken",
    );
  }
}

const tests: IntegrationTest[] = [
  {
    name: "bootstrap: positive control — palefox loads cleanly",
    async run(mn, ctx) {
      await waitForPalefox(mn);
    },
  },
  {
    name: "bootstrap: tampered chrome/JS file → palefox refuses to load",
    async run(mn, ctx) {
      const target = join(ctx.profilePath, "chrome", "JS", "palefox-tabs.uc.js");
      const backup = target + ".bak";

      // Snapshot, tamper.
      await copyFile(target, backup);
      const original = await readFile(target);
      await writeFile(target, Buffer.concat([original, Buffer.from("\n// tamper\n")]));

      try {
        const mn2 = await ctx.restartFirefox();
        await assertPalefoxDidNotLoad(mn2);
      } finally {
        // Restore so subsequent tests / future runs aren't poisoned.
        await copyFile(backup, target);
        await unlink(backup);
      }

      // Re-restart with original file, confirm palefox loads again.
      const mn3 = await ctx.restartFirefox();
      await waitForPalefox(mn3);
    },
  },
  {
    name: "bootstrap: extra .uc.js in chrome/JS → palefox refuses to load",
    async run(mn, ctx) {
      const intruder = join(ctx.profilePath, "chrome", "JS", "z-intruder.uc.js");
      await writeFile(intruder, "// pretending to be a userscript\n");

      try {
        const mn2 = await ctx.restartFirefox();
        await assertPalefoxDidNotLoad(mn2);
      } finally {
        await rm(intruder, { force: true });
      }

      const mn3 = await ctx.restartFirefox();
      await waitForPalefox(mn3);
    },
  },
];

export default tests;
