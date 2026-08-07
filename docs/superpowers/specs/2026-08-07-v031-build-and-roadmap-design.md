# v0.3.1 build spec — deferred-fix sweep + quiet empty state (Allow Override parked)

Date: 2026-08-07 · Status: scope user-approved; spec committed, pending user read
App: `packages/twenty-apps/community/formula-field` (current version 0.3.0, deployed to cloud)
Consumer: a separate planning session (superpowers:writing-plans → subagent-driven-development).
This document lays out and orders the roadmap; it contains NO implementation plans.

Standing rules in force: efficiency-first (every operation pays rent — §4) and the
design-step review pass (this spec received an opus code-cross-referencing review;
adjudication in §9, parked-feature constraints in §6.3).

---

## 1 · Scope of the v0.3.1 build

- **Phase 0 — deferred-fix sweep**: five items from `docs/plans/2026-08-07-findings-fix-verdict.md` (§3)
- **Phase 1 — Feature B**: quiet empty-expression state on the record-page Formulas tab (§2)
- **Phase 2 — finalize**: README, `context.md` docs debt, version bump 0.3.0 → 0.3.1, full verify (§5)

**Feature A ("Allow Override" toggle) is DEFERRED from this build** — user ruling
2026-08-07 after the design review found the intended lock mechanism does not exist on the
platform (`updateOneField` silently drops `isUIEditable`). The complete approved design and
every review constraint are preserved in §6 for the future arc. No ADR ships in v0.3.1;
ADR 0028 (app-local `docs/adr/`, next free number) is reserved for that arc.

---

## 2 · Feature B — quiet empty-expression state

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
  marker (`:962-964`) in that state — it is noise while awaiting. Typing anything resumes
  live validation unchanged.
- `lastError` and save-validation are untouched ("also clean stored lastError" option
  explicitly rejected). The stored `PARSE_ERROR: Unexpected end of expression` remains on
  the definition row; both surfaces now hide it in the awaiting state.
- Reviewer-verified non-issues: mirror definitions always carry a bare-ref expression, so
  the guard never fires for them; the awaiting row (targetField set, expression empty,
  enabled false) does render today, which is exactly why the disabled-marker suppression
  is needed.

---

## 3 · Phase 0 — deferred-fix sweep

From the verdict's OK-TO-DEFER list, priority order, scopes amended per the design review:

| # | Item | Site | Scope (review-corrected) |
|---|------|------|--------------------------|
| 0.1 | `position` guard for variation configs (same defect class as F3) | `handle-variation-config-change.ts:14-19` | NOT a one-liner: the F3 fix shape also needs a `before` param threaded from `on-variation-config-updated.ts` (`:28-32` has none) for the row-image fallback. Open question for planning: `:24` returns `false` on empty `updatedFields` where the formula lane (`handle-formula-change.ts:55-62`) returns `true` — confirm intentional or align. |
| 0.2 | `name`/`description` into the definition-lane ignorable set | writes at `formula-definition-editor.tsx:323` (800ms debounce, `:318`); ignorable sets in `handle-formula-change.ts:20-30/:41-47` | Cheapest remaining efficiency win: each description tick currently costs a full `recomputeAllRecords`. |
| 0.3 | Blank-target defs must not pin junk overrides on human edit | Real home: the per-definition skip block `handle-record-update.ts:278-282` (root cause: `computeFormulaValueForRecord` lacks the `blankTargetTypeError` guard that `recompute.ts:909/:1021` have; `targetFieldKind('')` reads NUMBER) | Add blank-target to the existing skip block, NOT a new guard at `:347-397` as the verdict sketched. |
| 0.4 | ''/NULL churn on inactive-override re-pin | `override-repository.ts:204-208` | Bounded (one redundant write per pin, cannot loop); normalize like F4 did for the heartbeat. |
| 0.5 | `deepJsonEqual` Date-instance note | `handle-formula-change.ts:88` | Comment only. |

Verdict item 4 (whitespace/unrecognized `targetFieldType`) stays out — needs a user ruling
first (§7).

---

## 4 · Cost model (efficiency-first, standing rule)

- Items 0.1–0.4 are themselves junk-write/efficiency fixes; 0.2 removes a full
  target-record scan per description-edit debounce tick; 0.3 removes a per-event fetch +
  up-to-2 mutations on the affected class.
- Feature B is a pure render-branch change — no data-path cost.
- Nothing in this build adds hot-path queries or writes.

---

## 5 · Build order and rationale

1. **Phase 0** first: independent, small, testable fixes on a clean base; each its own
   task with regression specs.
2. **Phase 1** (Feature B): one-file front change.
3. **Phase 2** (finalize): README feature-list touch-up if needed; **docs debt:**
   `context.md`'s narrative log records nothing after the 2026-07-21 v0.1.10 arc
   (v0.1.11/ADR 0025 and v0.3.0/ADR 0026+0027 exist only in ADRs/plans docs; `:925` still
   calls cloud v0.1.11) — add the missing arc entries plus this build's; version bump to
   0.3.1; full suite (baseline **1209** unit tests + oxlint from the app dir) + local live
   verify (§8).

