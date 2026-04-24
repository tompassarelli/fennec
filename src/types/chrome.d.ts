// Ambient declarations for the Mozilla chrome scripting environment.
//
// fx-autoconfig loads .uc.js files into the Firefox browser window's privileged
// chrome scope, where these globals are available without import. We declare
// them as `any` for now — the priority is unblocking type-checking on real
// code, not modeling the entire XPCOM/JS-component world. Tighten specific
// shapes here as palefox files surface footguns we'd like the checker to catch.

export {};

declare global {
  // XPCOM accessors (Components shorthand).
  const Cc: any;
  const Ci: any;
  const Cu: any;

  // Service singletons.
  const Services: any;
  const ChromeUtils: any;

  // File / path I/O (chrome-only fast IO modules).
  const IOUtils: any;
  const PathUtils: any;

  // Browser singletons / well-known objects exposed in browser.xhtml.
  const gBrowser: any;
  const gBrowserInit: any;
  const gURLBar: any;
  const gNavToolbox: any;

  // Session restore + tab metadata persistence.
  const SessionStore: any;

  // Native context menus we sometimes piggyback on.
  const TabContextMenu: any;

  // Various global helpers exposed by browser components.
  const PlacesCommandHook: any;
  const FirefoxViewHandler: any;

  // Firefox WebExtension API surface — only available in some contexts; here
  // we type it loosely so palefox code can opportunistically reach for it.
  const browser: any;

  // XUL element factories live on Document in the chrome scope.
  interface Document {
    createXULElement(tag: string): any;
  }
}
