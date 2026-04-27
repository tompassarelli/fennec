// Test rig: a separate Firefox install used only by palefox tests.
//
// Why: the palefox hash-pinned bootstrap must live in a Firefox install
// root (root-owned in production for security). For dev/test loops we
// want zero sudo and zero impact on the developer's daily Firefox. So
// we stand up a SECOND Firefox under ~/.cache/palefox-test-firefox/
// which is user-owned, ephemeral, and never used for actual browsing.
//
// Resolution flow:
//   - $NIX_FIREFOX_BIN set      → use that, don't download (NixOS path)
//   - /etc/NIXOS exists, no $NIX_FIREFOX_BIN  → bail with instructions
//   - Otherwise                 → download Mozilla's "latest stable"
//                                  Linux tarball, extract, cache by
//                                  version number reported by application.ini
//
// Bootstrap install is idempotent: every setup copies the freshly-built
// program/config.generated.js into the rig, so a `bun run build` followed
// by `bun run test:rig:setup` always lands the new bootstrap without sudo.
//
// CLI:
//   bun run tools/test-driver/firefox-rig.ts          # idempotent setup
//   bun run tools/test-driver/firefox-rig.ts --force  # re-download latest
//   bun run tools/test-driver/firefox-rig.ts --info   # print rig location

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { spawnSync, execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { testRigRoot } from "./firefox-locator.ts";

const MOZILLA_LATEST_LINUX = "https://download.mozilla.org/?product=firefox-latest&os=linux64&lang=en-US";

interface RigInfo {
  /** Absolute path to firefox binary inside the rig. */
  firefoxBin: string;
  /** Version string read from application.ini (e.g. "149.0.2"). */
  version: string;
  /** Root of THIS rig install (the firefox-<version>/ dir). */
  rigDir: string;
}

/** Detect NixOS — its pure environment can't run foreign Firefox tarballs. */
function isNixOS(): boolean {
  return existsSync("/etc/NIXOS");
}

/** Find an existing rig install, if any. Returns the most-recent by sort. */
function findExistingRig(): RigInfo | null {
  const root = testRigRoot();
  if (!existsSync(root)) return null;
  const versions = readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith("firefox-"))
    .map((e) => e.name)
    .sort()
    .reverse();
  for (const dirName of versions) {
    const rigDir = join(root, dirName);
    const firefoxBin = join(rigDir, "firefox", "firefox");
    if (existsSync(firefoxBin)) {
      const version = dirName.replace(/^firefox-/, "");
      return { firefoxBin, version, rigDir };
    }
  }
  return null;
}