Each phase is a separate task group for the planning session, with per-task review per
subagent-driven-development.

---

## 6 · PARKED: Feature A — "Allow Override" toggle (complete design + constraints)

Deferred 2026-08-07 (user ruling). **Blocking wall:** the platform's `updateOneField`
silently drops `isUIEditable` — the update lane whitelist-picks properties
(`sanitize-raw-update-field-input.ts:35-43` over
`flat-field-metadata-editable-properties.constant.ts:3-29`, which lists neither
`isUIEditable` nor any UI-lock flag); only field CREATION honors it
(`get-default-flat-field-metadata-from-create-field-input.util.ts:63-67`). The mutation
returns success and changes nothing, so FakeClient tests pass green while the feature is
dead — only a live read-back catches it. Upstream filing was offered and DECLINED
2026-08-07; revisit if the platform makes the property updatable, or re-open the
FieldPermission alternative (below) with a fresh design round.

### 6.1 Approved design (preserved verbatim; ruling 1's mechanism is DEAD — do not implement as-is)

User story: per-definition "Allow override" setting. On (default) = today's behavior.
Off = computed/view-only: no override can be created or kept; edits revert.

Rulings (2026-08-07): (1) UI lock via `isUIEditable` — **mechanism refuted, needs
replacement**; candidates: behavioral lock only (no metadata lane; edits snap back via
event-driven recompute) or FieldPermission `canUpdateFieldValue:false` per user role (the
platform's only real runtime field lock — blocks API too, app role unaffected, but
role-enumeration cost; needs its own design). (2) Toggle-off deactivates existing pins
(values kept for restore) + recomputes exactly those records. (3) Default ON everywhere —
new BOOLEAN `allowOverride`, `defaultValue: true`, fresh universalIdentifier in
`FORMULA_DEFINITION_FIELDS`; null-backfill VERIFIED: adding the column emits
`ADD COLUMN ... DEFAULT 'true'`, Postgres backfills, existing rows read `true` (live-DB
confirmed on `enabled`) — `?? true` hedge is defensive-only. (4) Toggle lives in the
definition editor.

Server lane: side effects in `on-formula-definition-updated` (payload carries `before` +
`updatedFields`; `resolveChangedFields` gives exact detection with row-image fallback).
`allowOverride` joins NEITHER the ignorable set NOR the general reactive set — dedicated
transition branch: true→false recomputes only formerly pinned records; false→true
recomputes nothing. Detection skip for locked definitions; straggler self-heal in the
recompute pass's existing per-pass override-id load (zero new steady-state queries).
UI: neutral-variant toggle in the definition editor; record-tab Override toggle hidden
when off. Variation sync untouched.

### 6.2 Review constraints the future arc MUST inherit (all file:line-verified 2026-08-07)

1. **Transition placement** — `handle-formula-change.ts:139-141` returns
   `{reason:'disabled'}` when `after.enabled === false` (the NORMAL fresh-definition
   state): the transition branch must sit right after `changedFields` resolves (`:111`),
   before both disabled guards.
2. **Projection widening** — `allowOverride` reads `undefined` unless five selections
   widen: `formula-repository.ts:13-31` (`FORMULA_FIELDS`), `types.ts:15-45`,
   `formula-editor.tsx:271-286` + normalizer `:296-312`,
   `formula-definition-editor.tsx:394-412` + normalizer `:418-437`. `?? true` would mask
   the omission as "toggle does nothing" — unit-test the projection contents.
3. **Uncovered respect-fork** — single-record event path `handle-record-update.ts:442-467`
   honors pins unconditionally at `:448`; needs the `allowOverride` condition too, else
   straggler pins win between sweeps.
4. **Revert latency** — with detection skipped, an edit touching only the value field
   engages neither recompute case (`:428-431`; a formula's target is never its own
   dependency): the skip branch must enqueue a single-record recompute or the revert is
   sweep-eventual (≤1h), not immediate.
5. **Detection skip is ONE line** — the per-definition skip block `:278-282` sits above
   the mirror fork; no separate mirror edit needed.
6. **Toggle placement** — `formula-definition-editor.tsx:653-676` is a ternary (mirrors
   get a provenance line INSTEAD of Field settings): place the toggle after the whole
   ternary, before `FormulaDescriptionEditor` (`:678`), or mirrors lose it. Mirrors do get
   overrides.
7. **Batch deactivation** — `loadOverriddenRecordIds` selects `recordId` only, so
   per-pin `deactivateOverride` costs 2 round-trips × N; select `id` and batch via the
   `batch-write.ts:69-80` chunked-update pattern (verify plural mutation exists for app
   objects); when the same event changed `expression`, deactivate before the recompute at
   `handle-formula-change.ts:230` and skip the N single-record recomputes.
