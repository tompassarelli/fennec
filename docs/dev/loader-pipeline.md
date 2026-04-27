# palefox loader pipeline — build, runtime, security, dev workflows

This is the load-bearing reference doc for palefox's safer JS loader.
If you're trying to understand how the chrome-privileged JS gets into
Firefox, what the security model is, why we made the tradeoffs we did,
or how to set up a dev loop that doesn't compromise your daily browser
— start here.

Sister docs:
- [`sandbox-research.md`](./sandbox-research.md) — the threat model + the
  options inventory we considered before settling on hash-pinning. Read
  if you want the "why this approach" backing material.
- [`loader-implementation.md`](./loader-implementation.md) — the
  implementation plan for the original safer-js-loader work.

---

## TL;DR

palefox ships a hash-pinned bootstrap that replaces fx-autoconfig's
permissive loader. The bootstrap (a single ~150-line JS file) lives in
your Firefox install root (root-owned territory), reads every file in
your profile's `chrome/{utils,JS,CSS}/` at startup, computes SHA-256 of
each, and refuses to load palefox at all if any file is missing,
modified, or unexpected. Because the bootstrap itself is in
root-owned territory, an attacker running as your user can't bypass the
gate: writing into your home directory no longer lets them inject
chrome-privileged JS into Firefox.

For dev work, palefox provides a separate "test rig" Firefox at
`~/.cache/palefox-test-firefox/`, user-owned, used only by tests and
manual validation. Your daily Firefox is never touched by the dev loop.

This doc covers all the pieces.

---

## 1. Build pipeline

`bun run build` does three things:

```
src/<area>/index.ts          ──[ bun bundle ]──>  chrome/JS/palefox-<area>.uc.js
chrome/{utils,JS,CSS}/*      ──[ SHA-256 hash ]──>  hash manifest
program/config.template.js   ──[ substitute ]───>  program/config.generated.js
                                                   (template + manifest baked in)
```

In code:

- [`build.ts`](../../build.ts) bundles the `.uc.js` outputs from the
  TypeScript sources via `Bun.build`. Then it imports
  `tools/generate-bootstrap.ts` which:
- [`tools/generate-bootstrap.ts`](../../tools/generate-bootstrap.ts)
  walks `chrome/utils/`, `chrome/JS/`, and `chrome/CSS/`, computes
  SHA-256 of each matching file, builds a `{ "subdir/filename":
  "sha256-base64hash" }` map, and substitutes that JSON into
  `program/config.template.js` at the `__PALEFOX_PINNED__` placeholder.
- The output is `program/config.generated.js` — the bootstrap with the
  current build's hashes baked in. This file is gitignored; it's
  regenerated on every build.

The hash manifest's domain is intentionally narrow: only files in those
three watched directories. That's what fx-autoconfig will load. CSS
files in `chrome/` root, `userChrome.css`, etc. are NOT in the manifest
because they're NOT loaded by the new architecture (the legacy
stylesheet pref is force-disabled at install time).

## 2. Runtime sequence — what happens when Firefox starts

```
                ┌──────────────────┐
                │ Firefox starts   │
                └────────┬─────────┘
                         │
                         ▼
        ┌────────────────────────────────────┐
        │  Reads autoconfig.js from install  │
        │  root: general.config.filename     │
        │  → "config.js" (or                 │
        │     "palefox-bootstrap.js" on Nix) │
        └────────────────┬───────────────────┘
                         │
                         ▼
        ┌────────────────────────────────────┐
        │  Loads <install root>/<filename>   │
        │  with full system principal —      │
        │  this IS the bootstrap.            │
        └────────────────┬───────────────────┘
                         │
                         ▼
        ┌────────────────────────────────────┐
        │  Bootstrap iterates the profile's  │
        │  chrome/{utils,JS,CSS}/, SHA-256s  │
        │  every file, compares to the       │
        │  PALEFOX_PINNED manifest baked in. │
        └────┬───────────────┬───────────────┘
             │ all match     │ ANY mismatch / extra / missing
             │               │
             ▼               ▼
   ┌─────────────────┐  ┌─────────────────────────┐
   │  Chain to       │  │  Cu.reportError         │
   │  fx-autoconfig  │  │  with details, throw,   │
   │  boot.sys.mjs.  │  │  bootstrap exits.       │
   │  Loads palefox  │  │  Firefox continues      │
   │  scripts + CSS  │  │  normally without       │
   │  registers them │  │  palefox.               │
   │  as            │  │                         │
   │  chrome://      │  │  Browser Console shows  │
   │  resources.    │  │  the rejection reason.  │
   └─────────────────┘  └─────────────────────────┘
```

