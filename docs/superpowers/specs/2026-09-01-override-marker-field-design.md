# Override marker field ("Overrides: Deal Score, Tier")

- Status: Draft v3 (v2 approved; 2026-09-03 user amendment: the field is created on the object's first override-allowed formula, not on its first pin, so it can be positioned before any override exists)
- Date: 2026-09-01
- Target release: formula-field v0.6.0 (new ADR 0031 to be written at implementation)
- Supersedes: the approved-then-invalidated "override toast" direction (the record-page
  Formulas widget only mounts when its tab is active — verified in twenty-front
  `PageLayoutTabsRenderer.tsx:185-187`, which renders exactly one `PageLayoutMainContent`
  for `activeTabId`, with the initial tab being `tabs[0]` by position while the Formulas
  tab sits at position 1000 — so no toast from it can fire on plain record open).

## 1. Problem and chosen surface

An overridden formula value is indistinguishable from a computed one everywhere except
the Formulas tab. Overrides are per-record state, an app cannot decorate Twenty's native
field cells, and no app-rendered surface mounts on record open. The only per-record
surface visible on record open (and in list views) is record data itself.

**Design: one app-managed, view-only TEXT field per target object, label `Overrides`,
holding the comma-joined labels of the formula fields currently overridden on that
record (`Deal Score, Tier`), blank when none.** It renders as an ordinary field in the
record page Fields card, is addable as a list-view column, and is filterable ("records
with overrides" views come free).

The app does **no** layout convergence for it (the ADR 0021 lesson: viewField mutations
reject application tokens, so any convergence is user-token, render-triggered, and
unreliable). The user reveals and positions the field once per object like any custom
field. Whether a freshly app-token-created field lands visible or in the hidden-fields
section is one of Task 0's probe questions (§10).

This is not a revival of the ADR 0021 FxStatus chip. That chip died of three costs:
one field per formula, render-time layout convergence, and bulk value syncs across all
records on every definition status flip. The marker is one field per object, gets no
layout convergence, and its value is per-record state that changes only on pin
transitions, which are human-paced.

## 2. Cost model

Every operation pays rent; here is the ledger. The event-lane gate (§5.2) is
`pin upserted in this invocation OR updatedFields contains the marker` — deliberately
**not** actor-based: app writes can inherit the triggering user's `workspaceMemberId`
(ADR 0006 observed this live), so actor absence proves nothing and is used nowhere.

| Operation | Frequency | Cost |
|---|---|---|
| Field creation (ensure) | On a definition creation that already carries a target object, and on an update whose diff touches `targetObject` or `allowOverride` while the definition is override-allowed with a target. Human-paced: the wizard's real path is one name-only draft creation (skipped — no target) plus one target-setting update | 1 uncached field lookup (the full metadata pull) + 1 `createOneField` when the field is absent. Gating the update arm on those two field names, rather than on "any update", is what keeps expression edits and row-image fallbacks from paying that pull |
| Event lane marker step | Only when this invocation actually upserted a pin, or `updatedFields` contains the marker | +1 `loadActiveOverridesForRecord` query; current marker value from the event `after` payload (`null` → blank; an absent key falls back to a fetch — cold path, §5.2); write only on diff |
| App echo events (value-field writes) | Every recompute write | Zero marginal cost: no pin upsert happens and `updatedFields` lacks the marker → step skipped by the gate, regardless of inherited actor |
| Marker-write echo | One per marker write | The refired event has `updatedFields = [marker]` → one pin query, converged compare, no write. Terminates via the diff guard (§6) |
| Widget toggle on/off | Per toggle | Zero extra reads (front state already holds definitions + overrides); 1 record write only on diff |
| Definition disable / trash / destroy | Per event | Pin enumeration for that column (paginated — a fix this work adds, §5.4) + marker convergence for exactly those records |
| Hourly sweep backstop, pin arm | Per object with ≥1 override-allowed enabled definition | 1 object-scoped pin query + batched reads over its candidates; writes only on diffs; own budget slice (§5.5) |
| Hourly sweep backstop, dirty-marker arm | Per marker-bearing object, unconditionally (this arm is the staleness repair — gating it on definitions is what §5.5 step 1 forbids) | 1 `NOT_NULL`-filtered record query, empty on converged objects; batched reads + diff writes otherwise |
| Marker-field cleanup (sweep) | Hourly, per marker-bearing object with no enabled definitions | The has-a-field verdict rides the shared 60s-cached `loadAllObjectsWithFields` catalog, but reaching the arm costs a `hasLiveDefinition` `first: 1` probe plus a paginated `loadTrashedFormulas`, and the delete itself an uncached `findFields`: ~1 query/hour for an object whose definitions are merely all disabled, 3+/hour for a definition-less one until the delete lands. An object that still has an enabled definition never reaches the arm (zero record I/O) |
| Steady state, no overrides anywhere | — | Marker fields exist only on objects with override-allowed formulas and stay blank; event lane pays only the gate check (in-memory); the dirty-marker arm's NOT_NULL query returns empty |

Rejected on cost grounds: computing the marker inside `recomputeAllRecords`'s
per-record loop (would need a per-record pin query the loop currently avoids via one
`Set` per definition, and only sees one definition's pins at a time).

## 3. Field contract

- API name `fxOverrides`, label `Overrides`, type TEXT, one per target object,
  created when a definition first becomes override-allowed with a target object
  (§5.1 — creation or a later update, since the wizard sets the target after the
  draft exists), so the user can position it in the Fields card before any override
  exists.
- `isUIEditable: false` **at creation** — confirmed one-shot: `updateOneField`
  whitelist-drops the flag (ADR 0028), so it must be set in the `createOneField` input,
  same as the app's other system-managed fields.
- Description: `Formula fields currently overridden on this record. Managed by the
  Formula Field app.`
- Not a formula target, not in any definition's dependency set, invisible to override
  detection (detection iterates formula target fields only).
- **Excluded by name from variation sync's syncable-field set.** Without an explicit
  exclusion in `computeSyncableFields`, the marker qualifies (active, non-system, TEXT
  is in the syncable kind union, and it is deliberately not a formula target — so the
  one existing exclusion misses it): the primary's marker would be copied over every
  variation's correct marker, and a diverging-edit detection on it would mint
  `FormulaOverride` pins keyed on `fxOverrides`. The exclusion is added alongside the
  `formulaTargetFields` exclusion and pinned with a test. The front bundle's replica of
  that exclusion chain (`variation-setup-logic.ts` `countSyncableFields`) gets the same
  name filter — without it the variation wizard's eligibility count includes the marker
  (cosmetic, but cheap to fix in the same stroke).
- **Counted as formula-managed by timeline cleanup.** The marker is in neither of
  `timeline-cleanup.ts`'s managed sets today (it is not a formula target, and §3 just
  excluded it from the variation set), so every marker write would leave a permanent
  "Overrides changed" timeline entry, and a marker key riding in the same diff as a
  value write would downgrade a deletable noise row to merely-stripped. Fix: add the
  marker name to `loadFormulaManagedByObject`'s per-object set, alongside
  `targetField` and `companionFieldName`. Accepted residue: that loader only registers
  objects that still have definitions, so the final blank-out writes on an object whose
  definitions were all destroyed leave one transient timeline row per record until
  §5.5 step 5 deletes the field — self-limiting, not worth machinery.
  **Scope of the strip (corrected after the live run):** all of the above applies only
  to rows the app authored. `cleanupFormulaTimelineNoise` filters its candidates on
  `workspaceMemberId: { is: NULL }`, so a human-authored row is never fetched and never
  rewritten — deliberately, since the app must not edit a person's own timeline entry.
  When a marker write lands close enough to a human edit of the same record, the
  platform coalesces both into the human's single row, which then carries that human's
  `workspaceMemberId`; the `fxOverrides` key stays in that row's diff permanently. The
  live run observed exactly this (one row, diff
  `{formulaTest: 4→99, fxOverrides: ""→"Formula Test"}`, `createdBySource MANUAL`,
  untouched by the 10-minute cron). This is a cosmetic co-tenancy in a row the user
  already expects to describe their own edit, not a leak of app noise: the marker key
  is only ever there because a human's own edit created the override it names.
- The field is derived state, never user-authored — safe to delete or rewrite wholesale.

## 4. Value semantics

Expected marker for a record =

1. Take this object's **enabled** `FormulaDefinition`s with `allowOverride !== false`
   (legacy null reads as allowed, matching the widget). Enabled-only is a deliberate
   choice so all three lanes share one definition set: the server lanes' loaders
   hard-filter `enabled: { eq: true }` (`formula-repository.ts:41`), and the widget
   filters its rows to `enabled` for marker math. Consequence to disclose: disabling a
   definition drops its label from markers until re-enabled (its pins still exist and
   the Formulas tab still shows them); trashed definitions are excluded the same way.
   Gate/frozen status is still ignored — a pin on a frozen definition is a pin.
   (Gate question §9.1 if this semantic is wrong.)
2. Keep those whose `targetField` has a `formulaOverride` row with `active: true` for
   this record. Joining through definitions automatically excludes variation-sync pins
   (no backing definition) and stray pins on locked definitions — which the server
   ignores and reverts (ADR 0028 D2), so the marker must not report them.
3. Dedupe by `targetField` (two definitions can target one column after a
   delete/recreate); label each as `definition.name || definition.targetField`, the
   app-wide labeling rule (`status-toast.ts:36`).
4. Sort by `order` ascending nulls-last, then label — the Formulas tab's display order.
   `order` is not currently selected server-side; add `order: true` to `FORMULA_FIELDS`
   in `formula-repository.ts` (one extra scalar, no extra round trip).
5. Join with `", "`. Empty set → `''` (which the platform stores as SQL NULL; the
   convergence rule in §6 makes that safe).

No truncation: a record cannot have more overridden fields than the object has
override-allowed formulas, and TEXT has no practical limit at that scale.

Known ceiling: the widget loads `first: 100` definitions unpaginated
(`formula-editor.tsx:277`) while server lanes paginate fully. Past 100 definitions the
widget's marker math (and its tab display, already) diverges. Documented, not fixed
here — such a workspace has a broken Formulas tab regardless.

## 5. Write paths

Marker writes always follow compute-expected → compare (`valuesEqual('TEXT', …)` with
the §6 normalization) → write only on diff, and run under the app token (server lanes)
or after an explicit user action (widget lane).

### 5.1 Field creation (server-side, on the transition to override-allowed with a target)

`upsertOverride` currently returns `Promise<void>`; this work changes it to report
whether it created, updated, or no-opped — that signal drives the §5.2 gate.
Field creation itself hooks `handleFormulaChange` above every early return, and fires
when `after.allowOverride !== false` and `after.targetObject` is set **and** the event
is either the definition's creation (`resolveChangedFields` returns `undefined`, which
happens exactly when there is neither an `updatedFields` list nor a `before` image) or
an update whose changed fields include `targetObject` or `allowOverride`. It then calls
the ensure helper before validation — uncached `findFields` lookup (mutations need live
state), then `createOneField` under the app token. The update arm is not defensive
breadth: it is the only arm the product's own wizard reaches, since the wizard's first
write is a name-only draft with no `targetObject` and the target arrives in a later
update, so a creation-only gate never fired on the real user path and the field showed
up only on the next hourly sweep, up to an hour late (found by the live checklist run,
2026-09-03; ruling R10). Locked definitions do not create the field (they can never
carry a pin; ADR 0028 makes the lock create-time-only).
Failure is non-fatal; the sweep retries the ensure hourly for any object that has ≥1
enabled override-allowed definition but no marker field, which also migrates
workspaces whose definitions predate this release. Rationale (user, 2026-09-03):
the field must exist before the first override so it can be positioned in the Fields
card up front.

Authority: app-token **metadata mutation is precedented** — `fx-status-cleanup.ts`
runs `updateOneField` and `deleteOneField` under the app token from the sweep, and the
role carries `canUpdateAllSettings: true` documented for exactly this
(`default-role.ts:19-28`). Only `createOneField` specifically has no in-app precedent
(ADR 0008 chose the front-side path on error-surfacing grounds, not feasibility).
Task 0 (§10) probes both the create and — the genuinely open question — whether the
created field is *visible* in the record page UI, since the app cannot create
viewFields (viewField mutations reject application tokens, `fx-status-field.ts:113`).
Fallback if the platform refuses app-token creates: the wizard and record-page widget
ensure the field front-side under the user token, accepting that pre-existing
definitions get their marker only when someone with DATA_MODEL next opens the tab.

### 5.2 Event lane (`handle-record-update.ts`)

The handler has exactly one return; every skip is a `continue`, so a marker step
appended at the end runs on both the mirror and engine sub-lanes. Gate — run only when:

- this invocation's `upsertOverride` calls report ≥1 created/updated pin
  (pin state changed here), **or**
- `updatedFields` contains `fxOverrides` (marker tamper, or our own marker-write echo).

Everything else skips free: app recompute echoes upsert nothing, human edits that
didn't pin anything upsert nothing, unrelated-field edits upsert nothing. The gate
never consults `actorWorkspaceMemberId` (ADR 0006: app writes can inherit it).

When it runs:

- `loadActiveOverridesForRecord(client, objectName, recordId)`
  (`override-repository.ts:86-121`) — one query, after the handler's own upserts so a
  just-created pin is included.
- Expected string per §4; definitions already in memory (`loadAllEnabledFormulas`
  includes `name`).
- Current value = `after[markerFieldName]`. `null` normalizes to blank (ADR 0030
  territory). **A key absent from `after` is unknown, never assumed blank**: assuming
  blank fixes the expected-blank cell but inverts the loop in the expected-non-blank
  cell (blank ≠ "Deal Score" → write → echo still lacks the key → write, unbounded).
  On an absent key, fetch the record's marker value before comparing — likely
  unreachable for TEXT (`handle-record-update.ts:506-511` records TEXT as a plain
  scalar the engine lane already trusts `after` for), so the fetch is a defensive
  cold path, not a per-event cost. Marker field missing from the catalog → skip the
  step (creation lags by design).
- Diff → single write via `flushBatchedWrites` (importable here, no cycle). The event
  lane never creates the field: a missing field means creation lags (or the object
  only has locked definitions) and the step simply skips.

Tamper self-heal: a direct API edit of `fxOverrides` lands in the second gate arm and
is reverted to the computed string.

`on-record-created.ts` never detects overrides (no actor passed), so record creation
needs no marker step: a new record has no pins.

### 5.3 Widget toggle (`formula-editor.tsx` `toggleOverride`)

Toggle-off can converge without any record-value write (deactivate pin → recompute
produces the pinned value → no-op guard, `recompute.ts:1044-1046` → no event), which
would leave the marker stale for up to an hour. So after a successful
activate/deactivate, the widget recomputes the expected marker from the state it
already holds (`definitions` filtered to `enabled`, `overrides`, just mutated) and
writes it directly (user token) with the same diff guard, then refreshes local display
state. `isUIEditable: false` should block UI editing, not API writes — consistent with
the server DTO mapping, but no app precedent exists for a *user-token* write to such a
field; Task 0 probes it (§10).

### 5.4 Definition disable, trash and destroy

Destroy (`handleDefinitionDestroyed`) today enumerates pins on the destroyed column
with `first: 200`, selecting only `id`, and deletes them with no shared-column guard.
This work fixes all three as prerequisites, since the marker makes the defects visible:

- select `recordId` too (the convergence step needs it; the current selection has no
  record ids in scope),
- paginate the enumeration (>200 pins currently under-deletes silently),
- consult `anotherDefinitionTargets` before deleting: destroying one of two
  definitions sharing a `targetField` must not erase the survivor's pins (today it
  does; the marker would then wrongly report those overrides gone).

