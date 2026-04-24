// Entries that get bundled into chrome/JS/<name>.uc.js for fx-autoconfig.
// Each entry must produce a valid .uc.js with a UserScript header banner.

export type Entry = {
  /** TypeScript source path, relative to repo root. */
  src: string;
  /** Output basename (no path); written into chrome/JS/. */
  out: string;
  /** UserScript-format header injected at the top of the bundled output. */
  banner: string;
};

export const entries: Entry[] = [
  {
    src: "src/hello/index.ts",
    out: "palefox-hello.uc.js",
    banner: [
      "// ==UserScript==",
      "// @name           Palefox Hello",
      "// @description    Confirms fx-autoconfig is working",
      "// @include        main",
      "// @onlyonce",
      "// ==/UserScript==",
    ].join("\n"),
  },
  {
    src: "src/drawer/index.ts",
    out: "palefox-drawer.uc.js",
    banner: [
      "// ==UserScript==",
      "// @name           Palefox Drawer",
      "// @description    Manages sidebar layout, compact mode, and toolbar positioning",
      "// @include        main",
      "// ==/UserScript==",
    ].join("\n"),
  },
];
