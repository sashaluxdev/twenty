# ADR 0014 — Pointer-event gesture + fractional midpoint positions (amends ADR 0013)

- Status: Accepted
- Date: 2026-07-04

## Context

The shipped drag-to-reorder (ADR 0013) worked but diverged from Twenty
core's reorder philosophy in four ways discovered by cross-referencing
core source (`DndKitSensors.ts`, `getPositionBetween.ts`,
`computeNewPositionOfDraggedRecord.ts`, `RecordBoardDragDropContext.tsx`),
and had two robustness gaps: mouse-only events (no touch), and
commit-on-mouseleave (persisting an order the user may not have chosen).

## Decision

1. **Pointer events replace mouse events** (`onPointerDown/Enter/Up/
   Leave/Cancel/Move`, all remote-dom-allowlisted). One event family for
   mouse/touch/pen — core's model (single `PointerSensor`, no
   TouchSensor). Mouse handlers are removed, not kept alongside
   (double-firing would oscillate the preview). The handle keeps
   `preventDefault()` on pointerdown (native-drag kill, see the 2026-07-04
   gotcha) and adds `touchAction: 'none'` (no library to do it for us).
2. **8px activation distance** (core: `PointerActivationConstraints.
   Distance({ value: 8 })`): pointerdown only records start coordinates;
   the drag arms after ≥8px of travel. Clicks never arm a drag and never
   write — this also removes ADR 0013's bare-click null-heal write burst.
3. **Drop-outside cancels silently** (core: `if (!result.destination)
   return`): pointerup inside the container commits; `pointercancel` or
   the pointer leaving the container mid-drag disarms, reverts the
   preview via a reload, and writes nothing. Supersedes ADR 0013's
   commit-on-mouseleave.
4. **Fractional midpoint positions, single-row writes** (core:
   `getPositionBetween` — `(prev + next) / 2`, `neighbor ± 1` at edges;
   core never renumbers a list): a drop writes ONE row's `order`.
   ADR 0013's reindex-to-`0..N−1` survives only as a normalization
   fallback, taken when a participating neighbor is unnumbered (`null`)
   or the midpoint collides with a neighbor (float precision exhausted,
   or duplicate neighbor orders from concurrent tabs). A drag returned
   to its origin slot writes nothing.
5. **Visuals match core's language**: dragged row = light background
   tint + stronger border (never opacity-dimmed — core reserves dimming
   for secondary multi-drag items); grip = recessive vertical-dots in
   muted gray, `cursor: grab`/`grabbing`. Always visible (core
   hover-reveals; per-row hover state in remote-dom is churn for pure
   polish — accepted divergence).

## Consequences

- ~~Touch drag works with no additional code path~~ **CORRECTED 2026-07-04
  after live verification: touch drag is NON-FUNCTIONAL on the current
  renderer.** Touch pointerdown gives the handle implicit pointer capture;
  releasing it requires `event.target.releasePointerCapture()`, but
  remote-dom's `SerializedEventData` exposes no `target`, so the release is
  unreachable from app code (verified empirically — the fix attempt was a
  no-op). Result: a touch drag arms but `pointerenter` never fires on other
  rows — the preview never moves and ZERO writes occur (safe degradation, no
  corruption possible). Mouse and pen are fully functional. A real fix needs
  a renderer-package change (expose target / pointer-capture control).
  User-accepted limitation, 2026-07-04. Scroll-vs-drag conflicts still
  resolve via pointercancel → silent revert (never a partial write).
- Steady-state drops are O(1) writes regardless of list length; the
  duplicate-order window under concurrent tabs shrinks to single-row
  last-writer-wins, still rendered deterministically (stable sort) and
  healed by the next normalization-triggering drop.
- `order` values are no longer contiguous integers — they are an opaque,
  ever-subdividable float line, same as every `position` field in core.
  Nothing may assume `0..N−1`.
- Keyboard reorder remains deliberately out of scope (user decision,
  2026-07-04); core ships a KeyboardSensor everywhere — revisit on
  request.
