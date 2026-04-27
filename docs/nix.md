# Nix / Home Manager

Palefox can be installed declaratively via a Home Manager module — this
handles CSS, prefs, and Sideberry in one step. JS loader (the
hash-pinned bootstrap) requires a small NixOS module; the pattern is
documented below.

For the full build pipeline, runtime model, security architecture, and
why we don't ship a hot-reload pattern that touches your daily Firefox,
see [`docs/dev/loader-pipeline.md`](dev/loader-pipeline.md).

## Quick start (CSS only, via Home Manager)

1. Add palefox to your flake inputs:
```nix
inputs.palefox.url = "github:tompassarelli/palefox";
```

2. Import the module in your Home Manager config:
```nix
imports = [ inputs.palefox.homeManagerModules.default ];
```

3. Enable it:
```nix
programs.palefox = {
  enable = true;
  profile = "your-profile-name";  # optional, defaults to "default-release"
  autohide = false;               # optional
  # jsLoader = true;              # see "JS loader (hash-pinned)" below
};
```

4. Rebuild with `nixos-rebuild switch` or `home-manager switch`

> Note: Sideberry is installed automatically via [NUR](https://github.com/nix-community/NUR). Ensure NUR is in your flake inputs and overlays. Set `sideberry = false` if you manage extensions separately.

## JS loader (hash-pinned bootstrap) on NixOS

NixOS needs a different install path than the `install.sh` flow because
the Firefox install root lives in `/nix/store/` (read-only). The pattern
below bakes the bootstrap into the Nix-store derivation directly — full
security model (immutable bootstrap), one `nixos-rebuild switch` per
palefox release.

For dev iteration (changing palefox source and reloading) you DO NOT
use this Firefox; you use the test rig (see "Dev workflow" below). Your
daily Firefox stays put with whatever palefox version you've baked in.

**Pattern (drop-in NixOS module):**

```nix
{ config, lib, pkgs, inputs, ... }:
let
  username = "your-username";
  palefoxRoot = "/home/${username}/code/palefox";

  # Wrap Firefox: bake palefox's hash-pinned bootstrap into the Nix-store
  # derivation. This requires program/config.generated.js to exist (run
  # `bun run build` in palefoxRoot before the nixos-rebuild). The bootstrap
  # is read at evaluation time and embedded into the wrapped Firefox's
  # install root — fully immutable, attacker-as-user can't touch it.
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
in
{
  programs.firefox = { enable = true; package = palefoxFirefox; };

  home-manager.users.${username} = { config, ... }: {
    programs.firefox = {
      enable = true;
      package = palefoxFirefox;
      profiles.${username}.settings = {
        "toolkit.legacyUserProfileCustomizations.stylesheets" = false;
        "userChromeJS.enabled" = true;
      };
    };
    # palefox chrome/ tree → profile chrome/ via out-of-store symlink so
    # the live source is what loads (hashes still validated at startup).
    home.file.".mozilla/firefox/${username}/chrome".source =
      config.lib.file.mkOutOfStoreSymlink "${palefoxRoot}/chrome";
  };
}
```

**Daily Firefox upgrade workflow** (rare — once per palefox release):

```bash
cd ~/code/palefox
git pull          # or git checkout <new-tag>
bun run build     # regenerates program/config.generated.js with new hashes
sudo nixos-rebuild switch
# Restart Firefox, palefox loads with the new build.
```

## Dev workflow (no nixos-rebuild per change)

For iterating on palefox source — editing src/, chrome/CSS/, etc. — use
the test rig. NOT your daily Firefox.

```bash
cd ~/code/palefox
bun run test:rig:setup        # one-time: copies firefox-unwrapped from your Nix store
bun run test:integration      # builds, installs bootstrap to rig, runs all tests
bun run test:rig              # interactive Firefox window in a temp profile
```

How it works on NixOS specifically:
- Mozilla's foreign Firefox tarball can't run on NixOS without nix-ld.
- So the rig setup walks the Nix closure of your wrapped Firefox to find
  the `firefox-unwrapped` derivation, copies its `lib/firefox/` tree
  into `~/.cache/palefox-test-firefox/firefox-<version>/`, and writes
  the bootstrap + autoconfig prefs there.
- This rig install is user-owned. No sudo. No nixos-rebuild.
- Each test run uses a fresh ephemeral profile under `/tmp/palefox-test-XXXXXX/`,
  so your daily Firefox profile is never involved.

To upgrade the rig to a newer Firefox: `bun run test:rig:setup --force`
re-copies from whatever firefox-unwrapped is currently in your closure.
(Your daily Firefox upgrade via `nixos-rebuild` will pull a new
firefox-unwrapped automatically.)

## Threat model and security

The hash-pinned bootstrap closes the local-write attack surface that
vanilla fx-autoconfig leaves open. Specifically: an attacker running as
your user (compromised npm package, malicious dev tool) can't drop a
`.uc.js` into your profile and have it execute with chrome privileges,
because the bootstrap rejects any file not in its baked-in manifest,
and the bootstrap itself lives in `/nix/store/` (immutable).

Full threat model: [`docs/dev/sandbox-research.md`](dev/sandbox-research.md).
Architecture deep-dive: [`docs/dev/loader-pipeline.md`](dev/loader-pipeline.md).

**Personal customization** is not supported — the bootstrap rejects
unknown `.uc.js`/`.uc.css` files in the watched directories. Add your
own scripts/styles by editing the palefox source tree directly (then
`bun run build` regenerates the hash manifest), or use the
[`css-legacy`](https://github.com/tompassarelli/palefox/tree/css-legacy)
branch (CSS-only, no loader, no hash gate, supports drop-in CSS files).