Pin deletion here is Twenty's **soft** delete (`canDestroyAllObjectRecords: false` —
hard destroy is not grantable for this object), which matters for §5.5's candidate
set. After deletion, converge the marker for exactly the affected records.

Soft-trash (`handleDefinitionDeleted`) keeps pins ("formula columns are holy") but the
trashed definition leaves the enabled set, so its label must leave markers too (§4
step 1): the trash handler runs the same enumerate-and-converge step, without deleting
anything.

**Disable** is the same boundary: a plain disable (`changedFields = ['enabled']` plus
platform-managed fields) returns from `handleFormulaChange` at the *first* disabled
guard (`handle-formula-change.ts:137-144`, the `disabled-bookkeeping` return — not the
`:151` guard, which only sees already-disabled definitions being edited), and no
record work runs, so a disabled definition's label would sit in markers with no
event-lane repair. The convergence step hooks **above** the `:137` guard, gated on
`after.enabled === false && changedFields?.includes('enabled')`. Deliberate
consequence: it also fires on the app's own disable-on-cycle write
(`{ enabled: false, lastError }`) — semantically correct, the definition did leave the
enabled set — while the `includes('enabled')` gate keeps pure bookkeeping writes from
paying for it; running work above what is otherwise a recursion guard is confined to
this one step. Re-enable and restore are covered by the sweep backstop and by the next
pin event.

