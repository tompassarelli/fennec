// Tier 1 tests for helpers.ts (see docs/dev/testing.md).
//
// helpers.ts uses chrome globals (`gBrowser`, `Services`, `ChromeUtils`) and
// reaches into `state.panel.querySelectorAll(...)`. We don't need a real DOM
// to test the algorithmic surface — the relevant primitives are duck-typed:
//   - `nextElementSibling` chain → plain objects work
//   - `_tab` / `_group` decoration → plain objects work
//   - `gBrowser.tabs` → array of fake-Tab plain objects
//
// What's covered here:
//   treeData      — get-or-init + reads persisted pfx-id from XUL attribute
//   levelOf       — cycle-safe walk through treeOf
//                   numeric parentId chain
//                   string parentId (group) terminates with group.level + 1
//                   missing parent (orphaned) returns partial walk
//   levelOfRow    — polymorphic over _tab vs _group
//   dataOf        — polymorphic data access
//   subtreeRows   — level-based walk, stops at spacer or shallower row
//   hasChildren   — spacer-sentinel boundary
//
// What's NOT covered here (deferred to Tier 2):
//   tabUrl with SessionStore fallback (needs IOUtils-shaped mock)
//   allRows (needs querySelectorAll-shaped panel)

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { rowOf, state, treeOf } from "./state.ts";
import type { Row, Tab, TreeData } from "./types.ts";

// === Test scaffolding =========================================================

/** Build a fake tab with optional pfx-id attribute. The attribute storage
 *  must be a real Map so getAttribute/setAttribute round-trip; helpers.ts
 *  reads `pfx-id` via getAttribute in `treeData`. */
function fakeTab(opts: { pfxId?: number; label?: string } = {}): Tab {
  const attrs = new Map<string, string>();
  if (opts.pfxId != null) attrs.set("pfx-id", String(opts.pfxId));
  return {
    label: opts.label ?? "tab",
    getAttribute: (n: string) => attrs.get(n) ?? null,
    setAttribute: (n: string, v: string) => { attrs.set(n, v); },
    hasAttribute: (n: string) => attrs.has(n),
  } as unknown as Tab;
}

/** Build a fake row chain. Each row gets `nextElementSibling` pointing to the
 *  next, terminating at `state.spacer` so subtreeRows knows where to stop. */
function chainRows(rows: Row[]): Row[] {
  for (let i = 0; i < rows.length; i++) {
    (rows[i] as any).nextElementSibling = rows[i + 1] ?? state.spacer;
  }
  return rows;
}

function tabRow(tab: Tab): Row {
  return { _tab: tab } as unknown as Row;
}

function groupRow(opts: { id: string; level: number; name?: string }): Row {
  return {
    _group: {
      id: opts.id,
      type: "group" as const,
      name: opts.name ?? "Group",
      level: opts.level,
      state: null,
      collapsed: false,
    },
  } as unknown as Row;
}

/** Reset the shared mutable state between tests. WeakMaps don't have .clear(),
 *  but they're WeakMaps — once the test-scoped tab objects go out of scope at
 *  the next gc the entries are gone. We DO need to reset state.nextTabId. */
beforeEach(() => {
  state.nextTabId = 1;
  state.spacer = { __marker: "spacer" } as unknown as HTMLElement;
  state.panel = null as unknown as HTMLElement;
  state.pinnedContainer = null as unknown as HTMLElement;
});

// helpers.ts imports `gBrowser` and `Services` as declare-const globals.
// Stub them here so test calls don't ReferenceError. The Services stub is
// just enough for the pfx.debug logger gate (returns false → log is no-op).
beforeEach(() => {
  (globalThis as any).Services = {
    prefs: { getBoolPref: () => false },
    dirsvc: { get: () => ({ path: "/tmp" }) },
  };
  (globalThis as any).ChromeUtils = {
    // helpers.ts's top-level SS IIFE tries this if SessionStore isn't a
    // global. Return an object with a null SessionStore so SS becomes null
    // gracefully (rather than throwing on module init).
    importESModule: () => ({ SessionStore: null }),
  };
});

afterEach(() => {
  delete (globalThis as any).gBrowser;
  delete (globalThis as any).Services;
  delete (globalThis as any).ChromeUtils;
});

// === treeData =================================================================

describe("treeData", () => {
  test("first call assigns a fresh palefox-id and persists via setAttribute", async () => {
    const { treeData } = await import("./helpers.ts");
    const t = fakeTab(); // no persisted pfx-id
    state.nextTabId = 5;
    const d = treeData(t);
    expect(d.id).toBe(5);
    expect(state.nextTabId).toBe(6);
    // The pin call writes through setAttribute — verify the round-trip.
    expect(t.getAttribute("pfx-id")).toBe("5");
  });

  test("reuses persisted pfx-id and bumps nextTabId past it", async () => {
    const { treeData } = await import("./helpers.ts");
    const t = fakeTab({ pfxId: 100 });
    state.nextTabId = 1;
    const d = treeData(t);
    expect(d.id).toBe(100);
    // nextTabId must skip past 100 so a fresh tab can't collide.
    expect(state.nextTabId).toBe(101);
  });

  test("idempotent: second call returns the same TreeData instance", async () => {
    const { treeData } = await import("./helpers.ts");
    const t = fakeTab();
    const a = treeData(t);
    const b = treeData(t);
    expect(a).toBe(b);
  });

  test("freshly-assigned TreeData has parentId=null, name=null, collapsed=false", async () => {
    const { treeData } = await import("./helpers.ts");
    const t = fakeTab();
    const d = treeData(t);
    expect(d.parentId).toBeNull();
    expect(d.name).toBeNull();
    expect(d.state).toBeNull();
    expect(d.collapsed).toBe(false);
  });
});