8. **Boolean filters** — `BooleanFilter` is `{eq, is}` only; `eq:true` EXCLUDES null:
   server-side "true-or-unset" needs `or:[{eq:true},{is:NULL}]`.
9. **UI mechanics** — `ToggleTrack.shouldForwardProp` filters only `on` (`ui.tsx:302-304`);
   a neutral variant must extend it. `allowOverride` must be added to
   `views/formula-definition.view.ts:24-66` to be visible/editable in the table view.
10. **Create path** — `on-formula-definition-created.ts:24` passes
    `updatedFields: undefined`: no transition is detectable on create; an API-created
    definition with `allowOverride:false` needs explicit handling.
11. **If any metadata lock is adopted** — a post-write read-back is MANDATORY (silent
    no-op otherwise undetectable); `findFields` (`handle-definition-lifecycle.ts:62`)
    selects only `{id,name,isActive}` and is heavy (1000×1000 nested); trash leaves a
    locked field with no reachable toggle (`:152-166` performs no field mutation);
    restore re-assert is gated behind `createdField === true` (`:173`).
12. Verified as workable: app token passes the DATA_MODEL guard (`permissions.service.ts:
    207-261` app branch, `default-role.ts:37`), with working server-side `updateOneField`
    precedent at `handle-definition-lifecycle.ts:89-97` — permissions were never the
    blocker.

---

## 7 · Backlog after v0.3.1 (ordered)

1. **User-ruling queue** (cheap to rule, then schedulable): whitespace/unrecognized
   `targetFieldType` legal values (verdict item 4); ISBLANK design hole (parked since the
   strict-typing arc).
2. **F1-empty-string bug arc** — empty-string TEXT dependency reverting to NULL via
   API/event path; investigation-first; sequenced BEFORE the SELECT output arc
   (2026-08-04 handoff). Distinct from Feature B (display-only).
3. **Allow Override arc (Feature A)** — parked per §6; unblocks if the platform makes
   `isUIEditable` updatable, or on a user ruling to take the FieldPermission route
   (fresh design round required either way).
4. **DATE cast arc** (datetime→date bridge) — un-gates the one GATED cloud definition
   ("Cost Date 1"); language change, own ADR + kind-gate design.
5. **SELECT output arc** (ADR 0026 backlog).
6. **Ops track (no code build):** retro purge of historical timeline rows on cloud
   (unblocked; scratch script `scripts/_retro_purge_cloud_tmp.ts`); ADR 0025 `updateMany`
   hot-path live check on cloud; widget browser timing check.
7. **Upstream track (needs user approval to file):** front-component bundle caching issue
   (draft ready in the app's `docs/upstream/`); twenty-sdk CLI upload throttle/retry.
   The `isUIEditable` update-lane gap was offered and declined 2026-08-07 — not tracked.

---

## 8 · Testing & verification (build-level)

- **Unit (FakeClient):** Phase 0 regressions — variation `position`/row-image fallback,
  ignorable `name`/`description` (no recompute on description tick), blank-target no-pin
  via the `:278-282` skip, re-pin churn normalization. Feature B render precedence
  (awaiting hint beats liveError/lastError/disabled-marker; typing resumes validation;
  mirror rows unaffected). Baseline 1209 tests + oxlint, both green before version bump.
- **Live (local `dev` remote):** fresh wizard definition shows the hint, not PARSE_ERROR,
  on both surfaces; description edit no longer triggers a target-object recompute
  (observe worker log / query traffic).
- **Deploy gate (cloud, when the user directs):** SDK-version-match procedure;
  `npx tsx scripts/audit-strict-gate.ts cloud` before/after; `app:publish --private -r
  cloud` then `app:install` (never `apply`/`dev`); expect nav items to un-folder
  (re-drag).

---

## 9 · Decision log

- 2026-08-07 — user rulings (structured Q&A, round 1): UI lock only; deactivate+recompute
  pins on toggle-off; default ON everywhere; Feature B shows the editor's hint (stored
  lastError untouched). Two-feature design presented and approved.
- 2026-08-07 — user directive: spec = queue organization + ordered roadmap; a separate
  session orchestrates implementation planning.
- 2026-08-07 — opus code-cross-referencing review (standing design-step rule): 3 Critical
  / 5 Important / 10 Minor. Architectural Critical S-C0 (`updateOneField` drops
  `isUIEditable`; confirmed by orchestrator re-read of the whitelist + sanitizer) refuted
  ruling 1's mechanism. Null-backfill claim verified CORRECT (existing rows read true).
  Retained-scope corrections applied: test baseline 1209; Phase 0 item 0.1 scoped beyond
  one line (`before` threading + empty-`updatedFields` semantics question); item 0.3
  retargeted to the `:278-282` skip block; ADR directory is app-local, 0028 free.
- 2026-08-07 — user rulings (round 2): **defer Feature A** from this build (ship Phase 0 +
  Feature B as v0.3.1); **skip** filing the `isUIEditable` gap upstream. Feature A design
  + all review constraints preserved in §6 for the future arc.
