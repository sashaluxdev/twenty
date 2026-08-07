# v0.4.0 build spec — create-time override lock, deferred-fix sweep, quiet empty state

Date: 2026-08-07 · Status: scope user-approved; both review rounds adjudicated; pending user read
App: `packages/twenty-apps/community/formula-field` (current version 0.3.0, deployed to cloud)
Consumer: a separate planning session (superpowers:writing-plans → subagent-driven-development).
This document lays out and orders the roadmap; it contains NO implementation plans.

Standing rules in force: efficiency-first (every operation pays rent — §5) and the
design-step review pass (opus code-cross-referencing review round 1 + create-lane delta
review both adjudicated — §10).

---

## 1 · Scope of the v0.4.0 build

- **Phase 0 — deferred-fix sweep**: five items from `docs/plans/2026-08-07-findings-fix-verdict.md` (§4)
- **Phase 1 — Feature A′ server lane**: create-time override lock, data model + skips + revert (§2)
- **Phase 2 — Feature A′ UI**: wizard choice + permanence warning, widget hide, editor status line (§2)
- **Phase 3 — Feature B**: quiet empty-expression state on the record-page Formulas tab (§3)
- **Phase 4 — finalize**: ADR 0028, README, `context.md` docs debt, bump 0.3.0 → 0.4.0, full verify (§6)

History: the original Feature A (runtime "Allow Override" toggle) was refuted in design
review — the platform's `updateOneField` silently drops `isUIEditable` (create-only
property). The user then proposed the create-time variant (Feature A′), which the same
review evidence shows IS supported, and ruled 2026-08-07 to fold it into this build. The
runtime-toggle upgrade stays parked (§7).

---

## 2 · Feature A′ — create-time override lock

User story: when creating a formula field, the wizard offers "Allow manual overrides".
**On** (default) = today's behavior: the value field is editable; human edits become
per-record overrides that pin the value. **Off** = the field is created view-only:
`isUIEditable: false` from birth (real grey-out in table/detail/kanban), no override can
ever be created, outside writes revert. **The choice is permanent** — the wizard warns
before creation.

### 2.1 Mechanism ground truth (review-verified 2026-08-07)

`createOneField` honors `isUIEditable`
(`get-default-flat-field-metadata-from-create-field-input.util.ts:63-67`); `updateOneField`
whitelist-drops it (`sanitize-raw-update-field-input.ts:35-43` over
`flat-field-metadata-editable-properties.constant.ts:3-29`). Permanence is therefore
platform-imposed, not a product choice. Front-end enforcement: `isRecordFieldReadOnly.ts:57`
(table, detail, kanban). UI-only — GraphQL record writes still pass (handled in §2.3).

### 2.2 Data model

- New field `allowOverride` on FormulaDefinition: `FieldType.BOOLEAN`,
  `defaultValue: true`, fresh universalIdentifier in `FORMULA_DEFINITION_FIELDS`
  (precedent: `description`). Written `false` by the wizard create step when the user
  opts out; never mutated afterward.
- **Permanence is enforced, not asserted** (delta review A′-I2): the field is declared
  `isUIEditable: false` in the app manifest — the system-managed-field convention already
  used by `dependencies`/`lastError`/`createdField`/`scanCursor`
  (`formula-definition.object.ts:118/:167/:206/:240`). Manifest-declared fields go through
  the create/compare path where the flag IS honored; the flag is UI-only so the wizard's
  own definition write still lands. Without this, a raw record-page flip would produce
  incoherent states (behavioral skip with no grey-out, or a locked field whose pins
  suddenly count).
- Null-tolerance: every read site uses `allowOverride ?? true`. Backfill VERIFIED: adding
  the column emits `ADD COLUMN ... DEFAULT 'true'`, Postgres backfills, existing rows read
  `true` (live-DB confirmed on `enabled`) — the hedge is defensive-only.
