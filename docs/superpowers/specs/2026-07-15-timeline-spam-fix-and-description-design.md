# Timeline Spam Fix + Formula Description Field — Design

**Date:** 2026-07-15
**Status:** Approved (Sasha, 2026-07-15)
**App:** `packages/twenty-apps/community/formula-field` (cloud workspace: luxurique.twenty.com)
**Ships as:** v0.1.8 + one-time retro purge script run

## Problem

The formula-field app is growing the cloud workspace's `timelineActivity` table unsustainably. Measured 2026-07-15 via the Twenty MCP:

| Offender | Count | Rate | Mechanism |
|---|---|---|---|
| `formulaDefinition.updated` | 3,770 | ~1,000–1,800/day | Sweep + event recomputes rewrite `lastValue`/`lastEvaluatedAt` |
| `variationConfig.updated` | 177 | 24/day per enabled config | Hourly unconditional `lastSyncedAt` bookkeeping write |
| `opportunity.updated` (app-authored, `updatedBy`-only diff) | ≤671 | sporadic | Redundant no-op value writes from recompute races |

Not spam (keep): `formulaOverride.updated` (31, genuine manual edits), all company/person/companypeople activity (zero app-authored).

## Root causes (verified in code)

1. **Unstable representative `lastValue`.** `recordEvaluationHeartbeat` (`src/logic-functions/lib/formula-repository.ts:244-296`) is already write-avoidant, but the value it compares is sampled as "first non-error, non-null outcome" of a paginated scan with **no `orderBy`** (`src/logic-functions/lib/recompute.ts:663-729`). Scan order varies run-to-run, so the sample flips between different records' values (observed `0 → X` and `null → X` diffs), defeating the guard on nearly every sweep *and* every `*.updated` event-triggered recompute (`src/logic-functions/on-record-updated.ts:60`) — which is why volume exceeds 26 definitions × 24 hourly sweeps.
2. **Unconditional variation bookkeeping.** `sweepVariationConfig` (`src/logic-functions/lib/variation-sync.ts:1048-1055`, plus the early-return path at `:942-948`) calls `updateVariationConfigBookkeeping` (`variation-config-repository.ts:124-142`) with a fresh `lastSyncedAt` every hourly sweep and on every config-change event — no change check, unlike the formula side.
3. **`updatedBy`-only diffs on target records.** The per-record value guard exists (`recompute.ts:596-609` engine path, `:553-557` mirror path), but the event-trigger path and the hourly cron sweep can both read stale state and both write the same value (no locking/version check). Core re-stamps `updatedBy` unconditionally on every accepted `updateOne` (`twenty-server .../updated-by.update-one.pre-query-hook.ts:18-49`), so a redundant write after a human/Supabase edit yields a non-empty `updatedBy`-only diff, which core turns into a timeline row. The ADR 0020 cleanup cron keeps these rows because `updatedBy` is not an app-managed key (fail-safe posture, `src/logic-functions/lib/timeline-cleanup.ts:334-411`).
4. **Cleanup cron scope gap.** The ADR 0020 cron (`timeline-cleanup.ts:416-509`, every 10 min, 48h lookback) only targets formula/variation **target objects**' `<object>.updated` rows — `formulaDefinition.updated` and `variationConfig.updated` are outside its scope by construction (`timeline-cleanup.ts:434-450`).

**Constraint (re-confirmed):** neither core nor the Apps SDK exposes any timeline/audit suppression for app writes (ADR 0020 finding still holds; `objectRecordChangedValues` has no field-level exclusion beyond `updatedAt`/`searchVector`/relations). All fixes are app-side.

## Fixes

### F1 — Deterministic `lastValue` sampling
Add a stable `orderBy` (by `id`, ascending) to the target-record pagination in `recomputeAllRecords` (`recompute.ts:663-675`) so the "first non-error, non-null outcome" sample is deterministic across runs. The existing guard in `recordEvaluationHeartbeat` then collapses definition writes to genuine changes. The ADR 0015 carve-out (hourly `lastEvaluatedAt`-only heartbeat for `TODAY()` formulas) is intentionally preserved — F3 handles its timeline residue.

*Rejected alternative:* stop persisting `lastValue` — the widget surfaces it; instability is the bug, not the field.

### F2 — Write-avoidant variation bookkeeping
Rework the end-of-sweep bookkeeping in `sweepVariationConfig` (both call sites) to mirror the formula-repository contract (`formula-repository.ts:191-211`): compare `lastError`/`status`/`statusReason` against the config's current values and **skip the write entirely when nothing changed**. `lastSyncedAt` is stamped only as part of a real write, becoming "last time something changed" rather than a heartbeat.

*Guard rail:* implementer must verify no front component renders `lastSyncedAt` as a freshness signal (check `variation-widget.tsx`, `variation-config-editor.tsx`). If something does, fall back to a once-daily heartbeat (still 24× fewer writes) and note it in the ADR.

