# Formula Field Hardening — Design

Date: 2026-07-04. Status: awaiting user approval.
Scope: harden the three lowest-confidence surfaces identified after the
roadmap completion audit, aligning with Twenty core's design philosophy
(verified against core source; citations inline).

User decisions already made:
- TODAY() staleness → **self-heal + indicator** (widget recomputes viewed
  record AND shows a staleness note).
- Reorder accessibility → **pointer events only** (touch works via pointer
  events; no up/down buttons; keyboard reorder is a deliberate, documented
  divergence from core's KeyboardSensor convention — revisit on request).

## Surface 1 — Drag gesture robustness (amends ADR 0013 → new ADR 0014)

### 1a. Pointer events replace mouse events
`formula-editor.tsx` migrates `onMouseDown/Enter/Up/Leave` →
`onPointerDown/Enter/Up/Leave/Cancel/Move` (all in the remote-dom
allowlist). Pointer events unify mouse/touch/pen — exactly core's model
(`DND_KIT_SENSORS` uses a single `PointerSensor`, no separate TouchSensor).
Mouse handlers are REPLACED, not kept alongside (double-firing would
oscillate the preview). The handle keeps `preventDefault()` on pointerdown
(kills native text/element drag — the bug found in live verification) and
adds `touchAction: 'none'` so touch scroll doesn't hijack the gesture
(core needs no explicit touch-action because its libraries handle it;
remote-dom has no library, so we set it directly).

### 1b. 8px activation distance (core: `DndKitSensors.ts`)
Core arms a drag only after 8px of pointer travel so clicks on draggable
things still register as clicks. Adopt: pointerdown on the handle records
start coordinates into a `pendingDragRef` (no state change, no visual
change); the row's `onPointerMove` arms the real drag (`draggingRef` +
`draggingId`) only once displacement ≥ 8px. Side effect: a bare
handle-click no longer triggers the all-null heal write burst — clicks
write nothing, ever.

### 1c. Cancel semantics match core: drop-outside = silent revert
Core never mutates on a no-destination drop (`if (!result.destination)
return`) and trusts snap-back. Amend our gesture accordingly:
- **Commit** = pointerup inside the widget container → persist.
- **Cancel** = `onPointerCancel` (browser took the gesture, e.g.
  touch-scroll) or the pointer LEAVING the widget container mid-drag
  (`onPointerLeave`) → disarm, revert the preview by re-running `load()`
  (with the drag guard now clear), write NOTHING.
This replaces the shipped behavior where leaving the container committed.
No custom cancel animation (core has none).

### 1d. Position model aligns with core: fractional midpoint, not reindex
Core never renumbers a list: every reorder writes ONE row whose `position`
is the midpoint of its new neighbors (`getPositionBetween`,
`computeNewPositionOfDraggedRecord`: `(prev + next) / 2`, `neighbor ± 1`
at edges, `0` for an empty context). Amend ours to match:
- On commit, compute the dragged row's new `order` from its final visual
  neighbors via a new pure helper `computeDropWrite(items, draggedId)`:
  - both neighbors numbered → midpoint;
  - at an edge → `neighbor − 1` / `neighbor + 1`;
  - **normalization fallback** (any participating neighbor is `null`, or
    the midpoint collides with a neighbor because float precision is
    exhausted) → full reindex `0..N−1` via the existing
    `computeReorderWrites` (write-avoidant: only changed rows). This keeps
    ADR 0013's lazy null-heal, now demoted to a fallback.
- Steady state after first normalization: every drop = exactly one write.
  Two-tab interleaving now writes one row per drop, further shrinking the
  duplicate-order window; ties remain rendered deterministically by the
  stable sort and are normalized by the next fallback-triggering drop.
- `sortByOrder` and `movePreview` are unchanged (floats sort fine).

### 1e. Visual language matches core
- Dragged row: light translucent background tint + slightly stronger
  border. NO opacity dimming (core reserves `opacity: 0.3` for secondary
  multi-drag items; our shipped `opacity: 0.7` + dashed border is
  off-language — replaced).
- Grip: vertical-dots glyph (`⋮⋮` text approximation of core's
  `IconGripVertical`; the sandbox cannot import twenty-ui icons), muted
  tertiary gray, `cursor: grab` at rest / `grabbing` while dragging.
  Always visible (core hover-reveals handles, but a remote-dom hover
  reveal adds per-row state churn for pure polish — documented tradeoff).
- Poll gating during drag is unchanged and now philosophy-validated: core
  threads `isDragging` flags into refetch effects exactly like our
  `draggingRef` guard.

