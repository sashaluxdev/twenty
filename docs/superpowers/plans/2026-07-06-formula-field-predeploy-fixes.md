# Formula-Field Pre-Deploy Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** (1) Stale `TODAY()` formulas refresh automatically whenever they are viewed (full recompute + heartbeat, no manual button); (2) naively deleting (trashing) a FormulaDefinition record hides its value field via layout visibility instead of deactivating the field metadata, mirroring the FX-Status-chip handling, while preserving downstream OFFLINE flagging.

**Architecture:** All work is inside the Twenty Apps SDK app at `packages/twenty-apps/community/formula-field/`. Fix 1 extracts a testable refresh orchestrator into `src/front-components/lib/` and wires it into both widgets' existing `load()` polls, calling the already-front-importable `recomputeAllRecords` (which writes the `lastEvaluatedAt` heartbeat via `recordEvaluationHeartbeat`). Fix 2 removes deactivation from the server-side deleted-handler, teaches `formula-status.ts` liveness to treat fields targeted by qualifying *trashed* definitions as dead (so dependents still go OFFLINE), and adds a front-side "hide trashed definition's fields" convergence using the existing `ensureFieldLayoutVisibility` mechanism (viewField mutations reject app tokens, so hiding MUST run from the front widgets, exactly like FX-Status visibility).

**Tech Stack:** TypeScript, Twenty Apps SDK (logic functions + remote-dom front components), vitest, oxlint, emotion (`lib/ui.tsx` archetypes only).

## Global Constraints