### 5.5 Hourly sweep backstop (`formula-sweep.ts`)

New pass after `cleanupCompanionFields`, **before** the per-definition recompute loop,
with its own deadline slice (~15s of `SWEEP_BUDGET_MS`) so the recompute loop — which
is allowed to consume the whole remaining budget — cannot starve it, and vice versa.
Best-effort and cursorless, but deliberately **not** order-fixed: what converges as
markers settle is the *write* set, not the time cost — a fully converged
marker-bearing object still pays its pin query and its `NOT_NULL` dirty scan every
hour — so a fixed iteration order would truncate at the same object every pass and
starve every object after it forever, and the pin/dirty arms are the only repair path
for a record whose marker outlived its cause. The pass therefore rotates its start
offset over a stably sorted object list by an **epoch-hour counter**
(`Math.floor(now() / 3_600_000) % objectCount`), which advances every pass whatever
the object count, so every object reaches the head of the list within N passes for any
N, with no cursor to store, corrupt or reset. An hour-of-day offset was rejected in
review: it takes only 24 values, so any workspace with more objects than 24 plus the
number covered before the deadline starved its tail just as badly. Grouped per object
(not per definition):

1. The pass runs for **every object that has a marker field** (from the shared cached
   catalog), plus objects with enabled override-allowed definitions but no marker
   field (ensure step). The *pin*
   arm below is additionally gated on the object having ≥1 override-allowed enabled
   definition; the *dirty-marker* arm is never gated on definitions — its whole job is
   finding records whose marker outlived its cause, including the case where the
   object's last enabled definition was disabled or trashed and the expected marker is
   now blank for everyone. (Gating the whole pass on enabled definitions would make
   exactly those markers permanently unrepairable.)
