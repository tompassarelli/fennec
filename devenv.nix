{ pkgs, ... }:

{
  # Build/dev tools for palefox: TypeScript -> bundled .uc.js for fx-autoconfig.
  # Bun handles both package management and bundling (bun build --format=iife).
  # tsc is provided per-workspace via bun catalog if/when we add it; nothing
  # global is required here beyond bun itself.
  packages = [
    pkgs.bun
  ];
}
