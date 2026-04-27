// Cross-platform Firefox binary locator for the test driver.
//
// Resolution order:
//   1. $FIREFOX_BIN env var (explicit override)
//   2. The palefox test rig at ~/.cache/palefox-test-firefox/ (if set up)
//   3. `which firefox` on PATH
//   4. Platform-specific well-known paths (macOS: /Applications/Firefox.app/...)
//
// Throws with a clear setup hint if nothing is found, so the failure mode
// for new contributors is "run `bun run test:rig:setup`" rather than a
// cryptic spawn ENOENT.

import { existsSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { homedir, platform } from "node:os";

const TEST_RIG_ROOT = join(
  process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"),
  "palefox-test-firefox",
);

/** Detect NixOS — we can't run Mozilla's foreign tarball directly, AND the
 *  wrapped Firefox at ~/.nix-profile/bin/firefox breaks Marionette (the
 *  wrapper applies sandboxing/env that prevents the Marionette server
 *  from binding its port). We prefer the unwrapped firefox-bin instead. */
function isNixOS(): boolean {
  return existsSync("/etc/NIXOS");
}

/** On NixOS, walk the wrapped Firefox's Nix closure to find the unwrapped
 *  firefox-bin. Marionette works against the unwrapped binary; the wrapper
 *  silently breaks it. Returns null if the closure can't be queried (no
 *  nix-store available, or wrapped path doesn't lead to a firefox-unwrapped
 *  derivation). */
function unwrappedFirefoxOnNixOS(wrappedPath: string): string | null {
  try {
    // Resolve wrapper symlink to the actual store path
    const realWrapped = execSync(`readlink -f ${wrappedPath}`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    // wrapped firefox lives at /nix/store/HASH-firefox-VERSION/bin/firefox
    // Strip back to the derivation root
    const drvRoot = realWrapped.replace(/\/bin\/firefox$/, "");
    // Query Nix for direct dependencies; the unwrapped firefox is one of them
    const refs = execSync(`nix-store -q --references ${drvRoot}`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim().split("\n");
    for (const ref of refs) {
      if (/firefox-unwrapped-[\d.]+$/.test(ref)) {
        const candidate = join(ref, "lib", "firefox", "firefox-bin");
        if (existsSync(candidate)) return candidate;
      }
    }
  } catch {
    // nix-store missing, readlink failed, no unwrapped in closure — fall through
  }
  return null;
}

/** Returns the absolute path to a usable Firefox binary, or throws. */
export function locateFirefox(): string {
  // 1. Explicit env-var override always wins. Useful for CI and for NixOS
  //    devs who want to point at a specific Firefox.
  if (process.env.FIREFOX_BIN) {
    if (existsSync(process.env.FIREFOX_BIN)) return process.env.FIREFOX_BIN;
    throw new Error(
      `FIREFOX_BIN is set to "${process.env.FIREFOX_BIN}" but the file does not exist. ` +
      `Unset the env var or point it at a real Firefox binary.`,
    );
  }

  // 2. Test rig (set up via `bun run test:rig:setup`). Pick the most-recent
  //    version subdirectory by lexicographic sort — version strings are
  //    sortable enough for our purposes.
  if (existsSync(TEST_RIG_ROOT)) {
    const versions = readdirSync(TEST_RIG_ROOT, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith("firefox-"))
      .map((e) => e.name)
      .sort()
      .reverse();
    for (const v of versions) {
      // Mozilla's tarball extracts to <root>/firefox-<version>/firefox/firefox
      const candidate = join(TEST_RIG_ROOT, v, "firefox", "firefox");
      if (existsSync(candidate)) return candidate;
    }
  }

  // 3. System Firefox via PATH lookup. On NixOS, the wrapper breaks
  //    Marionette — walk the Nix closure to find the unwrapped firefox-bin
  //    instead. On other systems, the PATH binary is fine.
  try {
    const wrapped = execSync("command -v firefox", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (wrapped && existsSync(wrapped)) {
      if (isNixOS()) {
        const unwrapped = unwrappedFirefoxOnNixOS(wrapped);
        if (unwrapped) return unwrapped;
        // Couldn't find unwrapped — return wrapped and hope (will likely
        // fail at Marionette connect, but the error message will be clearer
        // than throwing here).
      }
      return wrapped;
    }
  } catch {
    // command -v exits non-zero when not found; fall through.
  }

  // 4. Platform-specific fallbacks.
  if (platform() === "darwin") {
    const macBin = "/Applications/Firefox.app/Contents/MacOS/firefox";
    if (existsSync(macBin)) return macBin;
  }

  throw new Error(
    [
      "No Firefox binary found.",
      "",
      "Tried (in order):",
      `  1. $FIREFOX_BIN — not set`,
      `  2. Test rig at ${TEST_RIG_ROOT} — not present`,
      `  3. \`command -v firefox\` — not on PATH`,
      platform() === "darwin"
        ? `  4. /Applications/Firefox.app — not installed`
        : null,
      "",
      "Fix one of:",
      "  - Run `bun run test:rig:setup` to download a test-rig Firefox",
      "  - Set FIREFOX_BIN=/path/to/firefox in your environment",
      "  - Install Firefox so it's on PATH",
    ].filter(Boolean).join("\n"),
  );
}

/** Returns the test rig root path. Useful for the rig setup script. */
export function testRigRoot(): string {
  return TEST_RIG_ROOT;
}
