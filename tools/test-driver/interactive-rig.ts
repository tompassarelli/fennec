// Interactive Firefox launcher against the test rig.
//
// Spawns a headed Firefox window using the rig binary + a fresh
// ephemeral profile populated with palefox's chrome/ files. You get a
// real browser to play with — try tampering, validating new features,
// poking at things in the Browser Console — without touching your daily
// Firefox profile or install.
//
// Usage:
//   bun run test:rig
//
// On exit (close the window or Ctrl-C):
//   - Profile dir is deleted
//   - Firefox process is terminated cleanly
//
// To tamper from another shell while the window is open, the profile
// path is printed at startup. e.g.:
//   echo "// tamper" >> /tmp/palefox-rig-XXXXX/chrome/JS/palefox-tabs.uc.js
// Then close the window and reopen via `bun run test:rig` to see the
// bootstrap reject the tampered file.

import { spawn } from "node:child_process";
import { setupTestRig } from "./firefox-rig.ts";
import { createProfile } from "./profile.ts";

async function main(): Promise<void> {
  console.log("Setting up test rig (idempotent)...");
  const rig = await setupTestRig();

  console.log("Creating ephemeral profile...");
  const profile = await createProfile();
  console.log(`✓ Profile: ${profile.path}`);
  console.log("");
  console.log("Launching test rig Firefox (headed). Close the window to clean up.");
  console.log("");
  console.log("To validate the bootstrap gate manually, in another shell:");
  console.log(`  echo "// tamper" >> ${profile.path}/chrome/JS/palefox-tabs.uc.js`);
  console.log("Then close + reopen Firefox (Ctrl-C here, re-run bun run test:rig).");
  console.log("Browser Console (Ctrl+Shift+J) will show: palefox: hash mismatch ...");
  console.log("");

  const ff = spawn(rig.firefoxBin, [
    "--profile", profile.path,
    "--no-remote",
  ], { stdio: "inherit" });

  // Clean up profile when Firefox exits OR when this process is signalled.
  const cleanup = async () => {
    try { ff.kill("SIGTERM"); } catch { /* already dead */ }
    await profile.cleanup();
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  ff.on("exit", async () => {
    await profile.cleanup();
    console.log("\n✓ Profile cleaned up.");
    process.exit(0);
  });
}

if (import.meta.main) {
  await main();
}
