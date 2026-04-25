# Palefox multi-session architecture

This document is the architectural plan for palefox's multi-session history
feature, generated from a research dive across Firefox SessionStore source
(~/code/firefox/browser/components/sessionstore/), Sidebery / TST / Zen
implementations, and our existing single-session persistence.

Read this before touching `src/tabs/persist.ts` or session-restore code.

---

## Vision (from user)

> Store the last N sessions I've had. `:restore` shows date-sorted sessions,
> optionally searchable by URL/text within sessions. Restored session goes
> under a group node with a predictable schema like
> "Session - Sun 2026/04/26" and the saved tab tree comes back as a subtree
> under that group node — does NOT wipe current tabs.

This is genuinely state-of-the-art for chrome-script tab managers — Sidebery
has only opt-in single-snapshot, Zen leans on Firefox's native LastSession
(single-session), TST has no multi-session at all.

---

## Why our current design fails this requirement

`src/tabs/persist.ts` writes a single file `palefox-tab-tree.json` that
captures only the *current* tree. There is no concept of session boundaries,
session labels, or session history. Restore is implicit: at startup,
`palefox-tab-tree.json` is loaded and applied to whatever tabs Firefox's
SessionStore restored.

Two orthogonal problems with extending the current design directly:

1. **The two-store drift problem.** palefox-tab-tree.json and Firefox's
   sessionstore.jsonlz4 are independent persistence layers. If they
   disagree about what tabs exist (e.g., SessionStore restores a different
   subset than what we saved), `popSavedForTab` reconciliation produces
   gaps — tabs come back without parents because their parent's pfx-id was
   never restored.
2. **No session abstraction.** We'd need to bolt one on, and the file
   format would have to grow a sessions array. At which point a separate
   index + per-session blobs is cleaner.

---

## Recommended architecture

**Hybrid: profile-directory JSON files + lightweight in-memory index.**

```
<profile>/
├── palefox-tab-tree.json           current/live tree (existing)
├── palefox-sessions.json           index of all stored sessions
└── palefox-session-<timestamp>.json    one file per session (full blob)
```

### Session index file

```jsonc
{
  "sessions": [
    {
      "timestamp": 1714003200000,
      "label": "Session - Sun 2026/04/26",
      "windowCount": 2,
      "tabCount": 47,
      "file": "palefox-session-1714003200000.json"
    },
    // …
  ],
  "nextSessionId": 2
}
```

### Per-session blob

Same shape as today's `palefox-tab-tree.json` (nodes + closedTabs +
nextTabId), plus a `timestamp` envelope field. Each blob is independent,
fully restorable on its own.

```jsonc
{
  "timestamp": 1714003200000,
  "nodes": [ /* SavedNode[] */ ],
  "closedTabs": [ /* SavedNode[] */ ],
  "nextTabId": 142
}
```

### Why files over SessionStore

We considered `SessionStore.setCustomGlobalValue(key, json)`. Real
constraints that pushed us to files:

- SessionStore state is read at every Firefox startup. Bloating it with
  multi-session history slows cold-start.
- Durability under dirty shutdown is documented as best-effort —
  `setCustomGlobalValue` writes are coalesced; a hard-kill (SIGKILL,
  power loss) within the coalesce window loses the write. Profile files
  with atomic temp-file-then-rename writes are stronger.
- Sessions are independent; no need for them to load-or-save together.
  File-per-session lets us prune individual sessions cheaply.
- Comparable projects (Sidebery, Chrome session managers) all converged
  on dedicated storage rather than relying on browser SessionStore.

`setCustomGlobalValue` is still useful for *small* per-session metadata
(if we want to know the latest session timestamp from a place that's
read-once at startup), but the bulk goes in files.

---

## Session lifecycle

### Boundary: when does a session close?

**On Firefox quit, not on window close.** Multi-window users want all open
windows captured together as one session. Hook the `quit-application`
observer:

```js
Services.obs.addObserver({
  observe(_subject, topic) {
    if (topic === "quit-application") saveCurrentSessionToDisk();
  }
}, "quit-application");
```

`quit-application` fires before SessionStore's own write, so we have time
to capture state. If it doesn't fire (SIGKILL, power loss), we fall back
to whatever the most recent debounced save captured — same recovery
guarantees as today.

### Auto-save during the session

Keep the existing `scheduleSave` debounced write to `palefox-tab-tree.json`
unchanged. That's the live snapshot. The session-history file is
written *only* at quit time; it captures the final state of the session.

Optional: also snapshot to history on user demand via `:checkpoint <label>`.

### Cap to N sessions

Pruning policy (configurable via prefs):

- `pfx.history.maxSessions` (default 20)
- `pfx.history.maxDiskBytes` (default 100MB)
- `pfx.history.maxAgeDays` (default 30)

Eviction: after each save, sort sessions by timestamp ascending, drop
oldest until all three caps are satisfied.

---

## Restore semantics

### `:restore <label>` flow

The user's requirement is **restore as subtree under a group node, do NOT
wipe current state.** Implementation walks through palefox's existing
session-restore queue:

