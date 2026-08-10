# ADR 0028: Create-time override lock

**Status: IMPLEMENTED (design approved 2026-08-07; implemented 2026-08-10).**
Build spec: `docs/superpowers/specs/2026-08-07-v040-build-and-roadmap-design.md`
(repo root `docs/`, §2 "Feature A′", §5 cost model, §7 parked runtime toggle).
Implementation plan:
`docs/superpowers/plans/2026-08-10-v040-create-time-override-lock.md` (14 tasks).
Narrows ADR 0006 (manual per-record override) with a per-definition opt-out
chosen once, at field-creation time.

## Context

ADR 0006 made every formula value field globally editable: a human edit is
detected by comparing the written value against the computed value (never by
actor, since a recompute write inherits the triggering user's id) and pins that
record with an ACTIVE `FormulaOverride` row. Users asked for the opposite
posture for some formulas — a **view-only** computed field, where the value is
never a thing a person types over.

The obvious shape is a runtime toggle: flip a definition between "overrideable"
and "locked" whenever you like. **The platform forbids it.** `createOneField`
honors `isUIEditable` on the create input
(`get-default-flat-field-metadata-from-create-field-input.util.ts:63-67` —
`createFieldInput.isUIEditable ?? (isDefined(isUIReadOnly) ? !isUIReadOnly :
true)`, i.e. the flag wins outright when supplied), but `updateOneField`
runs its raw input through `sanitizeRawUpdateFieldInput`
(`sanitize-raw-update-field-input.ts:35-43`), which whitelist-filters the input
down to `FLAT_FIELD_METADATA_EDITABLE_PROPERTIES` — a set that does not contain
`isUIEditable`. An update carrying the flag is not rejected; it is **silently
dropped**. So a field's UI editability is fixed at birth and there is no
supported call that changes it afterward.

That leaves exactly two honest designs: pursue the platform gap upstream, or
make the choice permanent and say so. Filing the `isUIEditable` update-lane gap
upstream **was offered to the user and declined on 2026-08-07**; it is not
tracked. This ADR therefore takes the second option — a create-time choice,
warned about before it is made — and the original runtime-toggle feature stays
parked as an upgrade path (see "Upgrade path" below).

Front-end enforcement of the flag is real, not cosmetic: `isRecordFieldReadOnly`
(`isRecordFieldReadOnly.ts:55`, `!(fieldMetadataItem.isUIEditable ?? true)`)
greys the field out in table, detail and kanban views. But it is **UI-only** — a raw GraphQL record write from the API or an
integration still lands. Making "locked" mean something against non-UI writers
is what most of the server lane below exists to do.

## Decision

### D1 — `allowOverride`, a create-time boolean on the definition

A new `allowOverride` field on FormulaDefinition (`FieldType.BOOLEAN`,
universalIdentifier `436befd0-e824-4d85-a79f-2b02460c43e3`, `defaultValue:
true`, icon `IconLock`). The wizard writes `false` when the user opts out; it is
never mutated afterward. Every read site tolerates null (`allowOverride ?? true`
/ explicit `=== false` tests), so a row that predates the column reads as
"overrides allowed".

**Permanence is enforced, not asserted.** The field is declared
`isUIEditable: false` in the manifest — the same system-managed-field convention
already used by `dependencies`, `lastError`, `createdField` and `scanCursor`.
Manifest-declared fields go through the create/compare path where the flag *is*
honored, and because the flag is UI-only, the wizard's own definition write
still lands. Without this, a raw record-page flip on the FormulaDefinition row
would produce incoherent states: a definition claiming "locked" whose value
field is still editable (behavioral skip, no grey-out), or a locked field whose
already-written pins suddenly start counting again.

`allowOverride` joins the **definition-lane inert set**
(`INERT_FIELDS`, `handle-formula-change.ts:54`, alongside `name` and
`description`): a wizard draft write of the flag must not trigger validation or
a full-object recompute, because nothing in the definition lane reacts to it.

### D2 — Server lane: skip, ignore, revert

No transition branch, no metadata updates, no pin deactivation, no self-heal —
the flag is immutable and locked definitions never accumulate pins of their own.
Three edits carry the whole behavior:

1. **Detection skip.** One `continue` in the per-definition skip block
   (`handle-record-update.ts:301`), which sits *above* the mirror fork, so a
   locked definition never runs override detection in either the engine or the
   mirror lane, from one edit.
2. **Pin-ignore at the respect fork.** The single-record **event** path honored
   ACTIVE pins unconditionally; it is now conditioned on
   `(formula.allowOverride ?? true)` (`handle-record-update.ts:470`). This is
   **required, not defensive**: pins on a locked field *can* exist, because
   variation sync writes ACTIVE rows in the same
   `(targetObject, targetField, recordId)` key space and the API can write them
   directly. Locked definitions skip the `findOverride` lookup entirely rather
   than looking it up and discarding it — see the cost model. **Scope note:**
   this is the event lane only; the full-object scan lane keeps honoring pins
   unconditionally — see the accepted limitation below.
3. **Actor-independent event revert.** With detection skipped, an outside write
   touching only the value field engages neither recompute case (a formula's
   target is never its own dependency), so a revert would otherwise be
   sweep-eventual (≤1h). The `eventAffectedFormulas` predicate is actor-gated
   (`actorWorkspaceMemberId && updatedFields && …`) and an API or integration
   write carries no member id, so a locked definition would have been excluded
   from the pre-pass — leaving the revert kind-blind (no entry in
   `eventFieldKindsByObject`) and ungated (no entry in `gateErrorByFormulaId`).
   The fix is a second, **actor-independent** branch in that predicate for
   locked definitions whose `targetField` appears in `updatedFields`
   (`handle-record-update.ts:194-202`), so kinds and the strict gate are
   computed before the revert runs; and a `lockedTargetTouched` term widening
   **Case 1** (`:448-458`) so the existing single-record recompute body *is* the
   revert lane. No new lane, no new queries.

### D3 — Locked targets leave the variation-syncable set unconditionally

Variation sync's syncable set previously excluded **enabled**-formula targets
only. Every freshly created locked definition is DISABLED until its first valid
expression saves, so in that window a variation config on the same object could
pin the locked field, and the pin would persist after the formula enabled. D2's
pin-ignore keeps recompute from honoring such a pin, but the variation widget
would still show the field as diverged, and revert-vs-re-pin churn between the
two lanes is possible.

Ruling: **locked formula targets leave the syncable set regardless of enabled
state** — "off = fully computed, no exceptions". The sync-exclusion loader was
renamed `loadSyncExclusionFormulasCached` (it is no longer an "enabled formulas"
loader) and its filter widened to
`or: [{ enabled: { eq: true } }, { allowOverride: { eq: false } }]`
(`formula-repository.ts:141-143`, consumed by `syncable-fields.ts:52`). The
`or` form is deliberate: `BooleanFilter` is `{eq, is}` only, and `eq: true`
excludes null, so "true-or-unset" can never be expressed as a single clause.
The recompute paths keep using the uncached enabled-only loader.

### D4 — UI: choose once, warned; then read-only everywhere

- **Wizard, both paths** (format and mirror — mirrors get overrides too): step
  **"5 · Overrides"**, a ChoiceChip pair defaulting to "Allow manual overrides",
  persisted in the resumable draft through the generic `persistDraft`
  passthrough on the real definition field (**not** `targetFieldSettings` JSON,
  which is reserved for display settings). Choosing "Locked" surfaces a
  `BannerWarning` stating the permanence in full: the setting cannot be changed
  after the field is created; changing it later means deleting the formula and
  recreating the field, and a deactivated old field can still reserve the name.
  Zero extra calls: `isUIEditable: allowOverride` rides both existing
  `createOneField` payloads (`formula-setup-wizard.tsx:680` engine/format,
  `:774` mirror) and `allowOverride` rides the existing `finalizeCreation`
  definition write.
- **Record-page Formulas tab**: the per-record Override toggle is not rendered
  for locked rows (`formula-editor.tsx:1010`).
- **Definition editor**: a read-only status line — `Overrides: allowed` /
  `Overrides: locked at creation` — placed *after* the field-settings ternary
  and before the description editor, so mirror definitions (which get a
  provenance line instead of Field settings) see it too. No toggle; the value is
  immutable.
- **Projection widening.** `allowOverride` had to join five sites or it would
  read `undefined` and be masked by `?? true` into "the lock does nothing": the
  server-side `FORMULA_FIELDS` selection (`formula-repository.ts:24`), the
  record type (`types.ts:49`), and both front components' queries plus their
  normalizers (`formula-editor.tsx:292`/`:321`,
  `formula-definition-editor.tsx:414`/`:442`). The server selection is pinned by
  **contents**, so a silently dropped field fails a test instead of degrading
  into "lock does nothing"; the front sites have no test rig (see Testing).

## Accepted limitations

Carried from the build spec §2.5, plus one found during implementation review.

- **Permanent, by platform constraint.** The escape hatch is delete + recreate.
- **No retroactive lock.** Existing definitions' fields already exist and cannot
  be made view-only; every deployed cloud definition (19 enabled at last count)
  stays overrideable.
- **API-created definitions with `allowOverride: false` against a pre-existing
  unlocked field get the behavioral skip only** — no grey-out, because the field
  was not created with the flag. Documented, not fought. This divergence is
  **API-only by construction**: the wizard can never create a definition against
  a pre-existing field (`existingField` drives `collision`, and `canCreate`
  requires `!collision`), so there is no wizard branch to build a lock path for.
- **Interrupted wizard** (field created, `finalizeCreation` never ran) re-shows
  the wizard with the name now collision-blocked. That is pre-existing behavior
  this ADR does not change, and nothing here should be read as implying that
  resume-after-partial-create works.
- **`isUIEditable` is UI-only.** Raw API writes land and are then reverted
  event-driven (D2.3). A locked field is strictly view-only for UI users and
  *eventually*-computed against API writers.
- **The D3 guarantee is bounded by a 60-second cache TTL.** The sync-exclusion
  loader is cached per workspace for 60s and, although
  `invalidateEnabledFormulasCache` exists, **it has no production caller** — it
  is exercised only by tests. So a locked definition created while a workspace's
  cache is warm can have its target pinned by a variation-sync pass for up to
  60 seconds after creation. The consequence is bounded by defense in depth: the
  locked engine ignores rogue pins anyway (D2.1 detection skip + D2.2
  pin-ignore), and D2.3's event revert restores the value; the residue is one
  ignored ACTIVE override row plus one wasted write. This is the *same*
  staleness the design already accepted for enabled-formula targets, which have
  always been excluded through this same cache — locking does not introduce the
  window, it inherits it. **Available follow-up:** calling
  `invalidateEnabledFormulasCache` from the locked-definition create path would
  close the window; not done in this arc.
- **Pin-ignore is event-lane only; the full-object scan lane still honors a
  rogue pin.** D2.2 conditions the *single-record event* path on
  `allowOverride`, but `recomputeAllRecords` — the lane used by the
  definition-change handlers and the hourly sweep — loads
  `loadOverriddenRecordIds` once per pass and skips any pinned record
  (`recompute.ts:788`) with **no** `allowOverride` condition. So while an ACTIVE
  rogue pin exists on a locked target, that record keeps converging through the
  event lane (every write to it reverts, D2.3) but loses its **sweep backstop** —
  the mechanism that exists precisely to catch missed events. Reaching this state
  requires a rogue pin in the first place, which only the TTL window above or a
  direct API write to `FormulaOverride` can produce, and it self-clears when the
  pin is deactivated. Recorded as a known asymmetry rather than fixed here: the
  fix is small (don't pass `overriddenRecordIds` for a locked definition) but
  wants its own test, and it did not surface until this ADR was being written
  against the landed code.

## Cost model

Per the standing efficiency-first rule, every operation pays rent.

- **Zero new hot-path queries.** `allowOverride` rides the definition loads that
  already run (one more scalar on selections already being issued). No new load,
  no new round-trip, no sweep addition.
- **The locked path is net *cheaper* per human edit.** Override detection
  short-circuits earlier (D2.1), and the respect fork **skips the per-event
  `findOverride` lookup entirely** for locked definitions (D2.2) rather than
  issuing it and discarding the result — a query removed, not added.
- **One widened query per variation-sync pass** (D3) is the only recurring cost
  Feature A′ adds anywhere: the same single paginated query it always issued,
  with an `or` clause instead of a bare `enabled` filter. It runs only where
  variation configs are enabled, and only on cache misses.
- **One bounded echo compute per outside write to a locked field.** The revert
  writes the computed value back; that write raises its own `*.updated` event,
  which re-enters Case 1 once, finds the stored value already correct, and
  write-avoids — so the chain stops after exactly one extra compute. Termination
  is **test-pinned**, not argued
  (`handlers.spec.ts:1315`, "locked definition: the revert echo terminates").
- **Wizard OFF adds zero extra calls** — both flags ride payloads that were
  already being sent.

## Upgrade path

If the platform ever adds `isUIEditable` to
`FLAT_FIELD_METADATA_EDITABLE_PROPERTIES`, `allowOverride` upgrades from a
create-time choice into a **runtime toggle** with no data-model change: the flag
is already the single source of truth, already null-tolerant, and already read
at every decision point.

That arc must then inherit the round-1 review constraints catalogued in
`docs/superpowers/specs/2026-08-07-v040-build-and-roadmap-design.md` §7 — the
ones this create-time design did not have to consume, each of which becomes live
the moment transitions exist:

- transition-branch placement relative to the `enabled: false` guard (the branch
  must sit after `changedFields` resolves);
- batch pin-deactivation (`loadOverriddenRecordIds` selects `recordId` only, so
  the naive shape is 2 round-trips × N — use the chunked `batch-write.ts`
  pattern);
- straggler self-heal in the per-pass override-id load;
- the create-path transition gap (`on-formula-definition-created` passes
  `updatedFields: undefined`);
- a mandatory post-write read-back, since a silently dropped metadata update is
  otherwise undetectable;
- trash/restore lock stranding;
- table-view visibility of the flag.

App-token metadata permissions are already proven workable for this class of
write, so the toggle is a permissions-clear design the day the platform opens
the property.

## Not done

- **Retroactive locking of existing fields** — impossible without the platform
  change above.
- **A per-record lock.** `isUIEditable` is column-level, not per-record (the
  long-standing limitation recorded in the README); nothing here changes that.
- **Deactivating pins that already exist on a locked target.** Locked
  definitions never *create* pins, and D2.2 makes a stray pin inert on the event
  lane, so a dedicated cleanup pass was judged pure cost. The scan-lane
  asymmetry recorded under accepted limitations is independent of this call and
  is queued for its own fix.
- **Cleaning `lastError` or any stored bookkeeping on lock** — the flag is
  orthogonal to definition health.
- **Upstream filing of the `isUIEditable` update-lane gap** — offered and
  declined 2026-08-07, deliberately untracked.

## Testing

- Data model: the server-side `FORMULA_FIELDS` projection is asserted by
  **contents** (the selection object is inspected for the `allowOverride` key,
  so a dropped field fails the test rather than silently reading `undefined`),
  and a definition row with the key unset reads back as "overrides allowed". The
  two front-component selections and their normalizers are not unit-covered —
  the app has no front-component test rig — and ride the live checklist.
- Definition lane: a write touching only `allowOverride` (or `name` /
  `description`) triggers neither validation nor `recomputeAllRecords`.
- Record lane: a locked definition runs no override detection in either the
  engine or the mirror lane; an ACTIVE rogue pin on a locked target is ignored
  (the record converges to the computed value, not the pinned one) while a
  legacy row with `allowOverride` unset still honors its pin; an actorless
  outside write to a locked value field reverts it, with kinds resolved and the
  strict gate applied first, and a gate-failing revert declines to write. The
  skipped `findOverride` lookup is a consequence of the same branch and is not
  separately call-count-pinned.
- **Echo termination** (`handlers.spec.ts:1315`): the revert's own event
  produces zero further writes — the accepted echo cost is exactly one compute,
  pinned so a future change cannot silently turn it into a loop.
- Sync exclusion: a DISABLED **locked** definition's target is excluded from the
  syncable set, with a disabled-and-*unlocked* definition seeded alongside it as
  a tripwire — if the widened filter (or a fake that ignores `or`) over-returned,
  that second target would drop out of the syncable set and the test would fail.
  The 60s TTL, in-flight dedup, rejected-pull behavior and explicit invalidation
  are covered separately (`formula-repository-cache.spec.ts`).
- **Not unit-covered by construction:** the wizard's OFF path (draft
  persistence, create-payload flags, permanence banner) and both read-only UI
  surfaces — the app has no React render-test infrastructure. These move to the
  v0.4.0 live checklist. Live verification must also confirm that the server
  actually *applies* `isUIEditable: false` on create: the pre-existing `true` in
  both payloads proves the client transmits the flag, not that the server
  honors it (`true` is also the default).

## Versioning and sequencing

v0.4.0, alongside the Phase 0 deferred-fix sweep and the quiet
awaiting-expression hint. One schema addition (`allowOverride`); the column adds
with `DEFAULT 'true'`, so existing rows backfill to "overrides allowed" and the
`?? true` hedge is defensive only. Cloud deploy is a separate, human-authorized
step and is not stamped by this ADR.