// === levelOf ==================================================================

describe("levelOf", () => {
  test("root tab has level 0", async () => {
    const { levelOf } = await import("./helpers.ts");
    const a = fakeTab();
    treeOf.set(a, td(1));
    (globalThis as any).gBrowser = { tabs: [a] };
    expect(levelOf(a)).toBe(0);
  });

  test("walks numeric parentId chain", async () => {
    const { levelOf } = await import("./helpers.ts");
    const a = fakeTab();
    const b = fakeTab();
    const c = fakeTab();
    treeOf.set(a, td(1));
    treeOf.set(b, td(2, 1));   // child of a
    treeOf.set(c, td(3, 2));   // grandchild
    (globalThis as any).gBrowser = { tabs: [a, b, c] };
    expect(levelOf(a)).toBe(0);
    expect(levelOf(b)).toBe(1);
    expect(levelOf(c)).toBe(2);
  });

  test("cycle in parentId chain doesn't infinite-loop", async () => {
    const { levelOf } = await import("./helpers.ts");
    const a = fakeTab();
    const b = fakeTab();
    treeOf.set(a, td(1, 2)); // a → b
    treeOf.set(b, td(2, 1)); // b → a
    (globalThis as any).gBrowser = { tabs: [a, b] };
    // Should terminate via the seen-set; exact value matters less than not hanging.
    const lv = levelOf(a);
    expect(typeof lv).toBe("number");
    expect(lv).toBeGreaterThanOrEqual(0);
  });

  test("missing parent terminates the walk gracefully", async () => {
    const { levelOf } = await import("./helpers.ts");
    const a = fakeTab();
    treeOf.set(a, td(1, 999)); // parent id 999 doesn't exist
    (globalThis as any).gBrowser = { tabs: [a] };
    expect(levelOf(a)).toBe(0);
  });

  test("string parentId (group) → level = group.level + 1", async () => {
    const { levelOf } = await import("./helpers.ts");
    const a = fakeTab();
    treeOf.set(a, td(1, "g1"));
    // groupById walks allRows() which reads state.panel; we can shortcut
    // by setting up the panel with a queryable group.
    const grp = groupRow({ id: "g1", level: 2 });
    state.panel = makePanelWith([grp]);
    (globalThis as any).gBrowser = { tabs: [a] };
    expect(levelOf(a)).toBe(3); // 0 (lv) + 1 + 2 (group.level)
  });

  test("orphaned string parentId (group missing) terminates at lv=0", async () => {
    const { levelOf } = await import("./helpers.ts");
    const a = fakeTab();
    treeOf.set(a, td(1, "g-deleted"));
    state.panel = makePanelWith([]);
    (globalThis as any).gBrowser = { tabs: [a] };
    expect(levelOf(a)).toBe(0);
  });
});

// === levelOfRow ===============================================================

describe("levelOfRow", () => {
  test("null/undefined → 0", async () => {
    const { levelOfRow } = await import("./helpers.ts");
    expect(levelOfRow(null)).toBe(0);
    expect(levelOfRow(undefined)).toBe(0);
  });

  test("group row returns its stored level", async () => {
    const { levelOfRow } = await import("./helpers.ts");
    expect(levelOfRow(groupRow({ id: "g1", level: 4 }))).toBe(4);
  });

  test("tab row delegates to levelOf(tab)", async () => {
    const { levelOfRow } = await import("./helpers.ts");
    const a = fakeTab();
    const b = fakeTab();
    treeOf.set(a, td(1));
    treeOf.set(b, td(2, 1));
    (globalThis as any).gBrowser = { tabs: [a, b] };
    expect(levelOfRow(tabRow(a))).toBe(0);
    expect(levelOfRow(tabRow(b))).toBe(1);
  });
});

// === dataOf ===================================================================

describe("dataOf", () => {
  test("group row → returns the Group", async () => {
    const { dataOf } = await import("./helpers.ts");
    const r = groupRow({ id: "g1", level: 1, name: "X" });
    const d = dataOf(r);
    expect(d).not.toBeNull();
    expect((d as any).type).toBe("group");
    expect((d as any).name).toBe("X");
  });

  test("tab row → returns the TreeData (lazily initialized)", async () => {
    const { dataOf } = await import("./helpers.ts");
    const t = fakeTab();
    const d = dataOf(tabRow(t)) as TreeData;
    expect(d).not.toBeNull();
    expect(typeof d.id).toBe("number");
  });

  test("plain element with neither _tab nor _group → null", async () => {
    const { dataOf } = await import("./helpers.ts");
    expect(dataOf({} as unknown as Element)).toBeNull();
  });
});

