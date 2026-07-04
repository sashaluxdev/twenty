# ADR 0013 — Drag-to-reorder formula fields via pointer events, not native DnD

- Status: Accepted
- Date: 2026-07-04

## Context

Item #4 of the build pipeline: the record-page "Formula fields" tab
(`formula-editor.tsx`) lists every `FormulaDefinition` targeting the host
object, one block per formula, in whatever order the `formulaDefinitions`
query happens to return. There is no persisted ordering and no way for a user
to change it.

Front components render through **remote-dom**
(`packages/twenty-front-component-renderer`): JSX compiles to a restricted set
of host elements, and every element's allowed properties/events come from an
explicit allowlist (`AllowedHtmlElements.ts`, `HtmlCommonProperties.ts`,
`CommonHtmlEvents.ts`) rather than the full DOM API. Checking that allowlist
before designing the interaction (rather than after hitting a runtime wall) is
the point of this ADR: native HTML5 drag-and-drop needs a `draggable`
attribute plus `dragstart`/`dragover`/`drop`/`dragend` events and the
`DataTransfer` API to move a payload between them — **none of that is in the
allowlist.** `HtmlCommonProperties` has no `draggable` key, and
`CommonHtmlEvents` lists only a bare `drag` (fired mid-gesture by the browser,
useless without the surrounding events that start/target/end a native drag
session). Building the feature on native DnD would compile but do nothing at
runtime.

What **is** in `CommonHtmlEvents`: the full pointer and mouse event families
(`pointerdown/move/up/over/enter/leave/cancel`, `mousedown/move/up/over/enter/
leave`). Every drag-to-reorder library that doesn't rely on native DnD (dnd-kit
being the mainstream example) is built on exactly this event set, so the
platform supports the *pattern*, just not the *browser DnD API* specifically.

## Decision

- **Pointer-driven "sortable list" interaction, no native DnD, no
  `DataTransfer`.** Each row gets a small drag-handle element with
  `onMouseDown` that arms a `draggingId` piece of component state (which
  formula is being moved). Every row also gets `onMouseEnter`: while a drag is
  armed and the entered row is not the dragged one, the in-memory list is
  reordered live (dragged row spliced to the entered row's index) — a live
  reorder-on-hover preview, not a rendered "ghost" element. `onMouseUp` on the
  tab's outer container (which the release always bubbles into, since it
  wraps every row) clears `draggingId` and persists the final order. No
  `window`/`document`-level listeners are needed — only component-tree
  bubbling — which sidesteps any uncertainty about global-listener support
  inside the remote-dom sandbox (a real, previously-hit gotcha for other DOM
  APIs; see the front-components gotchas list).
- **Persisted ordering: a new nullable `order` (NUMBER) field on
  `FormulaDefinition`**, alongside the existing system-managed fields
  (`status`, `dependencies`, …). Existing rows get `null` — no backfill
  migration. `formula-editor.tsx`'s `load()` sorts the per-host-object list by
  `order ascending`, with `null` falling back to the query's own fetch-order
  position (JS `Array.prototype.sort` is a stable sort, so ties preserve
  relative fetch order) — so a fresh install with no reordering yet looks
  exactly as it does today.
- **Reindex-on-drop, not fractional positions.** Unlike the FX Status chip's
  `position` (a view-scoped float using an anchor+0.5 midpoint scheme, ADR
  0009), formula counts per object are small (a handful in the normal case),
  so on every drop the ENTIRE visible list is renumbered `0..N-1` and only the
  rows whose `order` actually changed are written (write-avoidant, consistent
  with the rest of the app). This trades a few extra writes on a busy tab for
  zero float-precision bookkeeping — simpler to reason about and to test.
  Because a drop always reindexes every row, `null` orders are healed
  automatically the first time anyone reorders — the same lazy-fix-on-write
  posture the FX Status layout convergence already uses.
- **The tab's own live-poll (4s interval) is paused mid-drag.** `load()`
  already re-fetches definitions/values/overrides every 4 seconds; without a
  guard, a poll landing mid-drag would clobber the live reorder preview.
  A `draggingRef` (checked, not state — reads must be synchronous inside the
  poll's closure) makes `load()` skip only the position-setting step while a
  drag is in progress; values/overrides still refresh underneath.

## Consequences

- **No dependency on `DataTransfer` or `draggable`** means the feature works
  within the existing remote-dom allowlist as-is — no renderer/allowlist
  change requested or required.
- **Ordering is per-target-object, not per-record.** All records of the same
  object see the same Formula-tab order, matching the FormulaDefinition data
  model (one set of definitions per object, not per record).
- **No cross-object migration needed.** `order: null` is a valid, common
  steady state (any object nobody has reordered yet); sorting treats it as
  "wherever the query already put it."
- **A drop is a small write burst** (up to N `updateFormulaDefinition`
  mutations, N = formula count on that object), not a single atomic write —
  acceptable given the expected N and consistent with how the app already
  treats FormulaDefinition writes (system-managed bookkeeping fields already
  get written from several code paths).
- **No keyboard-accessible reorder path.** This ADR scopes the interaction to
  pointer/mouse only, matching the literal ask ("drag to reorder"); an
  accessible alternative (e.g. up/down buttons) is not implemented here and
  would need its own decision if requested later.