**The "fail-closed" property is the whole game.** Vanilla fx-autoconfig
is fail-open: any `.uc.js` in `chrome/JS/` runs. Hash-pinned bootstrap
is fail-closed: a single unknown or modified file means **NOTHING runs,
including palefox itself**. If a regression in the bootstrap ever flips
this to fail-open, the integration tests
([`tests/integration/bootstrap-hash.ts`](../../tests/integration/bootstrap-hash.ts))
will catch it on the next CI run.

The fail-closed behavior IS partially user-hostile — if you tamper with
your own files (even as a curious experiment), palefox just stops
working. There's no warning beyond a Browser Console message. That's
deliberate: silent partial loading would be the worst of both worlds.

## 3. Security model

### What's being defended

Vanilla fx-autoconfig has a known attack surface (acknowledged in the
fx-autoconfig README itself): a process running as you — a compromised
npm package, a malicious dev tool, an `eval()` in a browser tab that
escapes via some XSS chain — can write a file to
`<profile>/chrome/JS/evil.uc.js`, and that file will load with full
chrome privileges on next Firefox startup. The attacker can read every
tab, every cookie, every saved password, and call any privileged API
Firefox itself can call.

The hash-pinned bootstrap closes this gap. The bootstrap rejects any
file in the watched directories that isn't in its baked-in manifest.
Even if the attacker writes `evil.uc.js`, the bootstrap detects an
unexpected file and refuses to start the loader at all (palefox itself
fails to load, which is a much louder signal than evil.uc.js silently
running).

### The three pieces of the loader chain

For palefox JS to execute, all three of these have to be in place:

1. **Install-root autoconfig bootstrap** (e.g. `/usr/lib/firefox/config.js`,
   `/etc/firefox/palefox-bootstrap.js`) — root-owned. Attacker as you
   can't write here.
2. **Profile loader machinery** (`<profile>/chrome/utils/`) — user-writable.
   But the bootstrap hash-checks every file here. Modify any one →
   hash mismatch → bootstrap bails.
3. **The loader gate pref** (`userChromeJS.enabled = true` in user.js) —
   user-writable. But without #1 and #2, this pref is inert.

The attack surface is the intersection of all three. **Removing any one
closes the loader chain.** That's why `uninstall-fx-autoconfig.sh`
removes #1 + #2 + strips the `userChromeJS.enabled` line from user.js
(belt and suspenders).

### What this DOESN'T protect against

This is honest scope-setting. The hash-pinning gate addresses the
"local user-mode malware writes to your home dir" attacker class. It
does NOT address:

- **Root-level malware.** If something gets root, it can replace the
  bootstrap itself. There's no defense the userspace bootstrap can
  mount against this; it's outside our threat model.
- **Compromised palefox upstream.** If a malicious commit lands in
  palefox's main branch and you `bun install && ./install.sh` it, the
  hashes match the malicious code by construction. The defense here is
  code review + `git log`, not the loader. Layered countermeasure:
  Sigstore / GitHub Artifact Attestations on release artifacts (see §6
  for the v2 path).
- **Compromised build pipeline.** A backdoored Bun binary, a malicious
  npm package in your build closure, a CI runner that signs the wrong
  artifacts — these all make the build output untrustworthy regardless
  of the hash gate. Layered countermeasure: SLSA-style build provenance
  (out of scope today).
- **Kernel-level tampering with `nsCryptoHash`'s output.** Yes,
  cryptographically you can't construct a SHA-256 collision. No, this
  doesn't matter if a kernel rootkit is patching the syscall.

The point: hash-pinning IS the right gate for the threat we have. It's
not the only possible gate. Layering more is fine if the project grows;
the v2 roadmap below covers what that would look like.