## Surface 2 — TODAY() staleness: self-heal + indicator

Complication driving the design: `lastEvaluatedAt` is only written when a
value CHANGES (audit finding M3 write-avoidance), so today it means "last
change", not "last evaluation" — unusable as a freshness signal without a
targeted amendment.

- **New engine helper `usesToday(node): boolean`** in
  `src/engine/dependencies.ts` (walker, same family as dependency
  extraction; tested). The widget parses each host expression client-side
  (engine already ships in the front bundle for validation).
- **Truthful heartbeat for TODAY formulas only**: in
  `recordEvaluationHeartbeat` (formula-repository.ts), when the outcome is
  a no-op BUT the expression uses TODAY and stored `lastEvaluatedAt` is
  older than 1h → write `lastEvaluatedAt` alone. Cost ceiling: one extra
  definition write per hour per TODAY-formula (sweep cadence). M3
  write-avoidance intact for everything else.
- **Widget staleness rule**: enabled + usesToday + `lastEvaluatedAt` older
  than 2.5h (≥2 missed sweeps; core's sync-stale threshold is 30min for a
  minutes-cadence pipeline — ours scales the same idea to an hourly
  cadence) →
  - show a muted note under the value: `Computed about 3 hours ago` —
    copy matches core's relative-time idiom (`beautifyPastDateRelativeToNow`:
    date-fns `formatDistanceToNow` with `addSuffix` + `includeSeconds`,
    "now" under 30s, lowercase, "about" on hour-scale). The widget ships a
    small local `formatRelativePast()` replicating the format (cannot
    import twenty-front). Warning color follows core's Status convention
    (orange = warning).
  - **self-heal**: fire `recomputeForRecord` for the viewed record
    (already imported by the widget; throttled to once per 60s per widget,
    same throttle pattern as layout convergence). Key property: this runs
    in the FRONT runtime — a dead worker/sweep no longer means stale
    values on any record someone views, and the note marks what it can't
    reach.
- FormulaDefinition editor page additionally shows the same relative
  timestamp (always, not only when stale) next to the existing heartbeat
  fields — cheap observability.

## Surface 3 — `order` + bookkeeping field lockdown

- The SDK field manifest supports `isUIEditable?: boolean` (verified:
  `twenty-shared/application` `RegularFieldManifest`; server converts it
  to `field_metadata.isUIEditable`, consumed ONLY by the generic UI's
  read-only gate — API/logic-function writes unaffected).
- Set `isUIEditable: false` on all strictly system-managed
  FormulaDefinition fields: `order`, `dependencies`, `lastValue`,
  `lastError`, `lastEvaluatedAt`, `status`, `statusReason`,
  `createdField`. User-intent fields (`name`, `expression`, `enabled`,
  `targetObject`, `targetField`, `targetFieldType`, `currencyCode`,
  `targetFieldSettings`) stay UI-editable — the app's editors are the
  sanctioned path and save-validation triggers cover API-path edits.
- Helper abuse tests lock in tolerance: duplicate ids, single item,
  duplicate/negative/fractional/NaN orders — sort stays total, stable,
  non-lossy; a normalization drop heals any mangle.

## The attack — adversarial gauntlet (after implementation)

Live abuse run, evidence required per item:
1. Touch-emulated drag (Playwright touch), mouse drag, both directions.
2. Click without 8px travel → zero writes (check via order values before/
   after on an all-null list).
3. Pointer leaves widget mid-drag → order reverts, nothing persisted.
4. pointercancel mid-drag (touch-scroll) → same.
5. Rapid successive drags; single-item list drag.
6. API-mangle orders (duplicates, negatives, NaN via direct GraphQL) →
   render stays deterministic; one normalizing drop heals to clean floats.
7. Midpoint exhaustion: script ~50 same-slot drops → fallback reindex
   fires, no precision corruption.
8. Staleness: kill the worker, backdate `lastEvaluatedAt` + stored value
   past a day rollover via direct write, open the record → widget shows
   the note AND self-heals the value with NO worker running; restart
   worker afterwards.

## Deliverables
ADR 0014 (pointer gesture + midpoint positions + cancel semantics,
superseding parts of ADR 0013), ADR 0015 (staleness self-heal +
heartbeat amendment), implementation + tests, gauntlet evidence,
context.md update.

## Explicitly out of scope
Keyboard reorder (user decision), hover-reveal grip polish, two-tab
locking (accepted: stable render + normalization heal), production
deploy.
