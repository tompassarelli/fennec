<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/logo.png" />
    <source media="(prefers-color-scheme: light)" srcset="docs/logo-light.png" />
    <img src="docs/logo.png" alt="Palefox logo" width="200" />
  </picture>

# Palefox

A developer-focused alternative to Zen Browser on upstream Firefox

</div>

![Default mode — vertical tabs, expanded layout](https://github.com/user-attachments/assets/9d89d845-e5c4-4fb4-ae9a-eb36da9ddde8)

![Vertical tabs — collapsed layout](https://github.com/user-attachments/assets/a5e4bc4c-f239-4b8d-8435-3150d4e7252e)

![Tiled in compact (zen) mode](https://github.com/user-attachments/assets/8a9e2552-6c91-412f-ad2b-e41274e2e2ac)

## Quick Install

> Please see [security considerations](#security) before installing

**macOS / Linux:**
```bash
curl -fsSL https://raw.githubusercontent.com/tompassarelli/palefox/main/install.sh -o /tmp/palefox-install.sh && bash /tmp/palefox-install.sh
```

**Windows** (PowerShell):
```powershell
irm https://raw.githubusercontent.com/tompassarelli/palefox/main/install.ps1 | iex
```

**LibreWolf:** add `--librewolf` to either command.

The installer pulls from the latest tagged release, not HEAD.

See the [full installation guide](docs/install.md) for manual install, flags, and details.

## Features

- **Compact mode** — sidebar autohides off-screen, revealed on left-edge hover with spring animation
- **Collapse layout** — sidebar shrinks to icons-only strip, toolbox returns to horizontal bar
- **Sidebar button** — left-click toggles compact mode, right-click opens layout options (compact, collapse, tab orientation)
- **Urlbar breakout** — expands past the sidebar when focused
- **Theme-respecting** — uses Firefox's native CSS variables, works with any theme
- Powered by [fx-autoconfig](https://github.com/MrOtherGuy/fx-autoconfig) for chrome JS

## Docs

- [Full installation guide](docs/install.md)
- [Nix / Home Manager](docs/nix.md)
- [Features & options](docs/features.md)
- [Customization](docs/customization.md)
- [Compact mode audit (Zen Browser comparison)](docs/compact-mode-zen-audit.md)
- [Contributing](CONTRIBUTING.md)

## Security

- Extensions are privileged software — install only ones you trust
- Review install scripts before piping them into your shell
- The JS loader runs chrome-privileged code — review scripts in `chrome/JS/` before use
> **Palefox is in beta.** It's stable enough for daily use and recommended to install from the latest release on `main`. Features are actively evolving — expect rough edges.

## Acknowledgments

Palefox draws inspiration from:

- [Zen Browser](https://zen-browser.app/) — compact mode state machine and sidebar design
- [GWfox](https://github.com/akkva/gwfox) — CSS theming techniques
- [FF-ULTIMA](https://github.com/soulhotel/FF-ULTIMA) — feature and layout ideas
- [parfait](https://github.com/reizumii/parfait) — findbar and accessibility