### Threat model precedents

Why hasn't anyone solved this in the userChrome ecosystem before?
[`sandbox-research.md`](./sandbox-research.md) has the survey. Short
version:

- **fx-autoconfig** (the loader we're replacing) explicitly acknowledges
  the attack in its README: "malicious external programs can now inject
  custom logic to Firefox even without elevated privileges." It accepts
  the risk as a design tradeoff.
- **xiaoxiaoflood, alice0775, benzbrake** — same loading pattern, no
  verification.
- **Firefox forks** (Floorp, Zen, LibreWolf) sidestep the problem by
  going CSS-only, eliminating profile-side JS as an attack vector.
- **Hardened browsers** (Mullvad, Tor) bundle pre-signed extensions in
  the binary itself, no profile-side loading.
- **Hash-pinning at the bootstrap level is, as far as we can tell,
  novel.** No community loader implements it. Not because it's hard —
  it's ~50 lines of XPCOM — but because the cohort of "people who
  customize chrome JS" overlaps poorly with the cohort of "people who
  worry about local malware." palefox sits in the intersection.

## 4. Dev workflows

### The two-Firefox model

The single most important thing to internalize: **palefox dev work
happens against a TEST RIG Firefox, not your daily Firefox**. The two
are completely independent.

| | Daily Firefox | Test rig Firefox |
|---|---|---|
| Path | `/usr/lib/firefox/` (Ubuntu), `/nix/store/...` (NixOS), `/Applications/Firefox.app/` (macOS) | `~/.cache/palefox-test-firefox/firefox-<version>/` |
| Owner | root (or Nix store, immutable) | you |
| Bootstrap install | `sudo install.sh` once per palefox release | `bun run test:rig:setup` (no sudo, idempotent) |
| Profile | `~/.mozilla/firefox/<your-default>/` — your real bookmarks, history, passwords | `/tmp/palefox-XXXXXX/` — ephemeral, deleted after use |
| Used for | Actually browsing the web | Running tests, manual validation, palefox iteration |
| Updated | When you `./install.sh` a new palefox release | Every `bun run build`, no sudo |
| Affected by dev loop | NO — the test rig is the boundary | Yes — that's its job |

### Workflow: normal Linux user (Ubuntu, Mozilla PPA)

**One-time daily-Firefox install** (sudo prompt for the install-root copy):
```bash
cd ~/code/palefox
git checkout <branch-or-tag>
bun install
bun run build
./install.sh
# Sudo prompt for /usr/lib/firefox/config.js + defaults/pref/config-prefs.js
# Restart your daily Firefox. palefox loads.
```

Re-run `./install.sh` when you want to upgrade the daily Firefox to a
new palefox release. NOT when you're iterating on palefox source.

**Daily dev iteration** (no sudo, doesn't touch daily Firefox):
```bash
# Edit palefox source (src/, chrome/CSS/, etc.)
bun run test:integration   # builds, sets up rig, runs all tests
# OR for an interactive Firefox to play with:
bun run test:rig
# Tampering, validating new features, watching Browser Console — all in
# the rig, fully isolated from your daily browser.
```

The first `bun run test:integration` downloads Mozilla's latest stable
Firefox tarball to `~/.cache/palefox-test-firefox/` (~150MB, one-time).
Subsequent runs reuse the cached install.

### Workflow: NixOS user

**One-time daily-Firefox install** via your NixOS module:
```nix
# In your hosts/<host>/configuration.nix or modules/firefox/palefox.nix
{ inputs, pkgs, ... }: let
  palefoxRoot = "/home/tom/code/palefox";
  palefoxFirefox = pkgs.firefox.overrideAttrs (old: {
    buildCommand = (old.buildCommand or "") + ''
      cat >> "$out/lib/firefox/defaults/pref/autoconfig.js" <<'EOF'
      pref("general.config.filename", "config.js");
      pref("general.config.sandbox_enabled", false);
      EOF
      cp "${palefoxRoot}/program/config.generated.js" \
        "$out/lib/firefox/config.js"
    '';
  });
in {
  programs.firefox = { enable = true; package = palefoxFirefox; };
}
```

Then `sudo nixos-rebuild switch`. The bootstrap is baked into the Nix
store derivation (immutable, cryptographically named — full security
model).

When palefox releases a new version, re-run `nixos-rebuild switch` (it
rebuilds with the new `config.generated.js`).

**Daily dev iteration** (no sudo, no nixos-rebuild):
```bash
cd ~/code/palefox
bun run test:integration   # builds, sets up rig (copies firefox-unwrapped from Nix store), runs
bun run test:rig           # interactive
```

The rig setup detects NixOS, walks the closure of your wrapped
Firefox to find `firefox-unwrapped`, and copies that into
`~/.cache/palefox-test-firefox/firefox-<version>/`. No tarball download
(NixOS can't run Mozilla's foreign binary), no sudo. ~200MB on first
run, instant on subsequent runs.

### Workflow: macOS user

Daily install:
```bash
cd ~/code/palefox
bun run build
./install.sh
# Sudo prompt for /Applications/Firefox.app/Contents/Resources/config.js
```

Daily dev iteration: same as Linux user — `bun run test:integration` /
`bun run test:rig`. The rig downloads Mozilla's macOS DMG / tarball.
(Mozilla's macOS distribution is a DMG, which `firefox-rig.ts` handles
on macOS by mounting the DMG and copying the .app contents.)

> **Caveat:** macOS path of `firefox-rig.ts` is less battle-tested than
> Linux. If the DMG handling fails for you, set `FIREFOX_BIN` to point
> at a separate Firefox install you maintain for testing, OR use the
> system Firefox via `--use-system-firefox` (skips the rig entirely;
> note the bootstrap-hash test will fail because the system Firefox
> doesn't have your freshly-built bootstrap installed).

## 5. The hot-reload tradeoff (and why we don't ship it)

You might wonder: "Why does the daily-install path need sudo at all?
Can't we just symlink the install-root bootstrap to the build output
in `~/code/palefox/`?"

That's the "hot-reload" pattern, and it's tempting. But:

- The install-root bootstrap MUST live in a location an attacker
  running as you cannot write to. That's the entire security
  argument.
- A symlink at `/etc/firefox/palefox-bootstrap.js → ~/code/palefox/program/config.generated.js`
  has the SYMLINK in root-owned territory, but the SYMLINK TARGET is
  user-writable. Attacker writes a permissive bootstrap to the target,
  Firefox reads it, gate is bypassed.
- The symlink approach was investigated and rejected — see [git log of
  `nix/module.nix`] for the previous version that had this hole.

The clean answer is the two-Firefox model: daily Firefox gets the
sudo'd install (rare, secure), test rig gets the user-owned dev loop
(frequent, no sudo, isolated from your real browser). This trades a
one-time sudo per palefox release for full security; in practice
"sudo per palefox release" is approximately as frequent as
"sudo per Firefox upgrade" — i.e. every few weeks.

If the one-sudo-per-release ever becomes painful (multi-developer team,
constant releases, etc.), the v2 path is crypto signing — see §6.

## 6. v2 roadmap (not built today)

These are documented for future-us. Don't implement until needed.

### v2.1 — Crypto signing

If we want to remove the one-sudo-per-release for the daily install,
crypto signing is the answer. Architecture:

- **Build-time**: `bun run build` signs `config.generated.js` with an
  ed25519 private key (held in user's `ssh-agent`).
- **Install-time**: a root-owned daemon (systemd path unit) watches the
  signed file, verifies the signature against a public key baked into
  the daemon's config (root-owned), and only installs if valid.
- **Runtime**: same as today — Firefox reads the bootstrap, runs hash
  check, loads palefox.

The signature gate replaces the "manual sudo per release" with "anyone
with the private key can publish, daemon enforces." Multi-dev teams get
a smooth release cadence; security model stays intact (attacker without
the key can't poison the install).

Cost: ~3-4 days of work to implement (daemon + key management +
build-script changes + docs). Skip until needed.

The research backing this: [`sandbox-research.md`](./sandbox-research.md)
section "Option E + crypto signing" considers this in depth. The TL;DR
is "feasible, well-understood, similar to kernel module signing
(mokutil), but overkill for v1."

### v2.2 — End-user declarative install

Today's palefox install model assumes you have a clone of the source.
For NixOS/Home Manager users who want a "set it and forget it" install
via flake input (`palefox.url = "github:tompassarelli/palefox"`), we'd
need to ship `program/config.generated.js` with the flake. Currently
gitignored.

Options:
1. **Un-gitignore `config.generated.js`**: contributors run
   `bun run build` and commit the regenerated file. Pre-commit hook
   enforces. Smallest delta.
2. **Build inside a Nix derivation**: flake exposes a `palefox`
   package whose build step is `bun install && bun run build`. Cleaner
   but adds bun + the build step to the flake's build closure.
3. **CI auto-commits**: GitHub Actions builds and pushes the
   regenerated file. Removes contributor friction; requires CI write
   access.

Skip until we have actual end users on Nix who want this.

### v2.3 — Sigstore / artifact attestations on release tarballs

Defends against compromised CDN / GitHub releases serving a tampered
tarball. Independent of the in-browser threat model. Free for OSS via
GitHub Actions + Sigstore's public-good instance.

Skip until we have a stable release cadence worth attesting.

## 7. Where the code lives (file map)

| Concern | File |
|---|---|
| Bootstrap template | [`program/config.template.js`](../../program/config.template.js) |
| Build-time hash generator | [`tools/generate-bootstrap.ts`](../../tools/generate-bootstrap.ts) |
| Build pipeline | [`build.ts`](../../build.ts) |
| Daily install (Linux/macOS) | [`install.sh`](../../install.sh) |
| Daily install (Windows) | [`install.ps1`](../../install.ps1) |
| Removing the legacy fx-autoconfig | [`uninstall-fx-autoconfig.sh`](../../uninstall-fx-autoconfig.sh) / `.ps1` |
| Test rig setup | [`tools/test-driver/firefox-rig.ts`](../../tools/test-driver/firefox-rig.ts) |
| Test rig binary locator | [`tools/test-driver/firefox-locator.ts`](../../tools/test-driver/firefox-locator.ts) |
| Interactive rig launcher | [`tools/test-driver/interactive-rig.ts`](../../tools/test-driver/interactive-rig.ts) |
| Integration test runner | [`tools/test-driver/runner.ts`](../../tools/test-driver/runner.ts) |
| Hash-pinning verification tests | [`tests/integration/bootstrap-hash.ts`](../../tests/integration/bootstrap-hash.ts) |
| Threat model + options inventory | [`sandbox-research.md`](./sandbox-research.md) |
| Original implementation plan | [`loader-implementation.md`](./loader-implementation.md) |

## 8. Verification commands (post-install)

After `./install.sh` (Linux):
```bash
# Bootstrap installed?
test -f /usr/lib/firefox/config.js && echo "✓ bootstrap present"
# Is it the hash-pinned variant (vs vanilla fx-autoconfig)?
grep -q PALEFOX_PINNED /usr/lib/firefox/config.js && echo "✓ hash-pinned"
# Prefs flipped correctly?
grep -q 'userChromeJS.enabled.*true' ~/.mozilla/firefox/<profile>/user.js
grep -q 'toolkit.legacyUserProfileCustomizations.stylesheets.*false' ~/.mozilla/firefox/<profile>/user.js
```

After `bun run test:rig:setup`:
```bash
# Rig present?
ls ~/.cache/palefox-test-firefox/firefox-*/firefox/firefox-bin
# Bootstrap present in rig?
grep -q PALEFOX_PINNED ~/.cache/palefox-test-firefox/firefox-*/firefox/config.js && echo "✓ rig has hash-pinned bootstrap"
```

To exercise the gate manually:
```bash
bun run test:rig
# In another shell, with the rig Firefox running:
PROF=/tmp/palefox-rig-XXXXX  # path printed by test:rig
echo "// tamper" >> $PROF/chrome/JS/palefox-tabs.uc.js
# Close + reopen Firefox via test:rig. Browser Console (Ctrl+Shift+J) should show:
#   palefox: hash mismatch on JS/palefox-tabs.uc.js
#   expected: sha256-...
#   actual:   sha256-...
# palefox should NOT load (no sidebar, no keymap).
```