// === subtreeRows / hasChildren ===============================================

describe("subtreeRows", () => {
  test("null row → []", async () => {
    const { subtreeRows } = await import("./helpers.ts");
    expect(subtreeRows(null)).toEqual([]);
    expect(subtreeRows(undefined)).toEqual([]);
  });

  test("collects rows with deeper level until stop or spacer", async () => {
    const { subtreeRows } = await import("./helpers.ts");
    const a = fakeTab();
    const b = fakeTab();
    const c = fakeTab();
    const d = fakeTab();
    treeOf.set(a, td(1));        // lv 0
    treeOf.set(b, td(2, 1));     // lv 1 (child of a)
    treeOf.set(c, td(3, 2));     // lv 2 (child of b)
    treeOf.set(d, td(4));        // lv 0 (back to root — should NOT be included)
    (globalThis as any).gBrowser = { tabs: [a, b, c, d] };
    const rows = chainRows([tabRow(a), tabRow(b), tabRow(c), tabRow(d)]);
    const out = subtreeRows(rows[0]!);
    expect(out).toHaveLength(3);
    expect(out[0]).toBe(rows[0]!);
    expect(out[1]).toBe(rows[1]!);
    expect(out[2]).toBe(rows[2]!);
  });

  test("stops at state.spacer sentinel", async () => {
    const { subtreeRows } = await import("./helpers.ts");
    const a = fakeTab();
    const b = fakeTab();
    treeOf.set(a, td(1));
    treeOf.set(b, td(2, 1));
    (globalThis as any).gBrowser = { tabs: [a, b] };
    const rows = chainRows([tabRow(a), tabRow(b)]);
    const out = subtreeRows(rows[0]!);
    // After rows[1] is the spacer; walk halts there. Output = [a, b].
    expect(out).toHaveLength(2);
  });

  test("singleton row (next is shallower) returns just the row", async () => {
    const { subtreeRows } = await import("./helpers.ts");
    const a = fakeTab();
    const b = fakeTab();
    treeOf.set(a, td(1));        // lv 0
    treeOf.set(b, td(2));        // lv 0 sibling
    (globalThis as any).gBrowser = { tabs: [a, b] };
    const rows = chainRows([tabRow(a), tabRow(b)]);
    expect(subtreeRows(rows[0]!)).toEqual([rows[0]!]);
  });

  test("polymorphic: traverses through groups", async () => {
    const { subtreeRows } = await import("./helpers.ts");
    const a = fakeTab();
    const b = fakeTab();
    treeOf.set(a, td(1));         // lv 0 (parent of group row at lv 1)
    treeOf.set(b, td(2, "g1"));   // lv = group.level + 1 = 2
    state.panel = makePanelWith([groupRow({ id: "g1", level: 1 })]);
    (globalThis as any).gBrowser = { tabs: [a, b] };
    const rows = chainRows([
      tabRow(a),                        // lv 0
      groupRow({ id: "g1", level: 1 }), // lv 1
      tabRow(b),                        // lv 2
    ]);
    const out = subtreeRows(rows[0]!);
    expect(out).toHaveLength(3);
  });
});

describe("hasChildren", () => {
  test("row followed by spacer → false", async () => {
    const { hasChildren } = await import("./helpers.ts");
    const a = fakeTab();
    treeOf.set(a, td(1));
    (globalThis as any).gBrowser = { tabs: [a] };
    const rows = chainRows([tabRow(a)]);
    expect(hasChildren(rows[0]!)).toBe(false);
  });

  test("row followed by deeper row → true", async () => {
    const { hasChildren } = await import("./helpers.ts");
    const a = fakeTab();
    const b = fakeTab();
    treeOf.set(a, td(1));
    treeOf.set(b, td(2, 1));
    (globalThis as any).gBrowser = { tabs: [a, b] };
    const rows = chainRows([tabRow(a), tabRow(b)]);
    expect(hasChildren(rows[0]!)).toBe(true);
  });

  test("row followed by sibling (same level) → false", async () => {
    const { hasChildren } = await import("./helpers.ts");
    const a = fakeTab();
    const b = fakeTab();
    treeOf.set(a, td(1));
    treeOf.set(b, td(2));
    (globalThis as any).gBrowser = { tabs: [a, b] };
    const rows = chainRows([tabRow(a), tabRow(b)]);
    expect(hasChildren(rows[0]!)).toBe(false);
  });
});

// === Helpers for fixture construction ========================================

function td(id: number, parentId: TreeData["parentId"] = null): TreeData {
  return { id, parentId, name: null, state: null, collapsed: false };
}

/** Build a state.panel-shaped object whose querySelectorAll returns the
 *  given rows. allRows() and groupById() consume this. */
function makePanelWith(rows: Row[]): HTMLElement {
  return {
    querySelectorAll: (_sel: string) => rows,
  } as unknown as HTMLElement;
}