/** Download Mozilla's latest-stable Linux tarball, extract, cache by version. */
async function downloadAndExtract(): Promise<RigInfo> {
  const root = testRigRoot();
  mkdirSync(root, { recursive: true });

  const tarballPath = join(root, "firefox-latest.tar.xz");

  // Stream-download via curl (handles the Mozilla redirect automatically).
  // We don't reach for fetch() because we want the redirect-following + the
  // resume-friendly download UX of curl on a slow connection.
  console.log(`Downloading Firefox (latest stable) from Mozilla...`);
  const dl = spawnSync(
    "curl",
    ["-fL", "--progress-bar", "-o", tarballPath, MOZILLA_LATEST_LINUX],
    { stdio: "inherit" },
  );
  if (dl.status !== 0) {
    throw new Error(`curl failed (exit ${dl.status}). Is curl installed and is the network up?`);
  }

  // Extract into a TEMP subdir, then move to firefox-<version>/ once we
  // know the version. The tarball's top-level dir is just "firefox/".
  const tempDir = join(root, ".extract-tmp");
  if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
  mkdirSync(tempDir);

  console.log(`Extracting...`);
  const ex = spawnSync("tar", ["-xJf", tarballPath, "-C", tempDir], { stdio: "inherit" });
  if (ex.status !== 0) {
    throw new Error(`tar failed (exit ${ex.status})`);
  }
  rmSync(tarballPath);

  // Read application.ini to find the actual version.
  const appIni = join(tempDir, "firefox", "application.ini");
  if (!existsSync(appIni)) {
    throw new Error(`Extracted tarball missing application.ini at ${appIni}`);
  }
  const versionMatch = readFileSync(appIni, "utf8").match(/^Version=(.+)$/m);
  if (!versionMatch) {
    throw new Error(`Could not parse Version= from ${appIni}`);
  }
  const version = versionMatch[1].trim();

  // Move into final position. If a rig for this version already exists
  // (e.g. --force re-download of same version), wipe and replace.
  const rigDir = join(root, `firefox-${version}`);
  if (existsSync(rigDir)) rmSync(rigDir, { recursive: true, force: true });
  mkdirSync(rigDir);
  // Move tempDir/firefox/ → rigDir/firefox/
  const mv = spawnSync("mv", [join(tempDir, "firefox"), join(rigDir, "firefox")], { stdio: "inherit" });
  if (mv.status !== 0) throw new Error(`mv failed (exit ${mv.status})`);
  rmSync(tempDir, { recursive: true, force: true });

  console.log(`✓ Test rig Firefox ${version} installed at ${rigDir}`);
  return {
    firefoxBin: join(rigDir, "firefox", "firefox"),
    version,
    rigDir,
  };
}

/** Copy palefox bootstrap + autoconfig prefs into the rig install. */
function installBootstrap(rigDir: string, palefoxRoot: string): void {
  const bootstrapSrc = join(palefoxRoot, "program", "config.generated.js");
  if (!existsSync(bootstrapSrc)) {
    throw new Error(
      `Bootstrap not found at ${bootstrapSrc}. Run \`bun run build\` first to generate it.`,
    );
  }

  // The rig's install root needs three things:
  //   1. config.js               — the bootstrap itself
  //   2. defaults/pref/config-prefs.js — palefox's autoconfig prefs (sandbox off, etc)
  //   3. defaults/pref/autoconfig.js   — points Firefox at config.js
  // Production installs (install.sh) only write 1 + 2 because the user's
  // distro Firefox already has an autoconfig.js. The unwrapped Nix Firefox
  // (and Mozilla tarball) DON'T ship one, so we add it ourselves.
  const ffDir = join(rigDir, "firefox");
  const prefDir = join(ffDir, "defaults", "pref");
  mkdirSync(prefDir, { recursive: true });

  const bootstrapDest = join(ffDir, "config.js");
  copyFileSync(bootstrapSrc, bootstrapDest);

  const configPrefsSrc = join(palefoxRoot, "program", "defaults", "pref", "config-prefs.js");
  const configPrefsDest = join(prefDir, "config-prefs.js");
  copyFileSync(configPrefsSrc, configPrefsDest);

  // Write autoconfig.js that points Firefox at config.js. This is what a
  // distro Firefox would normally ship (and is what install.sh relies on
  // existing). For the rig, we provide it ourselves.
  const autoconfigDest = join(prefDir, "autoconfig.js");
  const autoconfigContent = [
    'pref("general.config.filename", "config.js");',
    'pref("general.config.obscure_value", 0);',
    'pref("general.config.sandbox_enabled", false);',
    "",
  ].join("\n");
  // Use writeFileSync rather than copy so we control content exactly
  require("node:fs").writeFileSync(autoconfigDest, autoconfigContent);

  console.log(`✓ Bootstrap installed: ${bootstrapDest}`);
}

/** Find an unwrapped Firefox in the Nix store by walking the wrapper's
 *  closure. The wrapped Firefox (`firefox` binary in the wrap derivation)
 *  has a defaults/pref/autoconfig.js that the user's daily install
 *  probably depends on — on NixOS, it specifically points at
 *  /etc/firefox/palefox-bootstrap.js. We don't want THAT autoconfig in
 *  the test rig; we want a clean unwrapped Firefox we can configure
 *  ourselves. */