2. Ensure step: object has ≥1 enabled override-allowed definition but no marker
   field → retry §5.1's creation (covers failed creates and pre-release definitions).
3. Candidate records = ids from an object-scoped pin query (`{ targetObject: { eq } }`
   on formula target fields, **any** `active` state — deactivated rows persist and
   mark records that lost their last active pin) ∪ ids from a dirty-marker record
   query (`{ [marker]: { is: NOT_NULL } }` — expressible, precedent at
   `variation-sync.ts:978`; ADR 0030 confirms blank TEXT stores as SQL NULL, so
   NOT_NULL means non-blank). The dirty-marker arm is load-bearing, not just a tamper
   net: destroyed definitions' pins are soft-deleted out of the pin query's scope, and
   a fully disabled object has no enabled definitions to hang the pin arm on — both
   record classes are *only* reachable through it.
4. Batch-read candidates' marker values, compute expected per §4, diff,
   `flushBatchedWrites`.
5. Field cleanup, mirroring `fx-status-cleanup`'s deactivate-then-delete ordering and
   per-field try/catch: an object with **zero** definitions in any state (live or
   trashed — enumerated with pagination, not the precedent's unpaginated `first: 200`)
   but a surviving `fxOverrides` field → deactivate, then delete. Field discovery
   rides the shared 60s-cached catalog, but the arm itself is not free: reaching it
   costs the `hasLiveDefinition` probe plus the paginated trashed load, and the delete
   an uncached `findFields` (§2's ledger carries the per-hour numbers).

The pin query needs a new object-scoped loader (`loadOverriddenRecordIds` is
field-scoped); same pagination pattern.

## 6. Convergence and loop safety

- **The diff guard is the sole recursion terminator, same as ADR 0004's argument for
  value writes.** A marker write refires both wildcard `*.updated` triggers (the
  object is not excluded). Formula lane: the echo's `updatedFields = [marker]` passes
  the §5.2 gate, recomputes the marker from unchanged pin state, compares equal, and
  stops — one bounded echo per real marker change, never a cascade. Actor inheritance
  (ADR 0006) is irrelevant because nothing consults the actor. Variation lane: the
  marker is excluded from the syncable set by name (§3), so `fxOverrides` in
  `updatedFields` matches nothing there.
- The marker is TEXT, so it inherits the F3 hazard: the platform stores `''` as SQL
  NULL, and the event payload may omit the key entirely. Every comparison goes through
  `valuesEqual('TEXT', …)` / `textValuesConverged` (blank ↔ blank equal, ADR 0030);
  `null` normalizes to blank, and an absent payload key is treated as unknown and
  fetched, never assumed (§5.2) — a converged marker must never rewrite, in either the
  blank or the non-blank cell.
- Override detection cannot mint a pin for the marker itself: detection iterates
  formula target fields only, and the marker is never one.
- A user *can* write a formula that reads `fxOverrides` (it is an ordinary TEXT
  field). That formula recomputes whenever the marker changes — converging, not
  cycling, since the marker step's gate ignores value-write echoes. Documented as an
  oddity, not defended against.

## 7. Testing

Mirror the existing FakeClient style (`logic-functions/lib/__tests__/`, seed + assert
`client.mutations` / `client.writes`; no module mocks):

- Marker computation unit: pure function (definitions + pin rows → expected string):
  label fallback, order/nulls-last sort, targetField dedupe, disabled-definition
  exclusion, locked-definition exclusion, variation-pin exclusion (pin row with no
  matching definition), blank on empty.
- Event lane gate: human edit creating a pin writes the marker once and no-ops on
  re-run; app echo (no pin upsert) does zero marker work **even with an inherited
  actor in the payload**; unrelated-field human edit does zero marker work; marker
  tamper reverts; marker-write echo terminates (second invocation converges, zero
  writes); blank-over-blank never writes (F3 guard); an `after` payload missing the
  marker key triggers a fetch and then converges with zero writes in **both** the
  expected-blank and expected-non-blank cells.
- Lifecycle: a plain disable (`changedFields = ['enabled']`) converges markers above
  the `disabled-bookkeeping` guard (`handle-formula-change.ts:137`); a pure
  bookkeeping write (no `enabled` in `changedFields`) does zero marker work.
- Timeline cleanup: a marker key counts as formula-managed — an app-only diff
  containing it is still deleted, and a marker write alone leaves no surviving
  timeline noise; `computeSyncableFields` and the front replica `countSyncableFields`
  both exclude the marker.
- `upsertOverride` return signal: created vs updated vs no-op, and the no-op case
  keeps `client.mutations === 0`.
- Syncable-set exclusion: `computeSyncableFields` never returns `fxOverrides`;
  variation primary-update sync does not copy it; diverging-edit detection on it mints
  no pin.
- Lifecycle lanes: trash converges markers without deleting pins; destroy paginates
  past 200 pins, spares a shared column's pins (`anotherDefinitionTargets`), and
  converges exactly the affected records.
- Sweep: candidate-set construction (any-active pins ∪ dirty markers), deadline-slice
  truncation resumes cleanly next pass, ensure retry, zero-definition field cleanup,
  `client.mutations === 0` on a fully converged pass.
- Widget toggle marker math: pure-function test only (no front-component rig exists,
  per ADR 0028); the toggle write itself goes on the live checklist.

## 8. Out of scope

- Any list-view badge or native cell decoration (platform-impossible for an app).
- Per-formula marker fields (ADR 0021 costs).
- Correcting ADR 0021's overstated "passive signal on record open" claim for the
  status toasts — real, but a separate docs/design follow-up.
- MULTI_SELECT chips instead of TEXT (option drift + membership machinery for zero
  extra information; the user asked for exactly the text style).

## 9. Open items for the user gate

1. §4 step 1: enabled-only semantics — a disabled or trashed definition's overrides
   drop out of the marker until re-enabled (pins survive; the tab still shows them).
   Chosen so all three lanes share one definition set at zero extra query cost.
   Confirm or flip to any-live (costs a new unfiltered loader in both server lanes).
2. Field API name `fxOverrides` (follows the app's `Fx` convention, avoids colliding
   with a plausible user field named `overrides`) — confirm.
3. No cloud workspace is installed; this ships on a new branch off main as v0.6.0
   work, local verification only.

## 10. Task 0 — assumptions to probe locally before building

1. App-token `createOneField` succeeds (no in-app precedent; role grant says yes).
2. The created field is **visible** somewhere reachable on the record page (Fields
   card, or hidden-fields section requiring a one-time user reveal) — the app cannot
   create viewFields, so this is platform behavior we've never exercised.
3. A front-component **user-token** record write to an `isUIEditable: false` field
   succeeds (§5.3 depends on it; server DTO mapping suggests yes, no precedent).

Any probe failing flips to its named fallback (§5.1) or returns to the user before
implementation proceeds.
