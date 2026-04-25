# Compact Mode: A Comparative Forensic Analysis

## Why this document exists

Palefox's autohide ("compact") mode has been intermittently leaving the
sidebar **hung OPEN** — the user expects it to slide closed but it
stays visible until they manually trigger another transition. This
document compares our implementation against the two reference designs
we've been pulling from — Zen Browser's `ZenCompactMode.mjs` and
Firefox's native `expand-on-hover` (sidebar-revamp era) — enumerates
every state-leak vector across all three, identifies which leaks our
implementation inherits or invents, and prescribes the exact code
changes that close each one.

The goal is a sidebar that **cannot** hang open — every reachable
state has a documented exit, every guard has a documented release, and
every animation has a fallback for "the OS event we expect never
fires."

---

## Section 1 — The three implementations side-by-side

### 1.1 What's actually being controlled

All three implementations have the same job: a sidebar lives on the
left edge of the window; its width is normally significant; in compact
mode the width collapses to zero (Zen, palefox) or to icon-strip
(Firefox), and the sidebar slides back in when the user hovers near it.
Hide on mouse-out, after a short grace period.

| Browser | Hidden representation | Trigger surface | Animation engine |
|---|---|---|---|
| **Zen** | `transform: translateX(±100%)` on `#sidebar-main` | Screen-edge detection (`mouseleave` on `<html>` + `_getCrossedEdge`) | Motion.js promise-based (`gZenUIManager.motion.animate()`) |
| **Firefox revamp** | `width: 0` (or icon-strip) on `<sidebar-main>` widget | `MousePosTracker` listener over computed launcher rect | Web Animations API (`element.animate(...).finished`) |
| **Palefox** | `transform: translateX(±100%)` on `#sidebar-main` | Physical 4px-wide DOM strip element (`#pfx-hover-strip`) at `z-index: 9 < 10` | CSS `transition: transform` + `transitionend` event |

Every difference here is meaningful. Each choice trades complexity for
predictability; each gets you out of one bug class and exposes you to
another.

### 1.2 State machines

Stripped to the smallest sufficient set:

**Zen** (`ZenCompactMode.mjs`):

```
       NORMAL                      ─enable→        COMPACT_HIDDEN
       (zen-compact-mode=false)                    (zen-compact-mode=true,
                                                    zen-has-hover absent)
                                                          │
                                                          │  hover via
                                                          │  _getCrossedEdge
                                                          │  + flashElement
                                                          ▼
                                                    COMPACT_SHOWING
                                                    (zen-compact-mode=true,
                                                     zen-has-hover=true)
                                                          │
                                                          │  flashElement timeout
                                                          │  expires + no _ignoreNextHover
                                                          │  + no _isTabBeingDragged
                                                          ▼
                                                    COMPACT_HIDDEN

       Across-state guard:  zen-compact-animating attribute on root
                            (rejects re-entrant toggles)
```

Plus 7+ "stay-open" guards (`zen-user-show`, `zen-has-empty-tab`,
`panelopen`, `breakout-extend`, `movingtab`, `has-popup-menu`,
`zen-compact-mode-active`).

**Firefox revamp** (`SidebarState.sys.mjs` + `browser-sidebar.js`):

The state space is 7 booleans (`launcherExpanded`, `launcherVisible`,
`launcherHoverActive`, `launcherDragActive`, `pinnedTabsDragActive`,
`toolsDragActive`, plus a counter `_hoverBlockerCount`) with three
visibility-pref modes (`always-show` / `hide-sidebar` /
`expand-on-hover`). The transitions go through `set
launcherExpanded(expanded)` (line 509) which atomically toggles
attributes on **5** elements (sidebarContainer, splitter, box,
contentArea, tabContainer) and triggers `_updateLauncherWidth()` —
unless `launcherDragActive` is set, in which case the width update is
skipped (line 537).

**Palefox** (`src/drawer/index.ts`):