### F3 — Extend the ADR 0020 cleanup cron
Two new purge classes in `lib/timeline-cleanup.ts`, same soft-delete + fail-safe-keep posture as today:

1. **Definition/config bookkeeping rows:** `name IN (formulaDefinition.updated, variationConfig.updated)`, `workspaceMemberId IS NULL`, and every diff key ∈ bookkeeping set — `lastValue`, `lastValueText`, `lastEvaluatedAt`, `lastError`, `status`, `statusReason`, `lastSyncedAt`, `updatedBy`. Rows touching real fields (`expression`, `name`, `enabled`, `targetField`, …) are kept; mixed rows are kept whole (no key-stripping needed for this class — bookkeeping keys never mix with human edits in one write, and keeping is the fail-safe).
2. **App-authored no-op rows on target objects:** existing name set, diff's **only** key is `updatedBy` and `updatedBy.after` is `{source: "APPLICATION", name: "Formula Field"}`.

This is required, not just insurance: ADR 0015 `TODAY()` heartbeats and F1-legitimate value changes keep writing; the cron is what keeps the timeline quiet.

### F4 — One-time retro purge (approved 2026-07-15)
A standalone script in the app package, run locally against the cloud workspace's GraphQL API (auth mechanism — workspace API key or CLI remote token — to be settled in the implementation plan), reusing the extended cleanup lib with an **unbounded lookback** and no page cap, purging all three historical classes. Soft-delete only. Genuine user edits (`formulaOverride.updated`, real stage/amount changes, definition field edits) are untouched.

**Verification:** after the run, re-issue the MCP/GraphQL counts from the 2026-07-15 investigation; expect `formulaDefinition.updated` residue ≈ genuine edits only (26 creates + real expression/config edits), `variationConfig.updated` ≈ genuine config edits, `updatedBy`-only app rows = 0.

## Feature: formula description + "?" tooltip

- **Schema:** new editable TEXT field `description` on `FormulaDefinition` (`src/objects/formula-definition.object.ts`): new pre-minted UUID in `FORMULA_DEFINITION_FIELDS` (`:12-31`), field literal following the `expression` pattern (`:91-97`). Manifest-declared field → ships via normal `dev --once` sync / cloud publish; no migration.
- **Wizard:** new step block titled exactly **"Description"** (user-specified — keep it clean, no long prompt text), a `TextArea` (from `lib/ui.tsx`) placed after the "3 · Field name" step (`lib/formula-setup-wizard.tsx:958-980`), persisted with the existing debounced `persistDraft` pattern (`:182-195`, cf. `persistDraft({ name: label })` at `:347`).
- **Post-create editor:** same `TextArea` in the Field-settings section of `formula-definition-editor.tsx` (near `:572`), with its own `updateFormulaDefinition` mutation — descriptions stay editable after creation (name currently is not; description must be).
- **Widget tab:** in `formula-editor.tsx`, next to the definition name (`:891-893`), render a small muted "?" glyph **only when `description` is non-empty**, with the description as a native `title` attribute — the app's only tooltip mechanism (twenty-sdk/ui is a documented NO-GO in the front-component sandbox, `lib/ui.tsx:1-10`; five existing `title=` usages set the pattern). Styling via `var(--t-*)` tokens to match `MutedText`. Requires adding `description` to the `Definition` type (`formula-editor.tsx:87-104`) and the GraphQL selection (`:287-308`).

## Delivery

- Version bump to **v0.1.8**; cloud publish/install must use the twenty-sdk version matching the hosted platform line (see `context.md:625-651` gotcha; pinned local is 2.19.0).
- New ADR **0022** documenting F1–F3 (root causes, deterministic sampling, variation write-avoidance, cleanup scope extension) as the successor increment to ADR 0020/0021.
- Retro purge (F4) runs once after the v0.1.8 deploy is confirmed live, then its counts are verified.
- Implementation plan: separate doc via writing-plans, structured for subagent-driven-development in a fresh session.

## Acceptance criteria

1. Over a 24h observation window post-deploy, new `formulaDefinition.updated` rows only appear for genuine value/error/status changes or `TODAY()` heartbeats, and the cleanup cron removes bookkeeping rows within ~10 minutes.
2. No new `variationConfig.updated` rows from no-op sweeps.
3. No surviving app-authored `updatedBy`-only rows on target objects older than ~10 minutes.
4. Historical spam purged per F4 verification counts.
5. A formula with a description shows the "?" tooltip in the Formulas tab; one without shows no glyph; description editable in wizard ("Description" step) and post-create editor.
6. Existing tests pass; new unit tests cover the F2 skip-guard and F3 classification rules (including the keep-side: mixed diffs, human-authored rows).
