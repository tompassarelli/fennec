# Features & Options

## Sidebar Button (right-click menu)

Right-click the sidebar button (bottom of the sidebar) to access:

- **Enable/Disable Compact** — autohide sidebar off-screen, revealed on left-edge hover with spring animation
- **Expand/Collapse Layout** — toggle between full sidebar and icons-only strip
- **Horizontal/Vertical Tabs** — switch tab orientation
- **Customize Sidebar** — open Firefox's native sidebar settings

Left-click the sidebar button toggles compact mode directly.

## Compact Mode

When enabled, the sidebar slides off-screen and reappears when you hover the left edge. Popup menus and context menus keep the sidebar visible while open. The urlbar breakout still works — focus the urlbar and it expands past the sidebar.

Can also be toggled via `pfx.sidebar.compact` in `about:config`.

> **Linux users:** Set `widget.gtk.ignore-bogus-leave-notify` to `1` in `about:config`. Without this, GTK can send spurious leave events that cause the sidebar to collapse unexpectedly.

## about:config Options

| Pref | Default | Description |
|------|---------|-------------|
| `pfx.sidebar.compact` | `false` | Autohide sidebar, reveal on left-edge hover |
| `pfx.sidebar.menuBar` | `false` | Show the menu bar |
| `pfx.sidebar.newTab` | `false` | Show the new tab button in the sidebar |

## Accessibility

Palefox respects your OS "reduce motion" setting — all transitions become instant. On Linux you can also set `ui.prefersReducedMotion` to `1` in `about:config`.

## Recommended Extensions

**Vim-motions**
- **[Vimium](https://addons.mozilla.org/en-US/firefox/addon/vimium-ff/)** — old faithful
- **[Tridactyl](https://addons.mozilla.org/en-US/firefox/addon/tridactyl-vim/)** — an ambitious whippersnapper

**Other**
- **[New Tab Override](https://addons.mozilla.org/en-US/firefox/addon/new-tab-override/)** - Replace the default new tab page with a custom URL. Point it at a localhost service serving a barebones HTML page (without autofocus on the URL bar) so Vimium keybindings work immediately on new tabs

To get notified about new Palefox releases, [watch the GitHub repository](https://github.com/tompassarelli/palefox) and select "Releases only" under custom notifications.