- Server-side filters (if ever needed): `BooleanFilter` is `{eq, is}` only and `eq:true`
  EXCLUDES null — "true-or-unset" is `or:[{eq:true},{is:NULL}]`.

### 2.3 Server lane

No transition branch, no metadata updates, no pin deactivation, no self-heal — the flag is
immutable and locked fields never accumulate pins. Because nothing in the definition lane
reacts to it, **`allowOverride` joins the definition-lane ignorable set**
(`handle-formula-change.ts:20-30/:41-47`, alongside Phase 0 item 0.2's additions) — a
wizard draft write of the flag must not trigger validation or recompute work. The record
lane reads it per-event from the already-loaded definition row. What remains:

1. **Detection skip** — one line in the per-definition skip block
   `handle-record-update.ts:278-282` (sits above the mirror fork, so it covers engine and
   mirror lanes in one edit). A locked definition never runs override detection.
2. **Respect-fork guard (REQUIRED, not defensive)** — the single-record event path honors
   pins unconditionally at `handle-record-update.ts:448`; condition it on
   `allowOverride ?? true`. Required because pins on a locked field CAN exist: variation
   sync writes ACTIVE rows in the same key space (`variation-sync.ts:245/:899`) and the
   API can write them directly. See §2.6 for the variation-lane ruling.
3. **Event-driven revert** — with detection skipped, an outside write touching only the
   value field engages neither recompute case (a formula's target is never its own
   dependency), so the revert would be sweep-eventual (≤1h). Mechanism (delta review
   A′-C1): the `eventAffectedFormulas` predicate at `handle-record-update.ts:181-189` is
   actor-gated (`actorWorkspaceMemberId && updatedFields && …`) — an API/integration
   write carries no member id, so as naively specced the locked definition would be
   EXCLUDED from the pre-pass: no entry in `eventFieldKindsByObject` (`:234-237`, kinds
   resolve wrong per `:352-356`) and none in `gateErrorByFormulaId` (`:245-260`, revert
   runs ungated). The fix: give `:181-189` an actor-INDEPENDENT branch for locked
   definitions whose `targetField` is in `updatedFields`, so kinds and the strict gate
   are computed before the revert, and reuse the Case 1 body (`:428-487`) as the revert
   lane — no new lane. Plumbing verified: `on-record-updated.ts:39` already destructures
   `updatedFields` from `payload.properties`; absent/empty `updatedFields` follows the
   house convention (`sameRecordAffected:92-100`: treat as affected — safe, recompute is
   write-avoidant). Cost: per outside write of a locked field, one single-record
   recompute, zero new queries.
4. **Projection widening** — `allowOverride` must join five selections or it reads
   `undefined` (masked by `?? true` as "lock does nothing"):
   `formula-repository.ts:13-31` (`FORMULA_FIELDS`), `types.ts:15-45`,
   `formula-editor.tsx:271-286` + normalizer `:296-312`,
   `formula-definition-editor.tsx:394-412` + normalizer `:418-437`. Unit-test the
   projection CONTENTS, not just values.

### 2.4 UI

- **Wizard, both paths** (format wizard AND mirror wizard — mirrors get overrides too):
  an "Allow manual overrides" choice, default ON, persisted in the resumable draft like
  other selections. Choosing OFF surfaces the permanence warning: the setting cannot be
  changed after the field is created; changing it later means deleting the formula and
  recreating the field, and a deactivated old field can still reserve the name. Create
  step (delta-review verified): both payload sites already carry `isUIEditable: true`
  explicitly — `formula-setup-wizard.tsx:664` (engine/format) and `:756` (mirror) — so
  OFF is a one-token change at two sites, plus `allowOverride: false` riding the existing
  `finalizeCreation` definition write (`:615-620`, zero extra calls). Draft persistence
  is the generic `persistDraft` passthrough (`:187-199`) on the real definition field —
  NOT `targetFieldSettings` JSON (reserved for display settings). Caveat for live verify:
  the existing `true` proves the client transmits the flag, not that the server applies
  it (`true` is also the default); server application rests on the create-path util and
  must be confirmed live once.
- **Record-page Formulas tab**: hide the per-record Override toggle
  (`formula-editor.tsx:994-1012`) for locked rows.
- **Definition editor**: read-only status line — "Overrides: allowed" / "Overrides:
  locked at creation" — placed AFTER the field-settings ternary
  (`formula-definition-editor.tsx:653-676`; mirrors get a provenance line instead of Field
  settings, so anything placed inside the ternary is denied to mirrors), before
  `FormulaDescriptionEditor` (`:678`). No toggle — the value is immutable.
- If any wizard control reuses the `ToggleTrack` archetype: `shouldForwardProp` filters
  only `on` (`ui.tsx:302-304`) and its colors are the override red/green — needs a neutral
  variant prop, or use the ChoiceChip pattern the wizard already uses for formats.

### 2.5 Accepted limitations (document in ADR 0028)

- **Permanent** by platform constraint; the escape hatch is delete + recreate.
- **No retroactive lock** for existing definitions (their fields already exist; all 19
  cloud definitions stay overrideable).
- **API-created definitions** with `allowOverride: false` against a pre-existing unlocked
  field get the behavioral skip only (no grey-out) — documented, not fought. This
  divergence is API-ONLY by construction: the wizard can never create a definition
  against a pre-existing field (`existingField` drives `collision`, and `canCreate`
  requires `!collision` — `formula-setup-wizard.tsx:479-480/:590-595`), so planning must
  not build a lock path for that dead wizard branch.
- **Interrupted wizard** (field created, `finalizeCreation` never ran) re-shows the
  wizard with the name now collision-blocked — a pre-existing behavior A′ does not
  change; nothing in A′ may imply resume-after-partial-create works.
- `isUIEditable` is UI-only: raw API writes land and are then reverted event-driven
  (§2.3.3) — strictly view-only for UI users, eventually-computed against API writers.

### 2.6 Variation-sync interaction (ruling pending)

Variation sync writes ACTIVE override rows in the same `(targetObject, targetField,
recordId)` key space (`variation-sync.ts:245/:899`). Its syncable set excludes
ENABLED-formula targets only — and every freshly created locked definition is DISABLED
until its first valid expression saves, so in that window (and for any disabled locked
definition) a variation config on the same object can pin the locked field; stale pins
then persist after the formula enables. §2.3.2's guard keeps recompute from honoring such
pins, but the variation widget would still show them as diverged, and revert-vs-re-pin
churn between the two lanes is possible while the definition is disabled.

**Ruling (2026-08-07): locked formula targets leave the variation syncable set regardless
of enabled state** — variations never track or pin a locked field ("off = fully computed,
no exceptions"). Consequence: the syncable-set computation (`computeSyncableFields` /
`syncable-fields.ts`) must also see DISABLED locked definitions, not only the enabled
scan — one widened or extra filtered query per variation-sync pass. This is the only
recurring cost Feature A′ adds anywhere (§5).

---

## 3 · Feature B — quiet empty-expression state

Ground truth: the two surfaces disagree today. The definition editor guards the empty
expression (`awaitingExpression`, `formula-definition-editor.tsx:572-573`, render
precedence `:641-651`) and shows "Field created — write the formula expression and save to
activate." The record-page Formulas tab has no guard: a freshly created, not-yet-configured
definition shows a red `PARSE_ERROR: Unexpected end of expression`
(`formula-editor.tsx:833-840` live-validates the seeded empty draft; render `:1014-1018`;
row load filter `:292-294` excludes only empty `targetField`, so the awaiting row renders).

Approved ruling: **same hint as the editor, UI-only.**

- Port the `awaitingExpression` guard into the record-tab row: when
  `definition.expression` is empty AND the row draft is untouched, render the muted hint
  (exact same string) instead of the error line; also suppress the "(formula disabled)"
  marker (`:962-964`) in that state. Typing anything resumes live validation unchanged.
- `lastError` and save-validation untouched ("also clean stored lastError" explicitly
  rejected).
- Reviewer-verified non-issues: mirrors always carry a bare-ref expression (guard never
  fires); the awaiting row does render today, which is exactly why the disabled-marker
  suppression is needed.

---

## 4 · Phase 0 — deferred-fix sweep

From the verdict's OK-TO-DEFER list, priority order, scopes amended per design review:

| # | Item | Site | Scope (review-corrected) |
|---|------|------|--------------------------|
| 0.1 | `position` guard for variation configs (same defect class as F3) | `handle-variation-config-change.ts:14-19` | NOT a one-liner: the F3 fix shape also needs a `before` param threaded from `on-variation-config-updated.ts` (`:28-32` has none) for the row-image fallback. Open question for planning: `:24` returns `false` on empty `updatedFields` where the formula lane (`handle-formula-change.ts:55-62`) returns `true` — confirm intentional or align. |
| 0.2 | `name`/`description` into the definition-lane ignorable set | writes at `formula-definition-editor.tsx:323` (800ms debounce, `:318`); ignorable sets in `handle-formula-change.ts:20-30/:41-47` | Cheapest remaining efficiency win: each description tick currently costs a full `recomputeAllRecords`. |
| 0.3 | Blank-target defs must not pin junk overrides on human edit | Real home: the per-definition skip block `handle-record-update.ts:278-282` (root cause: `computeFormulaValueForRecord` lacks the `blankTargetTypeError` guard that `recompute.ts:909/:1021` have; `targetFieldKind('')` reads NUMBER) | Add blank-target to the existing skip block — the same block Feature A′ extends; sequence 0.3 first. |
| 0.4 | ''/NULL churn on inactive-override re-pin | `override-repository.ts:204-208` | Bounded (one redundant write per pin, cannot loop); normalize like F4 did for the heartbeat. |
| 0.5 | `deepJsonEqual` Date-instance note | `handle-formula-change.ts:88` | Comment only. |

Verdict item 4 (whitespace/unrecognized `targetFieldType`) stays out — needs a user ruling
first (§7).

---

## 5 · Cost model (efficiency-first, standing rule)

- **Feature A′ hot paths: zero new queries.** `allowOverride` rides existing definition
  loads; detection short-circuits EARLIER for locked definitions (net saving per human
  edit); the event-driven revert fires only for locked definitions on outside writes
  (rare) at one single-record recompute each.
- **Feature A′'s only recurring cost** is the §2.6 ruling: the variation-sync pass must
  also see disabled locked definitions when computing syncable sets (one widened or extra
  filtered query per pass; only runs where variation configs are enabled). No transitions,
  no metadata writes, no sweep additions otherwise. Wizard OFF adds zero extra calls
  (`isUIEditable` rides the existing `createOneField` payload; `allowOverride` rides the
  existing definition write).
- Items 0.1–0.4 are junk-write/efficiency fixes; 0.2 removes a full target-record scan
  per description-edit debounce tick.
- Feature B is a pure render-branch change.

---

## 6 · Build order and rationale

1. **Phase 0** first: independent fixes on a clean base; 0.3 edits the same skip block
   Feature A′ extends — landing it first keeps A′'s diff reviewable.
2. **Phase 1** (A′ server lane): data model + skips + revert + projections, fully
   unit-testable before any UI exists.
3. **Phase 2** (A′ UI): wizard choice + warning, widget hide, editor status line.
4. **Phase 3** (Feature B): one-file front change (ordered to keep `formula-editor.tsx`
   edits sequential).
5. **Phase 4** (finalize): ADR 0028 "Create-time override lock" (app-local `docs/adr/`,
   0028 free — records the platform wall, permanence, §2.5 limitations, and the runtime-
   toggle upgrade path); README; **docs debt:** `context.md` narrative records nothing
   after 2026-07-21 (v0.1.11/ADR 0025 and v0.3.0/ADR 0026+0027 missing; `:925` still says
   cloud v0.1.11) — add missing arc entries plus this build's; bump to 0.4.0; full suite
   (baseline **1209** unit tests + oxlint) + local live verify (§8).

---

## 7 · PARKED: runtime override toggle (upgrade path) + backlog

**Runtime toggle (original Feature A)** stays parked: `isUIEditable` is create-only on the
platform; the upstream filing was offered and DECLINED 2026-08-07. If the platform ever
adds the property to `FLAT_FIELD_METADATA_EDITABLE_PROPERTIES`, Feature A′'s flag upgrades
into a runtime toggle; that arc must then inherit the round-1 review constraints NOT
consumed by A′: transition-branch placement vs the `enabled:false` guard
(`handle-formula-change.ts:139-141` — branch must sit after `changedFields` resolves at
`:111`), batch pin-deactivation (`loadOverriddenRecordIds` selects `recordId` only → 2
round-trips × N as naively specced; use the `batch-write.ts:69-80` chunked pattern),
straggler self-heal in the per-pass override-id load, create-path transition gap
(`on-formula-definition-created.ts:24` passes `updatedFields: undefined`), mandatory
post-write read-back (silent no-op otherwise undetectable; `findFields` at
`handle-definition-lifecycle.ts:62` selects only `{id,name,isActive}` and is heavy),
trash/restore lock stranding (`:152-166`, `:173`), and table-view visibility
(`views/formula-definition.view.ts:24-66`). App-token metadata permissions are proven
workable (`permissions.service.ts:207-261` app branch; precedent
`handle-definition-lifecycle.ts:89-97`).

**Ordered backlog after v0.4.0:**

1. **User-ruling queue**: whitespace/unrecognized `targetFieldType` legal values (verdict
   item 4); ISBLANK design hole (parked since the strict-typing arc).
2. **F1-empty-string bug arc** — empty-string TEXT dependency reverting to NULL via
   API/event path; investigation-first; sequenced BEFORE the SELECT output arc.
3. **DATE cast arc** (datetime→date bridge) — un-gates "Cost Date 1"; language change,
   own ADR + kind-gate design.
4. **SELECT output arc** (ADR 0026 backlog).
5. **Ops track (no code build):** retro purge of historical timeline rows on cloud
   (unblocked; scratch script `scripts/_retro_purge_cloud_tmp.ts`); ADR 0025 `updateMany`
   hot-path live check on cloud; widget browser timing check.
6. **Upstream track (needs user approval to file):** front-component bundle caching issue
   (draft ready in the app's `docs/upstream/`); twenty-sdk CLI upload throttle/retry.
   The `isUIEditable` update-lane gap: filing declined 2026-08-07 — not tracked.

---

## 8 · Testing & verification (build-level)

- **Unit (FakeClient):** Phase 0 regressions (variation `position`/row-image fallback;
  no recompute on description tick; blank-target no-pin via the skip block; re-pin churn
  normalization). Feature A′ — locked definition: detection skipped (engine + mirror),
  respect-fork ignores a rogue pin, outside write to targetField triggers single-record
  recompute — asserting the revert runs WITH resolved event kinds and the strict gate
  (A′-C1 regression: a memberless write must not produce an ungated/kind-blind revert),
  projection-contents assertions on all five sites, `?? true` on legacy rows,
  `allowOverride` declared `isUIEditable: false` in the manifest, variation syncable set
  excludes a locked field even while its definition is disabled (§2.6 regression);
  wizard: OFF persists in draft, create payload carries `isUIEditable:false` +
  `allowOverride:false`, warning renders. Feature B render precedence (awaiting hint
  beats liveError/lastError/disabled-marker; typing resumes validation; mirrors
  unaffected). Baseline 1209 + oxlint green before version bump.
- **Live (local `dev` remote):** create a locked formula field → cell greyed/read-only in
  table AND record detail; Override toggle absent from the Formulas tab; direct GraphQL
  write to the value field reverts within seconds; create an unlocked one → today's
  behavior. Fresh wizard definition shows the hint, not PARSE_ERROR, on both surfaces.
  Description edit no longer triggers a target-object recompute.
- **Deploy gate (cloud, when the user directs):** SDK-version-match procedure;
  `npx tsx scripts/audit-strict-gate.ts cloud` before/after; `app:publish --private -r
  cloud` then `app:install` (never `apply`/`dev`); expect nav items to un-folder
  (re-drag).

---

## 9 · Open items for the planning session

1. ~~Record-event `updatedFields` availability~~ CLOSED by delta review:
   `on-record-updated.ts:39` already delivers it; fallback = house convention
   (absent ⇒ affected), see §2.3.3.
2. ~~createOneField wrapper pass-through~~ CLOSED by delta review: both wizard sites
   already transmit the flag explicitly; OFF is a one-token change ×2, see §2.4.
3. Phase 0 item 0.1's empty-`updatedFields` semantics question (§4).
4. Wizard step placement for the overrides choice (existing step vs new step) — pure UX,
   planner's choice; the warning copy is fixed by §2.4.
5. Item 0.2 shape (delta review A′-M1): wizard draft writes (`persistDraft` firing on
   targetObject/format/mirror selections) are NOT covered by adding `name`/`description`
   to the ignorable set — each such write still runs `validateFormula` on an empty
   expression and a workspace-wide `refreshFormulaStatuses`
   (`handle-formula-change.ts:189-201`). Consider a "no `targetField` yet ⇒ nothing to
   validate" early return in `handleFormulaChange`, which subsumes item 0.2's spirit and
   every draft write; planner decides the exact shape (bounded, user-driven cost either
   way).

---

## 10 · Decision log

- 2026-08-07 — user rulings (round 1): UI lock only; deactivate+recompute pins on
  toggle-off; default ON everywhere; Feature B shows the editor's hint (stored lastError
  untouched). Two-feature design approved.
- 2026-08-07 — user directive: spec = queue organization + ordered roadmap; a separate
  session orchestrates implementation planning.
- 2026-08-07 — opus review round 1: 3 Critical / 5 Important / 10 Minor. S-C0
  (`updateOneField` drops `isUIEditable`; confirmed by orchestrator re-read) refuted the
  runtime toggle's mechanism. Null-backfill verified (existing rows read true). Retained-
  scope corrections applied (baseline 1209; item 0.1 scope; item 0.3 retarget; ADR dir).
- 2026-08-07 — user rulings (round 2): defer runtime Feature A; skip upstream filing.
  Build briefly re-scoped to v0.3.1 (commit `74e6197a7c`).
- 2026-08-07 — user proposal (round 3): create-time-only override choice with a permanence
  warning. Assessed feasible on round-1 evidence (create path honors the flag); ruled to
  fold into this build → v0.4.0 with Feature A′ as specced in §2.
- 2026-08-07 — opus delta review of the create-lane claims: 1 Critical / 2 Important / 3
  Minor; both §9 verification items closed by existing code. Adjudicated: A′-C1
  (actor-gated revert → actor-independent branch reusing Case 1) folded into §2.3.3;
  A′-I2 (permanence unenforced → manifest `isUIEditable: false` on `allowOverride`)
  folded into §2.2; A′-M1/M2/M3 folded into §9.5/§2.5. A′-I1 (variation-sync overlap on
  disabled locked definitions) is semantic → user ruled same day: exclude locked targets
  from the variation syncable set regardless of enabled state (§2.6).