function findNixUnwrappedFirefox(): { srcRoot: string; version: string } | null {
  try {
    const wrapped = execSync("readlink -f $(command -v firefox)", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const drvRoot = wrapped.replace(/\/bin\/firefox$/, "");
    const refs = execSync(`nix-store -q --references ${drvRoot}`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim().split("\n");
    for (const ref of refs) {
      const m = ref.match(/firefox-unwrapped-([\d.]+)$/);
      if (m && existsSync(join(ref, "lib", "firefox", "firefox-bin"))) {
        return { srcRoot: join(ref, "lib", "firefox"), version: m[1] };
      }
    }
  } catch {
    // command -v / readlink / nix-store failed
  }
  return null;
}

/** Copy an unwrapped Nix-store Firefox into the rig path. Faster than
 *  downloading a tarball + we know it works on NixOS. */
function copyNixFirefoxToRig(srcRoot: string, version: string): RigInfo {
  const root = testRigRoot();
  mkdirSync(root, { recursive: true });
  const rigDir = join(root, `firefox-${version}`);
  if (existsSync(rigDir)) rmSync(rigDir, { recursive: true, force: true });
  mkdirSync(rigDir);
  console.log(`Copying Firefox ${version} from Nix store...`);
  // Use cp -L to dereference symlinks (so the rig is fully self-contained
  // and not dependent on /nix/store paths that might GC away later)
  const cp = spawnSync("cp", ["-rL", srcRoot, join(rigDir, "firefox")], { stdio: "inherit" });
  if (cp.status !== 0) {
    throw new Error(`cp from Nix store failed (exit ${cp.status})`);
  }
  // The copy is read-only because the source was read-only. Restore writable
  // bits on the things we'll need to modify (defaults/pref/, the install
  // root for our config.js).
  const chmod = spawnSync("chmod", ["-R", "u+w", rigDir], { stdio: "inherit" });
  if (chmod.status !== 0) {
    throw new Error(`chmod failed (exit ${chmod.status})`);
  }
  console.log(`✓ Test rig Firefox ${version} installed at ${rigDir}`);
  return {
    firefoxBin: join(rigDir, "firefox", "firefox-bin"),
    version,
    rigDir,
  };
}

/** Public API: ensure the rig exists, freshen the bootstrap, return info. */
export async function setupTestRig(opts: { force?: boolean } = {}): Promise<RigInfo> {
  let info: RigInfo | null = opts.force ? null : findExistingRig();
  if (!info) {
    if (isNixOS()) {
      // On NixOS, copy from the Nix-store unwrapped Firefox. We can't run
      // Mozilla's foreign tarball here without nix-ld. We can't use the
      // wrapped Firefox directly because its autoconfig setup interferes
      // with Marionette. Copying unwrapped firefox-bin gives us a clean
      // writable install root we can configure ourselves.
      const found = findNixUnwrappedFirefox();
      if (!found) {
        throw new Error([
          "NixOS detected, but couldn't find firefox-unwrapped in the closure",
          `of \`which firefox\`. Make sure Firefox is installed via your`,
          `system / home-manager config so its closure includes a`,
          `firefox-unwrapped derivation.`,
        ].join("\n"));
      }
      info = copyNixFirefoxToRig(found.srcRoot, found.version);
    } else {
      info = await downloadAndExtract();
    }
  } else {
    console.log(`Using existing test rig: Firefox ${info.version} at ${info.rigDir}`);
  }

  installBootstrap(info.rigDir, process.cwd());
  return info;
}

// CLI entrypoint
if (import.meta.main) {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const info = args.includes("--info") ? findExistingRig() : await setupTestRig({ force });
  if (args.includes("--info")) {
    if (!info) {
      console.log("No test rig installed. Run `bun run test:rig:setup`.");
      process.exit(1);
    }
    console.log(JSON.stringify(info, null, 2));
  }
}