1. Load `palefox-session-<timestamp>.json` → `SavedNode[]`
2. Generate a stable synthetic group id (e.g., `g-restored-1714003200000`)
3. Build a `Group` row entry with `name = "Session - Sun 2026/04/26"`,
   `level = 0`, `id = <synthetic>`
4. Rewrite parentage in the loaded SavedNodes:
   - Roots in the saved session (parentId === null) → parent becomes the
     synthetic group id
   - Internal-pointing parents (numeric pfx-id) → unchanged (they reference
     other tabs in the same restored session)
5. Re-key tab pfx-ids to avoid collision with current live state — bump
   each saved id by `state.nextTabId` (= the current live max + 1)
6. Open a Firefox tab per restored SavedNode (via
   `gBrowser.addTab(url, { triggeringPrincipal })`) and let the existing
   `onTabOpen` → `popSavedForTab` chain wire each one into its
   pre-rewritten parentId

This produces:

```
[current tabs unchanged]
└─ Session - Sun 2026/04/26  (group node)
   ├─ tab from saved session
   │  └─ child tab from saved session
   └─ tab from saved session
```

### Why no conflict with current tabs

Because we re-key pfx-ids before opening tabs, restored tab parentages
point only at other restored tabs (or the synthetic group). Live tabs are
untouched.

### Group node persistence

The synthetic group is a real `Group` entry, persisted in the *current*
tree's save file — so it survives a subsequent quit / restore cycle. The
user can collapse it, drag it, refile it like any other group.

---

## Within-session search

### `:sessions <query>` UX

Lists sessions whose tabs match, with match count and a few example URLs:

```
Session - Sun 2026/04/26 (5 matches)
  https://example.com/page-a
  https://example.com/page-b
  My custom group name
Session - Sat 2026/04/25 (2 matches)
  https://other.example.com
  …
```

### Implementation

1. Load `palefox-sessions.json` index → list of session metadata
2. For each session, lazy-load `palefox-session-<ts>.json` (read only when
   the search needs it; cache in-memory for the search-UI lifetime)
3. Per-session filter: SavedNodes whose `url` or `name` field contains
   query (case-insensitive substring)
4. Return ranked list — most recent matching session first, ties broken
   by match count

For performance: the index is small (~200 bytes per entry, 4KB for 20
sessions) so loading + scanning is essentially free. The expensive part
is opening N session blobs; cap concurrent reads at 5 to avoid IO storms.

---

## Open questions to resolve via the test harness

These are testable now (Tier 3 substrate exists) — no need to speculate:

1. **Is `setCustomGlobalValue` durable across SIGKILL?** Write a test that
   writes a value, kills Firefox via the OS, restarts, reads it back.
   Decides whether the lightweight session index belongs in
   SessionStore or in a file.
2. **Two-store drift in practice.** Build a test that opens N tabs,
   triggers a save, hard-kills mid-write, restarts, and measures the
   delta between palefox-tab-tree.json and what SessionStore restored.
   Quantifies how often drift bites.
3. **Restore-into-subtree-of-group correctness.** Build the feature
   end-to-end, then test: open 4 tabs in a tree, save session, close
   them all, restore. Verify all 4 come back nested under the synthetic
   group node, not as flat root tabs.
4. **Pruning behavior.** Set the caps low (3 sessions, 1MB), open and
   quit Firefox 5 times, verify oldest 2 sessions evicted and disk
   usage stays bounded.

---

## Migration path from current design

`palefox-tab-tree.json` semantics don't change — it remains the live
snapshot. The new files are additive. Three implementation phases:

**Phase 1 — Storage layer:**
- New module `src/tabs/sessions.ts` with the storage primitives
  (saveSession, loadSession, listSessions, pruneSessions)
- Wire `quit-application` observer to call `saveSession(Date.now())`
- Verify via integration test (open tabs, quit, file appears)

**Phase 2 — Restore UX:**
- Add `:restore <label>` ex-command to `src/tabs/vim.ts`
- Implement re-key + synthetic-group + queue-into-onTabOpen flow
- Verify via integration test (saved tree comes back nested under group)

**Phase 3 — Search UX:**
- Add `:sessions [query]` ex-command — lists / searches sessions
- Render results in a popup / dedicated UI surface (TBD — modeline list?
  separate panel?)

**Phase 4 — Polish:**
- User-configurable caps via prefs
- Manual `:checkpoint <label>` for explicit mid-session save
- Optional: keyboard shortcut to open session list directly

---

## Risks / tradeoffs we're accepting

- **Session storage is palefox-only, not synced.** If we want cross-device
  session sync later, we'd layer it on top — out of scope for v1.
- **Profile-file IO not transactional across sessions.** A crash during
  save loses *that* session, not earlier ones — but partial writes could
  in theory leave a corrupt file. Use `IOUtils.write` with `tmpPath` for
  atomic rename.
- **Search is linear in #sessions × #tabs/session.** Fine up to ~20
  sessions × ~100 tabs each. Beyond that, would want an index structure.
  Defer until it bites.
- **No tab-content snapshot.** We save URL + label + tree structure, not
  scroll position or form state. Firefox's SessionStore handles content
  for the *current* session; for restored older sessions, content is
  re-fetched fresh. This matches the user's vision (URL-level history).