```
       NORMAL                      ─compactEnable→      COMPACT_HIDDEN
       (no data-pfx-compact)                            (data-pfx-compact set,
                                                         pfx-has-hover absent)
                                                              │
                                                              │  hoverStrip mouseenter
                                                              │  OR sidebar mouseover
                                                              │  + !_ignoreNextHover
                                                              ▼
                                                        COMPACT_SHOWING
                                                        (data-pfx-compact set,
                                                         pfx-has-hover=true)
                                                              │
                                                              │  mouseleave
                                                              │  → flashSidebar(300ms)
                                                              │  → setHover(false) if !isGuarded()
                                                              ▼
                                                        COMPACT_HIDDEN

       Across-state guard:  _ignoreNextHover (boolean, module-private)
                            cleared by transitionend OR safetyTimer (400ms)
       Hide-suppress list:   _openPopups > 0
                             urlbar[breakout-extend]
                             toolbarbutton[open=true]
                             tabbrowser-tab[multiselected]
                             [pfx-dragging]
```

Compared to Zen, palefox dropped: `zen-user-show` (we have no
manual-pin yet), `zen-has-empty-tab` (we don't have spaces),
`zen-compact-animating` (we use `_ignoreNextHover` for the same
purpose), and the macOS-window-buttons collision check. We also
*added* a popup counter and a 4px DOM hover strip.

### 1.3 The hover-detection chain in three flavors

This is the most consequential difference. **What does each
implementation use as the signal "the user wants the sidebar
revealed"?**

**Zen — screen edge.** `mouseleave` on `<html>` fires when the mouse
exits the window through the left edge; `_getCrossedEdge(pageX,
pageY)` (lines 919–931) inspects the cursor coordinates and returns
the edge name; if it matches an element registered as hoverable for
that edge (line 866), `flashElement(target,
hideAfterHoverDuration, ...)` reveals the sidebar.

Trade-offs: zero DOM cost, works at the very pixel edge of the screen.
But on Wayland / X11, dragging the toolbox produces spurious
`mouseleave` events (Mozilla bug 1979340), so Zen wraps every handler
in a `setTimeout(HOVER_HACK_DELAY)` and re-checks `:hover` (lines
807–810).

**Firefox — `MousePosTracker`.** The platform helper polls real cursor
position and fires synthetic enter/leave when crossing a registered
rectangle. Firefox computes the launcher rect (`getMouseTargetRect()`,
lines 2351–2365) excluding a 4px splitter zone. `onMouseEnter`
debounces 200ms via `DeferredTask` then expands; `onMouseLeave`
disarms the deferred task and collapses immediately.

Trade-offs: the most robust input — cursor position is sampled, not
derived from event flow. But it requires a `Promise` orchestration
(`_mouseEnterDeferred = Promise.withResolvers()`) plus a hover-blocker
counter for popup interactions, and it has the
`mouseOverTask`-vs-`mouseEnterTask` typo bug at line 2409.

**Palefox — physical hover strip.** A 4px-wide invisible
`<box id="pfx-hover-strip">` is positioned at `z-index: 9` behind the
sidebar (`z-index: 10`). When the sidebar has `pointer-events: none`
(hidden state, applied by CSS the moment `data-pfx-compact` is set),
mouse events pass through to the strip. The strip's `mouseenter`
handler then triggers reveal.

Trade-offs: DOM-explicit, debuggable, no platform-helper dependency.
Cost: an extra element to keep parented correctly, and the strip's
`mouseenter` is subject to the same Wayland false-positives Zen
hand-rolls a debounce for.

### 1.4 Animation-completion signal — the most fragile primitive

| Browser | Mechanism | Failure mode if signal never fires |
|---|---|---|
| **Zen** | `await gZenUIManager.motion.animate(...)` resolves a Promise | Outer `await animateCompactMode()` (line 358) hangs forever. `zen-compact-animating` flag stays set. `_ignoreNextHover` is never deleted (line 519 `setTimeout` is inside the `.then()` that never runs). **Sidebar frozen mid-flight, all future toggles rejected.** |
| **Firefox** | `Promise.allSettled(animations.map(a => a.finished))` (line 1301) | Same hang risk if `Animation.finished` never resolves (extreme load, animation cancelled in some way that doesn't reject). `_hoverBlockerCount` could be left elevated since `_removeHoverStateBlocker` is called *after* the await (line 1308). |
| **Palefox** | `transitionend` event listener for `propertyName === "transform"` (line 555) **+ 400ms safety timer** (line 554) | Safety timer guarantees `_ignoreNextHover` clears even if `transitionend` never fires. **But** it only clears `_ignoreNextHover` — *not* `pfx-has-hover`, *not* `flashTimer`. A stuck `pfx-has-hover` from any other source would survive the safety timer. |

Palefox's safety-timer approach is **architecturally superior** to
Zen's promise-await pattern for one specific reason: a fallback exists.
But the safety timer's *scope* (only clears `_ignoreNextHover`) is too
narrow to be a general-purpose recovery — see Section 4.

---

## Section 2 — Catalogue of every failure mode

For each implementation, I enumerated every code path that *can* leave
the sidebar in `pfx-has-hover` (or its equivalent) without a
guaranteed subsequent path that clears it. The taxonomy:

### 2.1 Zen's hang-OPEN paths

| # | Path | Source |
|---|---|---|
| Z1 | Animation Promise rejection — no `.catch()` on `gZenUIManager.motion.animate(...).then(...)`. Outer await hangs, sidebar stuck mid-animation. | `ZenCompactMode.mjs:508, 564` |
| Z2 | Exception in `.then()` callback before `resolve()`. DOM access (`document.getElementById("titlebar")`) returning null isn't try/caught. | `ZenCompactMode.mjs:509–537` |
| Z3 | `_ignoreNextHover` stuck true if `delete` throws inside the bare `setTimeout(() => { delete this._ignoreNextHover; })`. | `ZenCompactMode.mjs:519` |
| Z4 | External setter of `zen-has-hover` (e.g., `ZenSpaceManager.mjs:584`) bypasses the `flashElement` ID-keyed cleanup, leaving the attribute dangling. | `ZenSpaceManager.mjs:584` |

### 2.2 Firefox's hang-OPEN paths

| # | Path | Source |
|---|---|---|
| F1 | `_hoverBlockerCount` leak — increment from `popupshown` not paired with decrement from `popuphidden`. `MousePosTracker` listener never re-added. `onMouseLeave` never fires. | `browser-sidebar.js:1452–1476` |
| F2 | `Animation.finished` never resolves (frame drops). `_removeHoverStateBlocker()` (line 1308) never called. Same effective leak as F1. | `browser-sidebar.js:1301–1308` |
| F3 | `toggleExpandOnHover(false)` (line 2409–2410) references `mouseOverTask` instead of `mouseEnterTask`. The actual armed task is never finalized; a re-enable can leave an orphaned task that fires later. | `browser-sidebar.js:2409` |
| F4 | Window blur — no explicit handler, the user can lose focus while expanded and the sidebar stays expanded indefinitely (until next mouse activity). | absent |

### 2.3 Palefox's hang-OPEN paths (the ones that matter to us)

| # | Path | Source | Severity |
|---|---|---|---|
| **P1** | `_openPopups` stuck > 0 — every `popupshown` increments, every `popuphidden` decrements. If Firefox internals close a popup without firing `popuphidden` (Mozilla bug history says this happens for some XUL panels), `isGuarded()` returns true forever, `flashSidebar`'s `setHover(false)` callback is short-circuited. **Sidebar can't hide.** | `src/drawer/index.ts:331–349` | **CRITICAL** |
| **P2** | `transitionend` doesn't fire for `propertyName === "transform"` because something modifies the inline style during the transition (e.g., compositor canceling). The 400ms safety timer fires and clears `_ignoreNextHover`, but does **not** clear `pfx-has-hover` or run the `setHover(false)` flow. If `pfx-has-hover` was set during the brief animation window (e.g., a hover during compactToggle), it stays set. | `src/drawer/index.ts:553–561` | **HIGH** |
| **P3** | `flashTimer` cancelled by `clearFlash()` (line 401) but `pfx-has-hover` was already set by the flash. `clearFlash()` only clears the timeout — it doesn't re-evaluate state. If the timeline is `flashSidebar → setHover(true) → clearFlash from a re-entrant onSidebarEnter → never call setHover(false)`, the sidebar stays open. | `src/drawer/index.ts:415–432, 400–403` | **HIGH** |
| **P4** | `urlbar[breakout-extend]` guard. The breakout attribute is owned by Firefox's urlbar code. If the urlbar focus state desyncs (focus lost via right-click on a tab without firing the urlbar's blur cleanup), `breakout-extend` could persist, `isGuarded()` returns true forever. | `src/drawer/index.ts:344` | **MEDIUM** |
| **P5** | `[pfx-dragging]` guard — set by drag.ts, removed in `dragend`. If a `dragend` event fails to fire (Wayland HTML5 drag-and-drop is unreliable on certain compositors), the attribute persists, `isGuarded()` returns true. | `src/tabs/drag.ts` | **MEDIUM** |
| **P6** | The `urlbarCompactObserver` callback could call `flashSidebar(KEEP_HOVER_DURATION)` which then runs through `isGuarded()` — but the `popupshown` event for the urlbar dropdown might not have fired yet by the time the callback executes (timing-dependent). The flash schedules a hide that runs AFTER the popup opens, popup is open, hide is short-circuited, and now the sidebar stays open until something else triggers a re-evaluation. | `src/drawer/index.ts:472–478` | **MEDIUM** |
| **P7** | `_ignoreNextHover` stuck true — if a user toggles compact mode then immediately un-toggles it (within 400ms), `compactDisable()` runs but doesn't reset `_ignoreNextHover`. The pending safety timer DOES clear it (400ms is unconditional), so this is self-healing — but during the window between disable and timer fire, `setHover(true)` calls have a "value && _ignoreNextHover" branch (line 360) that *force-removes* `pfx-has-hover`. So in normal mode the sidebar is now mysteriously suppressed for up to 400ms after re-enabling. | `src/drawer/index.ts:553, 360–364` | **LOW** but confusing |
| **P8** | The hover strip's `mouseenter` handler (`hoverStrip.mouseenter`) fires once per insertion. If `compactDisable()` removes the strip then `compactEnable()` re-creates it, the listener is re-attached fresh. But if there's an exception during `compactEnable()` between `removeAttribute` calls and `appendChild(hoverStrip)`, the strip is never re-attached, and the user has no way to reveal the sidebar by hovering the edge. | `src/drawer/index.ts:489–502, 525–528` | **LOW** |
| **P9** | `sizemodechange` only clears `pfx-has-hover` *if* the sidebar isn't currently `:hover`'d. If the user minimizes/restores during a hover state, the attribute might persist. | `src/drawer/index.ts:590–598` | **LOW** |
| **P10** | No window-blur handler. Mouse leaves the window without crossing the sidebar edge (e.g., Alt-Tab to another window) → no `mouseleave` fires on the sidebar → sidebar stays open. | absent | **MEDIUM** |

P1, P2, P3 are the most likely real-world culprits for the user's
"stuck on first re-open." All three have a common shape: **state was
set during a transition, the path that should clear it didn't fire,
and there's no reconciliation step to detect the drift.**

---

## Section 3 — The architectural prescription

Three design rules emerge from the comparison:

### 3.1 Rule one: every guard counter must be reconcilable

`_openPopups` is a write-only counter. Once it's stuck, nothing
recovers it. The fix is straightforward: **periodically (or on every
state-relevant event) recompute the counter from the DOM** rather than
trust the running tally. Concretely:

```ts
function reconcilePopups(): number {
  // Source of truth: count visible popup-like elements in the DOM.
  return document.querySelectorAll(
    "panel[panelopen='true'], menupopup[open='true'], " +
    "[showing], [open='true']:is(panel, menupopup, tooltip)"
  ).length;
}
```

Call it (a) at the top of `isGuarded()` so `_openPopups` is always
fresh, or (b) on every `mouseleave` from the sidebar so the next hide
attempt is clean. Trade-off: a `querySelectorAll` per leave is cheap
(<1ms) and eliminates an entire class of leaks.

### 3.2 Rule two: every animation must have a "deadline" fallback

Palefox already has the safety timer for `_ignoreNextHover` clearance.
Extend the principle: **every state set during the show/hide
transition must be paired with a deadline that resets it** if the
transition's expected end-event doesn't fire.

The current `safetyTimer` (line 554) only clears `_ignoreNextHover`.
Generalize it to a `reconcileAfterTransition()` function that:

1. Cancels any pending `flashTimer`
2. Clears `pfx-has-hover` if `isGuarded()` is false AND the cursor is
   not currently over the sidebar
3. Clears `_ignoreNextHover`
4. Logs the path that fired (transitionend vs. safety) for diagnostics

This eliminates P2 (transitionend miss), P3 (flashTimer cancellation
race), P7 (`_ignoreNextHover` stuck during fast toggle).

### 3.3 Rule three: every "leak" attribute must have a watchdog

Attributes like `urlbar[breakout-extend]` and `[pfx-dragging]` are set
by code outside compact mode. Compact mode just *reads* them via
`isGuarded()`. If the upstream code fails to clear them, compact mode
is hostage forever.

The fix is a **periodic reconciliation tick**: when the sidebar is
shown but should be hidden, schedule an `idleCallback` to re-check
guards in 1 second. If conditions allow hide, do it. This catches
external-state desyncs without polling. Pairs nicely with a `:focus`
listener on the urlbar (clear `breakout-extend` defense) and a
`window.blur` handler (catch P10).

---

## Section 4 — The concrete fix list (what we're implementing)

Mapped to the failure-mode catalogue above:

| Fix | Closes |
|---|---|
| **F-A**: Reconcile `_openPopups` on every leave attempt | P1 |
| **F-B**: Generalize the safety timer into `reconcileCompactState()` that runs hide-if-allowed | P2, P3, P7 |
| **F-C**: Add a `window.blur` handler that calls reconcile | P10 |
| **F-D**: Add a 1s idle watchdog when the sidebar is "shown but should be hidden" | P4, P5, P6 |
| **F-E**: Wrap the `compactEnable()` body in try-finally so the hover strip is guaranteed to be in the DOM if compact is on | P8 |
| **F-F**: `sizemodechange` calls reconcile unconditionally (was: only clear if not hovered) | P9 |
| **F-G**: Drawer logger writes via batched flush (already shipped earlier this session) | observability prerequisite |
| **F-H**: Each guard release path logs `dbg("reconcile", { trigger, before, after })` so future bugs are diagnosable in one round-trip | observability prerequisite |

All of these are localized to `src/drawer/index.ts`; no CSS changes
required, no DOM-structure changes, no new dependencies.

---

## Section 5 — The new state-machine invariants

After the fixes, palefox compact mode will satisfy these invariants:

1. **Liveness**: If the sidebar is `data-pfx-compact` AND
   `pfx-has-hover` AND no guard is true AND the cursor is not over the
   sidebar AND no animation is in flight, then within ≤1100ms (300ms
   flash + 400ms safety + 100ms reconcile margin + 300ms idle) the
   sidebar will be hidden.
2. **Safety**: `pfx-has-hover` is set if and only if at least one of
   `(cursor-on-sidebar, cursor-on-hoverstrip, active-flash, guard-true)`
   is true. Reconciliation enforces this.
3. **Termination**: Every animation completes within 400ms (CSS
   transition is 250ms; safety is 400ms). After the deadline,
   `reconcileCompactState()` runs unconditionally.
4. **Idempotence**: `compactEnable()` and `compactDisable()` may be
   called repeatedly with no ill effect. State is normalized.
5. **Observability**: Every guard transition logs to
   `<profile>/palefox-debug.log` with timestamp + before/after state.
   Any future hang is diagnosable from a single log fragment.

These are testable invariants. We don't have automated tests for chrome
JS yet, but the dbg logging is structured enough that a one-shot
script could parse the log and assert them.

---

## Section 6 — Why each fix is "the right level of paranoia"

There's a temptation when chasing race conditions to make the code
defensive everywhere. That gets you an unmaintainable mess that papers
over the bug instead of fixing it. The fixes above were chosen to:

- **Centralize state-mutation control** in `setHover()` and a new
  `reconcileCompactState()`. Other call sites become readers.
- **Use timeouts as a backstop, never as primary control flow** —
  primary control flow stays event-driven (mouseenter, mouseleave,
  transitionend).
- **Make external state (urlbar, drag) safe to depend on** by
  re-checking it on a deadline, not by polling.

Compared to Zen's `_ignoreNextHover` deletion via bare `setTimeout`
inside an unsafeguarded `.then()` (Z3), our pattern is *strictly*
more robust: every async cleanup has both an event-driven happy path
*and* a deadline-driven backstop *and* a reconciliation tick. Three
independent mechanisms for the same property. If one fails, the next
one catches it.

Compared to Firefox's `_hoverBlockerCount` (F1, F2, F3), our
reconciliation approach avoids the counter-leak class entirely:
counters are computed on demand from the DOM, not maintained
incrementally.

The only failure mode left after these fixes is "the user's compositor
is broken and the OS is dropping events." We can't fix the OS — but
we can fail safe (sidebar hidden) instead of fail open (sidebar
stuck). That's exactly what reconciliation gives us.

---

## Appendix A — Source citations (selected)

- `~/code/zen-browser/src/zen/compact-mode/ZenCompactMode.mjs`
  — `_ignoreNextHover` setter (623), animation-promise hangs (508,
  564), `_setElementExpandAttribute` (693), `flashElement` (672),
  `_clearAllHoverStates` on `sizemodechange` (92), HOVER_HACK_DELAY
  for Wayland (47).
- `~/code/firefox/browser/components/sidebar/browser-sidebar.js`
  — `_hoverBlockerCount` add/remove (1452–1476), animation Promise
  await (1301–1308), `mouseOverTask`/`mouseEnterTask` typo (2409),
  `MousePosTracker` listener (2395), `_checkIsHoveredOverLauncher`
  (2179–2188).
- `~/code/firefox/browser/components/sidebar/SidebarState.sys.mjs`
  — `launcherExpanded` setter (509–547), `launcherDragActive` (553),
  cross-element attribute toggle (529–535), `_updateLauncherWidth`
  skip during drag (537).
- `~/code/palefox/src/drawer/index.ts`
  — `_openPopups` counter (331–349), `_ignoreNextHover` (312),
  `safetyTimer` (554), `setHover` (358–372), `flashSidebar` (380–398),
  `isGuarded` (342–349), `compactEnable`/`compactDisable` (452–532).
- `~/code/palefox/chrome/palefox.css` (compact mode region):
  `[data-pfx-compact]` transform / `pointer-events: none` rule, hover
  strip `z-index: 9 < 10`, transition `var(--pfx-transition-duration)`.

## Appendix B — The bugs we are knowingly *not* fixing

These were enumerated in the agent reports but rejected as out of
scope for this round:

- **macOS window-button bounds collision** (Zen lines 789–802): we
  don't ship on macOS yet; punt.
- **Workspace / virtual-desktop change handling**: niri / Hyprland /
  KWin handle this at the compositor level; the sidebar should follow
  window focus, which our `window.blur` handler will catch.
- **Reduce-motion preference** beyond the existing CSS `@media
  (prefers-reduced-motion)` rule: the JS state machine is timing-aware
  but doesn't actively re-tune. Acceptable.
- **A formal test harness for chrome JS**: we don't have one. The
  structured `dbg()` log is the substitute until we do.