- Repo conventions: named exports only; types over interfaces; no `any`; kebab-case filenames; `//` comments explaining WHY only; no abbreviations in names.
- Widget styling: every color/font/border comes from `src/front-components/lib/ui.tsx` archetypes + `lib/ui-tokens.ts` `TOKENS`; no new hex values; module-level styled components only; never flip a styled-component type on state; never import `twenty-sdk/ui`.
- All record IO from front components goes through `createDynamicCoreClient()` (`src/logic-functions/lib/dynamic-client.ts`) — never typed genql for runtime-created fields.
- Write-avoidance is a standing invariant: no new unconditional writes; every new write path must skip no-ops.
- The dynamic-client GraphQL serializer has an identifier-injection guard (audit fix M1) — any serializer change must preserve it.
- Throttle convention: 60_000 ms, matching `convergeFormulaFieldLayout`.
- Copy (exact): in-flight refresh note text is `Refreshing formula…` (Unicode ellipsis). The existing stale note `Formula last evaluated {relative}` and the 2.5h `STALE_AFTER_MS` threshold in `src/front-components/lib/format-relative-past.ts` are unchanged.
- Naive-delete hide guards (exact parity with today's `deactivateOwnedFields` guards): act only when the trashed definition has `createdField === true` AND no other live (non-deleted) definition targets the same `targetObject`+`targetField`.
- Tests: run from the app dir with `node /home/sasha_shin/twenty/node_modules/vitest/vitest.mjs run <file>` (redirect output to a file and tail it — background runs sometimes swallow stdout). Lint: `/home/sasha_shin/twenty/node_modules/.bin/oxlint -c .oxlintrc.json .` from the app dir.
- Commit per task with conventional-commit messages, e.g. `fix(formula-field): …`.

---

### Task 1: Auto-refresh stale TODAY() formulas on view

**Files:**
- Create: `packages/twenty-apps/community/formula-field/src/front-components/lib/refresh-stale-formulas.ts`
- Create: `packages/twenty-apps/community/formula-field/src/front-components/lib/__tests__/refresh-stale-formulas.spec.ts`
- Modify: `packages/twenty-apps/community/formula-field/src/front-components/formula-editor.tsx` (self-heal block ~lines 381-410; stale-note render ~lines 740-750; `usesTodayFlag` mapping ~line 261)
- Modify: `packages/twenty-apps/community/formula-field/src/front-components/formula-definition-editor.tsx` (load ~lines 274-345; "Last evaluated" hint ~lines 459-464)

**Interfaces:**
- Consumes: `recomputeForRecord(client, formula, recordId)` and `recomputeAllRecords(client, formula, pageSize?)` from `src/logic-functions/lib/recompute.ts` (both already exported; `recomputeAllRecords` calls `recordEvaluationHeartbeat`, which refreshes `lastEvaluatedAt` — this is what clears the stale note). `isStaleTimestamp` / `expressionUsesToday`-equivalent from `src/front-components/lib/format-relative-past.ts` (`isStaleTodayFormula` exists there — prefer reusing it over the widget-local duplicate).
- Produces: `refreshStaleTodayFormulas(options)` — the single refresh orchestrator both widgets call.

**Background (why):** Today the widget self-heals only the *viewed record's value* and never writes the definition heartbeat, so the `Formula last evaluated {relative}` note persists until the server sweep runs (never, when the worker is down). Decision (user-approved 2026-07-06): refresh-on-view replaces any manual button. Full `recomputeAllRecords` is the honest refresh: it fixes every record (no-op-suppressed writes) and advances the heartbeat.

- [ ] **Step 1: Write failing tests for the orchestrator**

`refresh-stale-formulas.spec.ts`, using injected fakes (follow the injectable-client style of `__tests__/delete-definition-completely.spec.ts`). The orchestrator signature to test against:

```ts
export type RefreshStaleOptions = {
  client: FormulaClient;
  definitions: ReadonlyArray<DefinitionLike>; // needs enabled, expression, lastEvaluatedAt + the fields recompute needs
  now: number;
  state: RefreshThrottleState; // { lastRefreshAt: number; inFlight: boolean } — caller keeps it in a ref
  recordId?: string; // viewed record, when called from the record-page widget
  recomputeForRecordFn?: typeof recomputeForRecord; // injectable for tests
  recomputeAllRecordsFn?: typeof recomputeAllRecords;
  onStateChange?: () => void; // lets the widget re-render the in-flight note
};
export const refreshStaleTodayFormulas: (options: RefreshStaleOptions) => Promise<string[]>; // ids refreshed
```

Test cases (each a separate `it`, assert via recorded fake calls):
1. "refreshes only stale enabled TODAY definitions" — given one stale TODAY def, one fresh TODAY def, one stale non-TODAY def, one stale-but-disabled TODAY def → `recomputeAllRecordsFn` called exactly once, for the stale enabled TODAY def; returns that id.
2. "recomputes the viewed record first when recordId is given" — call order recorded: `recomputeForRecordFn(def, recordId)` before `recomputeAllRecordsFn(def)`; when `recordId` omitted, `recomputeForRecordFn` never called.
3. "throttles: does nothing when lastRefreshAt is within 60s of now" — no calls, returns `[]`, state unchanged.
4. "guards re-entry: does nothing when state.inFlight is true".
5. "sets inFlight during the run and clears it after, including on failure" — make `recomputeAllRecordsFn` reject; expect the promise to resolve (errors swallowed → passive stale note remains), `inFlight === false` afterward, `lastRefreshAt` updated (so a failing refresh does not hot-loop every poll).
6. "processes multiple stale definitions sequentially" — two stale TODAY defs → both refreshed, calls not interleaved (record call order).

- [ ] **Step 2: Run tests, verify they fail** (module doesn't exist yet).

- [ ] **Step 3: Implement `refresh-stale-formulas.ts`**

Selection predicate: reuse `isStaleTodayFormula(definition, now)` from `format-relative-past.ts` if its shape fits (it combines enabled + usesToday + age); otherwise compose `enabled && usesToday && isStaleTimestamp(lastEvaluatedAt, now)`. Parse-based `usesToday` must be computed once per definition by the caller or memoized — do not re-parse expressions inside a 4s poll loop (the widgets already hold a parsed `usesTodayFlag`; accept it on `DefinitionLike`). Throttle/in-flight exactly per the tests. Errors per-definition are caught and swallowed (the passive stale note is the failure surface); still advance `lastRefreshAt`.

- [ ] **Step 4: Run tests, verify pass. Run lint.**

- [ ] **Step 5: Wire into `formula-editor.tsx`**

Replace the existing stale self-heal block (~381-410, the `staleDefs` selection + per-record `recomputeForRecord` loop) with a call to `refreshStaleTodayFormulas`, passing the viewed `recordId`, a ref-held `RefreshThrottleState` (replaces `lastSelfHealAtRef`), and `onStateChange` triggering a re-render (e.g. bump a `useState` counter). Keep the existing `setTimeout(load, 1500)` follow-up after a refresh actually fired so the UI catches new values fast.

Note render (~740-750): when `state.inFlight` → render `Refreshing formula…` as `MutedText` in the same slot; else when stale → keep the existing `WarnText` note verbatim. No button.

- [ ] **Step 6: Wire into `formula-definition-editor.tsx`**

Same orchestrator call inside `load()` (no `recordId` — this widget is the definition's own page), own throttle-state ref, gated on the same staleness predicate (this widget must compute/hold a `usesToday` flag for its definition — parse once per load of the expression, not per render). Next to the existing `Last evaluated {relative}` hint (~459-464): while in flight, show `Refreshing formula…` as `MutedText`; the hint itself is unchanged.

- [ ] **Step 7: Full app test suite + lint + typecheck-via-build**

Run the whole vitest suite from the app dir (expect all green, 301+ new), oxlint clean. Build/typecheck via `node /home/sasha_shin/twenty/node_modules/twenty-sdk/dist/cli.cjs dev --once` only if a local server is confirmed running; otherwise `npx tsc --noEmit` if the app has a tsconfig supporting it — report which you ran.

- [ ] **Step 8: Commit** — `fix(formula-field): auto-refresh stale TODAY() formulas on view`

---

### Task 2: Server side — stop deactivating on naive delete; keep dependents' OFFLINE signal via trashed-target liveness

**Files:**
- Modify: `packages/twenty-apps/community/formula-field/src/logic-functions/lib/handle-definition-lifecycle.ts` (`handleDefinitionDeleted` ~149-160; leave `deactivateOwnedFields` itself — destroy still uses it)
- Modify: `packages/twenty-apps/community/formula-field/src/logic-functions/on-formula-definition-deleted.ts` (adjust to new return shape/logging)
- Modify: `packages/twenty-apps/community/formula-field/src/logic-functions/lib/formula-repository.ts` (add trashed-definition loader)
- Modify: `packages/twenty-apps/community/formula-field/src/logic-functions/lib/formula-status.ts` (liveness: subtract trash-dead fields)
- Create: `packages/twenty-apps/community/formula-field/src/logic-functions/lib/__tests__/handle-definition-lifecycle.spec.ts`
- Modify: `packages/twenty-apps/community/formula-field/src/logic-functions/lib/__tests__/formula-status.spec.ts` (new cases)

**Interfaces:**
- Produces: `loadTrashedFormulas(client, targetObject?)` in `formula-repository.ts` — returns minimal rows `{ id, targetObject, targetField, createdField }` of soft-deleted FormulaDefinitions, optionally filtered to one target object. Task 3's front hide logic reuses this exact function.
- Produces: liveness rule — a field is **trash-dead** iff some trashed definition targets it with `createdField === true` AND no live definition targets the same `targetObject`+`targetField`. Trash-dead fields are excluded from the live-field set in `formula-status.ts`, so dependent formulas go OFFLINE through the existing dead-input path (existing reason wording).
- Behavior contract consumed by Task 3/4: after this task, trashing a definition performs NO metadata mutation; restore's reactivation loop stays (heals pre-change legacy deletes; no-op otherwise); destroy still runs `deactivateOwnedFields` + override cleanup (permanent end-state unchanged).

**Platform facts the implementer needs:**
- The record API excludes soft-deleted rows unless the filter contains a `deletedAt` key (server applies `withDeleted()` only then). So `loadTrashedFormulas` must filter e.g. `{ deletedAt: { is: 'NOT_NULL' } }` (combined with `targetObject: { eq: … }` when given). Check how the dynamic-client serializer renders that value — `NOT_NULL` here is a plain string argument in core-API filters; if the serializer needs extension, preserve the M1 identifier-injection guard.
- `refreshFormulaStatuses` / `loadFieldLiveness` currently derive liveness purely from field metadata `isActive` (`formula-status.ts:138-153`); the OFFLINE computation is `computeFormulaStatuses` (~85-101). Prefer keeping `computeFormulaStatuses` pure: load trashed definitions alongside the existing inputs and pass a set of trash-dead field keys (or merge into the existing dead set) from the loading layer.

- [ ] **Step 1: Write failing tests**

`formula-status.spec.ts` additions (follow existing fake/fixture style; the existing suite tests pure `computeFormulaStatuses`):
1. "marks dependent OFFLINE when its input field is targeted by a trashed created-field definition" — formula B reads field `x` on object O; trashed def D targets (O, x) with `createdField: true`; no live def targets (O, x) → B is OFFLINE, reason names `x`.
2. "field stays live when another live definition still targets it" — same as (1) plus live def E targeting (O, x) → B has no OFFLINE from `x`.
3. "field stays live when the trashed definition did not create the field" — D has `createdField: false` → B healthy.

New `handle-definition-lifecycle.spec.ts` (build a fake client in the style of `fake-client.ts` / recorded-call fakes used elsewhere):
1. "handleDefinitionDeleted performs no field metadata mutations" — assert zero `updateOneField` calls; assert the status refresh still ran.
2. "handleDefinitionDestroyed still deactivates owned fields and cleans override rows" — guards intact (`createdField: true`, not shared).
3. "handleDefinitionRestored reactivates only inactive fields" — with both fields already active (the new normal), zero `updateOneField` calls; with a legacy-deactivated field, exactly one reactivation per inactive field.

- [ ] **Step 2: Run both spec files, verify new cases fail.**

- [ ] **Step 3: Implement**

`handleDefinitionDeleted`: delete the `deactivateOwnedFields` call; keep `refreshFormulaStatuses`; return shape drops `deactivated` (update the trigger's logging accordingly). `loadTrashedFormulas` per the interface above. Liveness: in the status-refresh loading path, load trashed definitions once, compute trash-dead keys under the two guards (share/derive the same-target check — do NOT write a third copy of `anotherDefinitionTargets`-style logic; compute "shared" from the already-loaded live formulas list), subtract from the live set. `deactivateOwnedFields`, restore, destroy logic untouched.

- [ ] **Step 4: Run the two spec files → pass; then the full suite (regressions in `handlers.spec.ts` / status tests would show here). Lint.**

- [ ] **Step 5: Commit** — `fix(formula-field): naive delete no longer deactivates fields; trashed targets keep dependents OFFLINE`

---

### Task 3: Front side — hide the trashed definition's fields via layout convergence (FX-Status mechanism)

**Files:**
- Modify: `packages/twenty-apps/community/formula-field/src/logic-functions/lib/fx-status-field.ts` (new exported convergence for trashed definitions; throttle-map key handling)
- Modify: `packages/twenty-apps/community/formula-field/src/front-components/formula-editor.tsx` (`load()` — query trashed defs for the host object and converge them hidden)
- Modify: `packages/twenty-apps/community/formula-field/src/front-components/formula-definition-editor.tsx` (only if trivially symmetric — see Step 4)
- Modify: `packages/twenty-apps/community/formula-field/src/logic-functions/lib/__tests__/fx-status-field.spec.ts` (new cases)

**Interfaces:**
- Consumes: `loadTrashedFormulas(client, targetObject)` from Task 2; `ensureFieldLayoutVisibility({ objectMetadataId, fieldMetadataId, visible, anchorFieldMetadataId? })` and the module-level `layoutConvergedAt` throttle map in `fx-status-field.ts`; `companionFieldName(targetField)`.
- Produces: `convergeTrashedDefinitionLayout({ objectNameSingular, targetField })` (exported from `fx-status-field.ts`) — hides BOTH the value field and its FX-Status companion (`ensureFieldLayoutVisibility(…, visible: false)` for each), skipping fields that are missing or `isActive === false` (legacy deletes). Throttled under key `` `${objectNameSingular}.${targetField}:trashed` `` with the same 60s TTL. Silent no-op on errors (same try/catch posture as `convergeFormulaFieldLayout`).

**Throttle-key interaction (required behavior):** a delete→restore round trip within the TTL must still converge. When the trashed-hide convergence runs, clear that field's live-converge keys (`…:true` / `…:false`) from `layoutConvergedAt`; when `convergeFormulaFieldLayout` runs for a live definition, clear that field's `…:trashed` key. This guarantees restore un-hides within one widget render (the existing live path already forces the value field `visible: true`).

**Guards:** apply the naive-delete hide guards from Global Constraints (`createdField === true`, no other live definition targets the field). The "no other live definition" check must run in the widget/convergence layer using data it already has or one cheap query — reuse the existing shared-target check used by `front-components/lib/delete-definition-completely.ts` rather than duplicating it.

- [ ] **Step 1: Write failing tests** in `fx-status-field.spec.ts` (existing `FakeMetadataClient` style):
1. "convergeTrashedDefinitionLayout hides value field and companion" — both get `isVisible: false` writes (or creates with `isVisible: false` only when a row already exists — do NOT create new viewField rows just to hide; assert no `createViewField` when the row is absent).
2. "skips inactive fields" — value field `isActive: false` → zero viewField writes for it.
3. "is throttled per object.field:trashed key and clears the live keys" — second call within TTL is a no-op; `…:true`/`…:false` entries for that field are gone after the first call.
4. "live convergence clears the trashed key" — after `convergeFormulaFieldLayout` runs for the same field, the `…:trashed` entry is gone.

(Adjust assertion mechanics to the module's actual throttle-map visibility — export a test-only reset/inspect helper if one doesn't exist, matching how existing tests handle the map; if they don't, add `resetLayoutConvergenceThrottle()` used by both old and new tests' `beforeEach`.)

- [ ] **Step 2: Run spec, verify new cases fail.**

- [ ] **Step 3: Implement** `convergeTrashedDefinitionLayout` + key-clearing in both convergence paths.

- [ ] **Step 4: Wire into widgets.** In `formula-editor.tsx` `load()`: after the existing live-definition convergence loop (~303-309), call `loadTrashedFormulas(client, hostObjectNameSingular)` and, for each row passing the guards, fire `convergeTrashedDefinitionLayout` (fire-and-forget, same as existing convergence). Keep the widget's data flow untouched otherwise — trashed defs must NOT enter the rendered definitions list. For `formula-definition-editor.tsx`: its host record IS the definition; when its own definition row comes back absent (trashed) the widget currently shows whatever empty-state exists — do not build new UI; only add the hide call if the widget can cheaply detect its own record is trashed AND the target object/field are known from the last successful load; otherwise skip this widget (the record-page widget is the primary convergence surface; document the choice in a one-line comment).

- [ ] **Step 5: Full suite + lint.**

- [ ] **Step 6: Commit** — `fix(formula-field): hide trashed definitions' fields via layout convergence`

---

### Task 4: Local deploy + live end-to-end verification of both fixes

**Files:** none in-repo (scratch scripts in the session scratchpad; screenshots optional).

**Interfaces:**
- Consumes: everything above, deployed to the local dev stack (server `http://127.0.0.1:3000`, front `:3001`, workspace "Apple", login `tim@apple.dev` / `tim@apple.dev` via "Continue with Email"). Deploy from the app dir: `node /home/sasha_shin/twenty/node_modules/twenty-sdk/dist/cli.cjs dev --once`. API key for scripts: `~/.twenty/config.json` → `remotes.local.apiKey`. HARD-REFRESH the browser after deploy (IndexedDB metadata cache serves stale widgets otherwise).

- [ ] **Step 1: Deploy** (`dev --once`) and confirm sync success in output.
- [ ] **Step 2: Verify fix 1 (TODAY auto-refresh).** Via API script: create/ensure a formula whose expression uses `TODAY()` on opportunity; backdate its `lastEvaluatedAt` by >3h and perturb `lastValue` (or backdate + change a dependent input via yesterday's date semantics) so it is genuinely stale. In the browser, open a target record's Formulas tab. Expect: transient `Refreshing formula…` note (may be brief), then within ~10s the note is gone, `lastEvaluatedAt` (via API read) is fresh, and record values are correct. Also verify NO refresh loop: watch the definition via API for 2 minutes — `lastEvaluatedAt` must not keep advancing on every 4s poll (60s throttle + no-op suppression).
- [ ] **Step 3: Verify fix 2 (naive delete → hide).** Ensure a wizard-created formula field exists with values visible on a record page. Trash the FormulaDefinition record from its record page / table (soft delete, NOT "Delete Completely"). Re-open a target record page (widget mounts, convergence runs). Expect: value field AND FxStatus chip disappear from the Fields card within one render cycle; field metadata still `isActive: true` (verify via API/metadata query); record data intact. Then restore the definition from trash; re-open the record page; expect the field visible again and recompute working. If a second formula reads the first one's field: after trashing the first, the dependent must show OFFLINE (chip/banner) — verify.
- [ ] **Step 4: Regression smoke.** Expression save, override toggle, drag-reorder still work on the record-page widget; definition editor loads clean; no console errors (ignore the known benign `setSelectionRange` warning).
- [ ] **Step 5: Report** with pass/fail per item + evidence (API outputs, screenshots). No commit (nothing in-repo), unless bugs were found and fixed → fixes get their own commits and a re-run.
