# Colors & theming

Palefox paints chrome surfaces (sidebar, toolbox, panel, popouts, etc.)
with its own `--pfx-*` palette instead of inheriting Firefox's
`--sidebar-background-color` / `--toolbar-bgcolor`. Why and how, below.

---

## Why we don't trust Firefox's variables by default

On Linux, Firefox's `--sidebar-background-color` ultimately falls back
to the `-moz-sidebar` system token, which GTK derives from `TextView`'s
background ([`nsLookAndFeel.cpp` ~ line 2434](https://searchfox.org/mozilla-central/source/widget/gtk/nsLookAndFeel.cpp)).
On non-Adwaita / minimal compositor setups (KDE without breeze-gtk,
Hyprland with no gtk theme installed, etc.) this resolves to a
*transparent* alpha-0 value.

That alone wouldn't be a problem — but the sidebar revamp + vertical
tabs preview writes a `lwtheme` attribute that makes
`var(--sidebar-background-color)` **resolve successfully** (to the
transparent token). CSS `var(...)` fallbacks only fire when the variable
is *unset*, not when it resolves to "see-through". With KWin /
Hyprland / Sway compositors that apply blur to non-fully-opaque pixels,
the desktop or page paints through the sidebar.

Bugzilla regression chain: [1971487](https://bugzilla.mozilla.org/show_bug.cgi?id=1971487),
[2006091](https://bugzilla.mozilla.org/show_bug.cgi?id=2006091),
[1860392](https://bugzilla.mozilla.org/show_bug.cgi?id=1860392).

To defeat this, our defaults are **literal `light-dark()` values** that
are guaranteed opaque and adapt to the system color scheme.

---

## The palette

Defined in `chrome/palefox.css` under the `palette` region:

| Variable                | Default (light)                | Default (dark)                  | Used by                                                |
| ----------------------- | ------------------------------ | ------------------------------- | ------------------------------------------------------ |
| `--pfx-bg`              | `#f9f9fb`                      | `#1c1b22`                       | Sidebar, navigator-toolbox, tab panel, pinned area     |
| `--pfx-bg-elevated`     | `#ffffff`                      | `#2b2a33`                       | Reserved for future hover / selected surfaces          |
| `--pfx-bg-popout`       | `#f9f9fb`                      | `#1c1b22`                       | Horizontal-mode tree popout cells                      |
| `--pfx-fg`              | `#15141a`                      | `#fbfbfe`                       | Reserved for future explicit text-color overrides      |
| `--pfx-fg-muted`        | `#5b5b66`                      | `#b0b0bb`                       | Reserved for dimmed text                               |
| `--pfx-border`          | `rgba(0, 0, 0, 0.12)`          | `rgba(255, 255, 255, 0.12)`     | Reserved for future explicit dividers                  |
| `--pfx-accent`          | `#0061e0`                      | `#00ddff`                       | Reserved for future highlights                         |

`color-scheme: light dark` is also pinned on `:root` so `light-dark()`
evaluates correctly and ancestor scheme inversions can't flip the look.

---

## Overriding colors

Put any of these in `chrome/user.css` (NOT overwritten on update) to
customize. Example — make the sidebar dark even in light mode:

```css
:root {
  --pfx-bg: #181818 !important;
  --pfx-bg-popout: #1f1f1f !important;
}
```

Or pin a specific accent:

```css
:root {
  --pfx-accent: #ff6188 !important;
}
```

You can use any valid CSS color (`rgb()`, `oklch()`, `light-dark()`,
hex, etc.). To set scheme-aware values yourself:

```css
:root {
  --pfx-bg: light-dark(#fafafa, #0a0a0a) !important;
}
```

---

## What gets shielded

Palefox stamps its palette over **every Firefox theme variable** the
chrome surfaces read — so a system theme manager (stylix, GNOME,
installed Firefox theme), an LWT, or `-moz-sidebar` system tokens
cannot leak through. The shield covers:

- Toolbar — `--toolbar-bgcolor`, `--toolbar-color`, `--toolbar-color-scheme`
- LWT base — `--lwt-accent-color`, `--lwt-accent-color-inactive`, `--lwt-text-color`
- Toolbar buttons — `--toolbarbutton-icon-fill`, `--toolbarbutton-icon-fill-attention`,
  `--toolbarbutton-hover-background`, `--toolbarbutton-active-background`,
  and the `--lwt-toolbarbutton-*` aliases
- Urlbar / search field — `--toolbar-field-background-color`,
  `--toolbar-field-color`, `--toolbar-field-border-color`, the
  `--toolbar-field-focus-*` family, the `--lwt-toolbar-field-*`
  aliases, plus `--urlbar-box-bgcolor` / `--urlbar-box-hover-bgcolor`
- Urlbar dropdown — `--urlbarView-background-color-selected`,
  `--urlbarView-text-color-selected`
- Sidebar — `--sidebar-background-color`, `--sidebar-text-color`,
  `--sidebar-border-color`, `--tabpanel-background-color`
- Tabs — `--tab-selected-bgcolor`, `--tab-selected-textcolor`,
  `--tab-loading-fill`, `--lwt-tab-line-color`, `--lwt-background-tab-separator-color`
- Separators — `--toolbarseparator-color`, `--tabs-navbar-separator-color`,
  `--chrome-content-separator-color`
- Popups — `--arrowpanel-background`, `--arrowpanel-color`, `--arrowpanel-border-color`

Each one resolves to one of the `--pfx-*` tokens above. Override the
`--pfx-*` to recolor the lot in one shot.

---

## Opting back into Firefox's theme variables

If you have a working Firefox theme (stylix, an installed Lightweight
Theme, GNOME-theme, etc.) and you want palefox to inherit from it:

```
about:config  →  pfx.theme.useSystem  →  true
```

This:

1. Lifts the shield (the `--toolbar-*` / `--lwt-*` / `--sidebar-*`
   overrides go away, Firefox's normal cascade applies).
2. Routes `--pfx-bg`, `--pfx-bg-popout`, `--pfx-bg-elevated`, `--pfx-fg`
   through `--sidebar-background-color` /
   `--toolbar-field-background-color` / `--sidebar-text-color`,
   falling back to the literal palette only when those return nothing.

Risky if your theme has the Linux GTK transparency bug — but useful
otherwise.

---

## When colors still look wrong

1. **Try `pfx.theme.useSystem=false`** (the default) — confirms our
   literal palette is taking effect.
2. **`mozilla.widget.use-argb-visuals = false`** in `about:config`,
   then restart. Disables Firefox's ARGB X11 / Wayland visual; if the
   sidebar suddenly becomes solid, your compositor was the cause and
   something downstream of palefox is still emitting a non-opaque pixel.
3. **Check Firefox version.** Bugzilla 1971487 was fixed in Firefox
   141, 2006091 in 146.0.1 / 147.0b5 / 148. Older builds have known
   sidebar contrast bugs unrelated to palefox.
4. **Disable any other userChrome.css patches** by moving `user.css`
   aside temporarily.
5. **Open an issue** with: Firefox version, OS / compositor, your
   `chrome/user.css` (if any), `~/.mozilla/firefox/<profile>/user.js`,
   and a screenshot of `about:support` "Graphics" section.
