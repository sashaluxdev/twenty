# Formula Fix Wave (F3 blank-TEXT convergence + Delete-completely destroy permission) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the F3 no-op write churn (blank TEXT results rewriting SQL-NULL columns forever) on both the sweep and event lanes, and make the danger-zone "Delete completely" action work by granting the app role per-object destroy on its two objects.

**Architecture:** F3 is fixed with a blank-equivalent equality rule applied ONLY where a computed engine value is compared to a stored TEXT read (`null ≡ ''`), never by changing what is read or written. The platform's write path collapses both `''` and `null` to SQL NULL (`transform-text-field.util.ts:3-5`) and its read path expands SQL NULL to `''` (`format-result.util.ts:346-348`), so a TEXT column can never hold `''` and the stored-read domain is exactly `{'', 'x'}` — blank-equivalence is the only convergence rule that terminates in every cell, and read-side folding is FORCED out: stored `''` folded to null vs a genuinely computed `''` (reachable via `""` literal, evaluator.ts:502, and all-blank `&` concat, ADR 0026 D2) would never compare equal and would loop forever. Record-lane sibling of the shipped F4 definition-row fix (`storedValueText`, formula-repository.ts:391-401). The destroy fix is the already-specced per-object `objectPermissions` grant. Both ride one branch (`feat/formula-field-fix-wave`) and one version bump (0.5.1).

**Tech Stack:** TypeScript, vitest (app-local config), twenty-sdk app manifest/roles (workspace-resolved 2.31.0-alpha.1), local Twenty dev stack (Postgres MCP read-only for verification).

**Source documents (read-only background, do not re-derive):**
- F3 mechanism + severity: `packages/twenty-apps/community/formula-field/verification-reports/2026-08-12-select-live/REPORT.md` (findings F3, E3) and `P5-mirror-lanes.md`, `P5-churn-ab.md` in the same dir. The live incident was observed on the RECOMPUTE lane only; the event-lane manifestation below is code-derived and platform-payload-verified (events carry post-`formatResult` records: `workspace-update-query-builder.ts:165,242` feed `formatTwentyOrmEventToDatabaseBatchEvent`, so `properties.after[field]` for a NULLed TEXT column is `''`, never `null`; zero-field-diff updates are dropped before the emitter) — no live event-lane incident was observed, and docs must not claim one.
- Destroy permission spec (authoritative for Task 2): `packages/twenty-apps/community/formula-field/docs/plans/2026-08-12-delete-completely-destroy-permission.md`. Its two formerly-unverified claims are now review-VERIFIED: idempotent retry (`delete-definition-completely.ts:138` re-plans; `:147-158` presence-guards both field deletions; `:161-163` unconditional destroy; variation twin identical) and lifecycle-trigger-on-destroy (destroy emits only `formulaDefinition.destroyed` → `on-formula-definition-destroyed.ts:36`; a `.deleted` handler exists but is reversible-trash semantics, `on-formula-definition-deleted.ts:11-14`).

## Global Constraints

- App dir: `packages/twenty-apps/community/formula-field`; all paths below are relative to it unless rooted.
- NEVER touch the cloud remote. Before any API-touching command, verify `$TWENTY_API_URL` is `http://localhost:3000`. Auth: `source /home/sasha_shin/.claude/jobs/fbda1940/tmp/twenty-dev.env`; never print key values or any env/config file contents.
- Never run `nx build twenty-client-sdk` (it stubs the generated client). Remedy if a suite reports "CoreApiClient was not generated": `cp -r <appdir>/node_modules/twenty-client-sdk/dist/* packages/twenty-client-sdk/dist/`.
- Blank equivalence applies to kind `'TEXT'` ONLY. SELECT already collapses computed blank → null (`normalizeComputedValue`, value-io.ts:146) and its stored enum NULL reads back as null; NUMBER/CURRENCY/DATE/DATE_TIME round-trip null as null. Do not widen — Task 1 pins the boundary with a test.
- `normalizeStoredValue` semantics are UNCHANGED (`'' → ''` for TEXT stays; value-io.spec.ts:215 stays green) and `buildTargetWriteData` semantics are UNCHANGED (value-io.spec.ts:223-229 stays green). The fix is equality-side only. TRIPWIRE: if any pre-existing test's expectation needs changing, the fix has widened past its design — stop and reassess rather than editing the expectation.
- All spec imports in this app are `src/`-rooted (e.g. `from 'src/logic-functions/lib/value-io'`), never relative.
- Test fixtures must pass the strict kind gate: a TEXT-target expression must infer text (`IF(cond, "a", "b")`, `TEXT(...)`, `&` concat). A number-inferring expression like `amount * 2` on a TEXT target is refused whole-definition before any record work (`strictKindGateError`, recompute.ts:1129-1148) and produces a test that passes on a broken build.
- Version bump to `0.5.1` happens ONLY in Task 4 (publish/install gates on version; local `dev --once` sync does not).
- Test command from the app dir: `npx vitest run <spec path>` (full suite: `npx vitest run`). Pre-existing baseline: 1310 tests green; recompute.spec.ts has exactly 75.
- Cost model (standing rule): Task 1 changes are O(1) equality logic on a path that already dispatches on kind — no added I/O, and they REMOVE per-pass writes (301 rows/pass live) and spurious override upserts. Task 2 adds one ObjectPermissionEntity row per object per workspace at install/sync; lookup cost unchanged (spec §Cost model). No task adds recurring cost.

---

### Task 1: F3 — blank-equivalent TEXT convergence on both lanes

**Files:**
- Modify: `src/logic-functions/lib/value-io.ts` (add helper after `normalizeStoredValue`, which ends at line 103)
- Modify: `src/logic-functions/lib/recompute.ts:320-324` (kind-aware `valuesEqual`), its single callsite `:908`, and its value-io import block `:47-55` (add `textValuesConverged,` and `type TargetFieldKind,` — the type is NOT currently imported there; it is defined at value-io.ts:45)
- Modify: `src/logic-functions/lib/handle-record-update.ts:71-79` (`storedValuesEqual` gains kind; `TargetFieldKind` already imported at `:53`) and its callsites `:422`, `:441` (`targetKind` in scope from `:391`)
- Test: `src/logic-functions/lib/__tests__/value-io.spec.ts`
- Test: `src/logic-functions/lib/__tests__/recompute.spec.ts` (new describe; the F4 precedent module is `describe('gated TEXT-target definition heartbeat churn', …)` at `:1605-1762`, comment `:1594-1604`)
- Test: `src/logic-functions/lib/__tests__/handlers.spec.ts` (EXISTS — event-lane block `describe('handleRecordUpdate (event-driven recompute)')` at `:1077`; pin tests to mirror at `:1510`, `:1531`, `:1552`; TEXT-target definition fixtures at `:1903`, `:2122`, `:2396`, `:2439`)

**Interfaces:**
- Consumes: `EngineValue`, `TargetFieldKind` (value-io.ts:45); FakeClient's write log `public writes: string[]` (`__tests__/fake-client.ts:51`, entries `"object:id:field=value"`, pushed at `:384` and `:403`); handler call shape `handleRecordUpdate({ client, objectName, recordId, after, updatedFields, actorWorkspaceMemberId })`.
- Produces: `textValuesConverged(a: EngineValue, b: EngineValue): boolean` exported from value-io.ts; kind-aware module-private `valuesEqual` (recompute.ts) and `storedValuesEqual` (handle-record-update.ts). Task 3's ADR references `textValuesConverged` by name.

**Blast radius (verified):** `valuesEqual` and `storedValuesEqual` are module-private with exactly three callsites total; no exports, no test imports; the DATE/float comments naming them elsewhere stay accurate under a TEXT-only rule.

- [ ] **Step 1: Write the failing tests for the helper** — append to the `describe('TEXT target kind', ...)` block in `value-io.spec.ts` (block spans `:186-230`; add after the `buildTargetWriteData` test at `:223-229`):

```ts
  it('textValuesConverged treats blank as equivalent for TEXT convergence only', () => {
    // F3: the record API reads a SQL-NULL TEXT column back as '', so null and
    // '' must converge — in both operand orders.
    expect(textValuesConverged(null, '')).toBe(true);
    expect(textValuesConverged('', null)).toBe(true);
    expect(textValuesConverged(null, null)).toBe(true);
    expect(textValuesConverged('', '')).toBe(true);
    expect(textValuesConverged('x', 'x')).toBe(true);
    // A real value change still differs.
    expect(textValuesConverged('x', null)).toBe(false);
    expect(textValuesConverged(null, 'x')).toBe(false);
    expect(textValuesConverged('x', '')).toBe(false);
    expect(textValuesConverged('x', 'y')).toBe(false);
  });
```

Add `textValuesConverged` to the spec's existing `src/logic-functions/lib/value-io` import list.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/logic-functions/lib/__tests__/value-io.spec.ts`
Expected: FAIL — `textValuesConverged` is not exported.

- [ ] **Step 3: Implement the helper** in `value-io.ts`, directly after `normalizeStoredValue` (insert at ~line 104):

```ts
// F3 (live 2026-08-13): the platform stores both '' and null as SQL NULL for
// TEXT (transform-text-field) and reads SQL NULL back as ''
// (DEFAULT_TEXT_FIELD_NULL_EQUIVALENT_VALUE), so a stored TEXT value is never
// distinguishable from blank-vs-empty. Convergence checks against a stored TEXT
// read must therefore treat blank ≡ blank — null and '' on EITHER side compare
// equal — or a blank computed value rewrites a NULL column on every pass (the
// record-lane sibling of formula-repository's storedValueText/F4 fix). This is
// an EQUALITY rule only, deliberately not a read-side fold: a genuinely
// computed '' (ADR 0026 D2 all-blank concat, "" literal) written and read back
// as '' must still converge with itself, which a stored-''-to-null fold breaks
// forever.
export const textValuesConverged = (a: EngineValue, b: EngineValue): boolean =>
  a === b || ((a === null || a === '') && (b === null || b === ''));
```

- [ ] **Step 4: Run to verify the helper passes**

Run: `npx vitest run src/logic-functions/lib/__tests__/value-io.spec.ts`
Expected: PASS (all cases, including the untouched `:215` and `:223-229` blocks).

- [ ] **Step 5: Write the recompute-lane tests** — new describe at the end of `recompute.spec.ts`. GATE WARNING: expressions must infer text (Global Constraints). Only the FIRST case below is red before the fix; the others are pinning tests (they hold behavior that must survive the fix) — Step 6 verifies exactly that split.

```ts
describe('F3 — blank TEXT result over a round-tripped NULL column (record lane)', () => {
  // F3 (live 2026-08-13): the record API reads a SQL-NULL TEXT column back as
  // '', while a blank engine result is null. Strict identity saw '' !== null
  // and rewrote null over NULL on every sweep pass — 301 rows/pass in the live
  // workspace, updatedAt falsified forever. Blank ≡ blank for TEXT ends the
  // loop; real value changes still write in both directions.
  // FakeClient does not simulate the platform round-trip (its projection
  // returns null), so the stored column is seeded as '' — the row exactly as
  // the record API hands it to the scan.
  const seedRoundTrippedFixture = (client: FakeClient): void => {
    client.setFieldKinds('opportunity', {
      amount: 'NUMBER',
      formulaLabel: 'TEXT',
    });
    client.seed('opportunity', [
      { id: 'o1', amount: null, formulaLabel: '' },
      { id: 'o2', amount: 21, formulaLabel: 'low' },
    ]);
  };
  // Text-inferring on both branches (kind gate); IF over a BLANK condition is
  // BLANK, so amount:null computes null — the exact live-writer shape.
  const blankableTextFormula = (
    overrides: Partial<FormulaDefinitionRecord> = {},
  ): FormulaDefinitionRecord => ({
    id: 'f3rec',
    targetObject: 'opportunity',
    targetField: 'formulaLabel',
    targetFieldType: 'TEXT',
    expression: 'IF(amount > 100, "high", "low")',
    enabled: true,
    ...overrides,
  });

  it('computed null over a round-tripped NULL column performs zero record writes', async () => {
    const client = new FakeClient();
    seedRoundTrippedFixture(client);
    client.seed('formulaDefinition', [
      blankableTextFormula() as Record<string, unknown> & { id: string },
    ]);

    const outcomes = await recomputeAllRecords(client, blankableTextFormula());

    // Sanity: the definition was scanned, not gate-refused (a refused pass
    // yields a single synthetic outcome with an error and would green-wash
    // this test).
    expect(outcomes.filter((o) => o.error)).toEqual([]);
    expect(outcomes).toHaveLength(2);
    // o1: computed null vs stored '' → converged (RED before the fix).
    // o2: computed 'low' vs stored 'low' → converged (already green).
    expect(outcomes.filter((o) => o.changed)).toEqual([]);
    expect(client.writes.filter((w) => w.startsWith('opportunity:'))).toEqual([]);
  });

  it("a genuinely computed '' converges with a round-tripped NULL column (pins the equality-side design)", async () => {
    // ADR 0026 D2: an all-blank concat is '' (a determined text), not null.
    // '' === '' already holds — this pins the cell that read-side folding
    // would break forever (stored '' folded to null vs computed '').
    const client = new FakeClient();
    seedRoundTrippedFixture(client);
    const formula = blankableTextFormula({ expression: 'formulaLabel & ""' });
    const plan = await planRecomputeForRecord({
      client,
      formula,
      targetRecordId: 'o1',
      prefetchedRecord: { id: 'o1', amount: null, formulaLabel: '' },
    });
    expect(plan.write).toBeNull();
    expect(plan.outcome.changed).toBe(false);
  });

  it('real value changes still write in both directions (pinning)', async () => {
    const client = new FakeClient();
    client.setFieldKinds('opportunity', {
      amount: 'NUMBER',
      formulaLabel: 'TEXT',
    });
    client.seed('opportunity', [{ id: 'o3', amount: null, formulaLabel: 'stale' }]);
    // Direction 1: stored text, computed null → clears the field.
    const clearPlan = await planRecomputeForRecord({
      client,
      formula: blankableTextFormula(),
      targetRecordId: 'o3',
      prefetchedRecord: { id: 'o3', amount: null, formulaLabel: 'stale' },
    });
    expect(clearPlan.write).toEqual({
      recordId: 'o3',
      data: { formulaLabel: null },
    });
    // Direction 2: stored blank, computed text → writes the value.
    const writePlan = await planRecomputeForRecord({
      client,
      formula: blankableTextFormula(),
      targetRecordId: 'o3',
      prefetchedRecord: { id: 'o3', amount: 500, formulaLabel: '' },
    });
    expect(writePlan.write).toEqual({
      recordId: 'o3',
      data: { formulaLabel: 'high' },
    });
  });

  it('does not widen past TEXT: a NUMBER target still compares strictly', async () => {
    // Boundary pin: nothing in the blank rule may leak to other kinds. A
    // stored '' on a NUMBER read normalizes to null; computed 0 must still
    // write (0 !== null).
    const client = new FakeClient();
    client.setFieldKinds('opportunity', {
      amount: 'NUMBER',
      score: 'NUMBER',
    });
    client.seed('opportunity', [{ id: 'o4', amount: 0, score: null }]);
    const plan = await planRecomputeForRecord({
      client,
      formula: blankableTextFormula({
        id: 'f3num',
        targetField: 'score',
        targetFieldType: 'NUMBER',
        expression: 'amount * 2',
      }),
      targetRecordId: 'o4',
      prefetchedRecord: { id: 'o4', amount: 0, score: null },
    });
    expect(plan.write).toEqual({ recordId: 'o4', data: { score: 0 } });
  });
});
```

`planRecomputeForRecord`'s exact argument object: copy the property set used by the existing calls in this spec file (several tests call it; `overriddenRecordIds`/`crossRecordCache` are optional per `RecomputeArgs` — match the file's idiom).

- [ ] **Step 6: Run to verify the red/green split is exactly as designed**

Run: `npx vitest run src/logic-functions/lib/__tests__/recompute.spec.ts`
Expected: exactly ONE new failure — `computed null over a round-tripped NULL column performs zero record writes` (o1's spurious write). The two pinning cases and the boundary case pass, and the 75 pre-existing tests stay green. If the zero-writes case passes here, the fixture is gate-refused or mis-seeded — fix the test before touching the implementation.

- [ ] **Step 7: Implement the recompute-lane fix.** Replace `recompute.ts:320-324`:

```ts
// Convergence check for the no-op guard. Strict identity covers both domains:
// numbers compare exactly (every kind is rounded to its stored representation
// first, so a fractional result can never rewrite forever), and text converges on
// exact string equality — no trimming, no case folding. TEXT alone adds blank
// equivalence (null ≡ ''): the record API reads a SQL-NULL TEXT column back as
// '', so strict identity rewrites a blank result forever (F3; textValuesConverged).
const valuesEqual = (
  kind: TargetFieldKind,
  a: EngineValue,
  b: EngineValue,
): boolean => (kind === 'TEXT' ? textValuesConverged(a, b) : a === b);
```

Callsite `:908` becomes `if (valuesEqual(targetKind, currentValue, result))`. Update the import block `:47-55` per the Files note.

- [ ] **Step 8: Run to verify the recompute lane passes**

Run: `npx vitest run src/logic-functions/lib/__tests__/recompute.spec.ts`
Expected: PASS (75 + 4 new).

- [ ] **Step 9: Write the event-lane tests** in `handlers.spec.ts`, inside (or alongside) the `describe('handleRecordUpdate (event-driven recompute)')` block at `:1077`, mirroring the pin tests at `:1510`/`:1531`/`:1552` — same event construction, same override assertions (`client.get('formulaOverride', 'formulaOverride-0')` and `client.mutationSelections.some((s) => 'createFormulaOverride' in s)`). Reuse a TEXT-target definition fixture (`:1903` etc.), adjusted to a gate-legal blank-capable expression (`IF(amount > 100, "high", "low")`). Platform-payload fact the fixtures must honor: a NULLed TEXT column arrives in `after` as `''` (post-formatResult), never `null`.

```ts
  it('a blank TEXT result over a blank stored column is not mistaken for a human edit', async () => {
    // F3 event-lane manifestation (code-verified; no live incident observed):
    // computedStored (null for blank) compared to currentStored ('' for a
    // round-tripped NULL) under strict identity upserts a spurious override
    // pin — an ACTIVE pin that recompute then skips forever. Blank ≡ blank
    // for TEXT prevents it.
    // Arrange: TEXT-target formula whose inputs make it compute null for this
    // record (amount: null); stored target column '' both in `after` and in
    // the fresh read; the target field named in updatedFields (the shape the
    // app's own clear-echo produces); a human actorWorkspaceMemberId, exactly
    // as the neighboring pin tests set one.
    // Act: handleRecordUpdate({ client, objectName, recordId, after,
    //   updatedFields: ['formulaLabel'], actorWorkspaceMemberId }).
    // Assert: no override row — client.get('formulaOverride', 'formulaOverride-0')
    // undefined AND no createFormulaOverride in client.mutationSelections —
    // and no 'opportunity:' entry in client.writes.
  });

  it('a human clearing a TEXT field the formula computes a value for still pins (pinning)', async () => {
    // Same event shape, but the formula computes 'high' (amount: 500) while
    // the cleared column reads ''. computedStored 'high' vs currentStored ''
    // differ under both the old and new rule — the pin must still be created.
    // Assert: createFormulaOverride mutation present, override row exists.
  });
```

Fill both arrange/act bodies from the neighboring pin tests verbatim-adapted (they contain the full event payload shape and assertion idioms; only the field kinds, expression, and values above change).

- [ ] **Step 10: Run to verify the red/green split**

Run: `npx vitest run src/logic-functions/lib/__tests__/handlers.spec.ts`
Expected: the spurious-pin case FAILS (override row present under strict identity); the still-pins case PASSES. Pre-existing tests stay green.

- [ ] **Step 11: Implement the event-lane fix.** Replace `handle-record-update.ts:71-79`:

```ts
// Equality between a written value and the formula's computed value: numbers
// compare float-tolerantly (a stored value has been through a round-trip), text
// and nulls compare strictly — except TEXT blank equivalence (null ≡ ''): the
// record API reads a SQL-NULL TEXT column back as '', and without it a blank
// computed value reads as a human edit and pins the record (F3; see
// textValuesConverged).
const storedValuesEqual = (
  kind: TargetFieldKind,
  a: EngineValue,
  b: EngineValue,
): boolean => {
  if (typeof a === 'number' && typeof b === 'number') {
    return Math.abs(a - b) < 1e-9;
  }
  if (kind === 'TEXT') {
    return textValuesConverged(a, b);
  }
  return a === b;
};
```

Thread the in-scope `targetKind` through both callsites (`:422` echo-race guard, `:441` human-edit detection) and add `textValuesConverged` to the value-io import. The echo-race site compares two post-format reads that are symmetric for real platform events (both `''`); blank equivalence there is defensive against payload-shape drift, not a behavior change.

- [ ] **Step 12: Run the full suite**

Run: `npx vitest run`
Expected: PASS, 1310 pre-existing + new tests, zero failures, zero changed expectations (see the tripwire in Global Constraints).

- [ ] **Step 13: Commit**

```bash
git add packages/twenty-apps/community/formula-field/src
git commit -m "fix(formula-field): blank-equivalent TEXT convergence on recompute and event lanes (F3)"
```

---

### Task 2: Destroy permission for Delete completely (per spec)

The spec is authoritative: `docs/plans/2026-08-12-delete-completely-destroy-permission.md` (in the app dir). Its §Fix code is to be applied verbatim; re-read §Risks before starting. Typecheck is pre-verified: workspace twenty-sdk (2.31.0-alpha.1) `RoleConfig` accepts `objectPermissions` with `objectUniversalIdentifier` + `canDestroyObjectRecords`.

**Files:**
- Modify: `src/roles/default-role.ts` (`export default defineRole({` at `:29`, flags `:30-37`, `canDestroyAllObjectRecords: false` at `:36` — stays false)
- Test: `src/roles/__tests__/default-role.spec.ts` (create; vitest globs `src/**/*.spec.ts`)

**Interfaces:**
- Consumes: `FORMULA_DEFINITION_OBJECT_UNIVERSAL_IDENTIFIER` (`src/objects/formula-definition.object.ts:9`) and `VARIATION_CONFIG_OBJECT_UNIVERSAL_IDENTIFIER` (`src/objects/variation-config.object.ts:11`) — both already exported under exactly these names. `defineRole` returns a validation result `{ success, config, errors, warnings }`; the config is under `.config` (house idiom: `src/objects/__tests__/*.spec.ts` reads `formulaDefinitionObject.config.fields`).
- Produces: `objectPermissions` array on the default role config — Task 4 asserts the built manifest and the Postgres rows.

- [ ] **Step 1: Write the failing manifest-role test** at `src/roles/__tests__/default-role.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';

import defaultRole from 'src/roles/default-role';
import { FORMULA_DEFINITION_OBJECT_UNIVERSAL_IDENTIFIER } from 'src/objects/formula-definition.object';
import { VARIATION_CONFIG_OBJECT_UNIVERSAL_IDENTIFIER } from 'src/objects/variation-config.object';

// Delete-completely destroy permission (spec 2026-08-12): the danger zones'
// final hard-destroy is gated on canDestroyObjectRecords, and the app-role
// intersection denies it for every user unless the role grants destroy on
// exactly its two objects. defineRole validates only the PRESENCE of
// objectUniversalIdentifier, so a typo'd identifier silently creates a useless
// permission row — the identifiers are asserted against the imported
// constants, never inline UUIDs.
describe('default role destroy permissions', () => {
  it('builds without validation errors', () => {
    expect(defaultRole.success).toBe(true);
  });

  it('keeps role-wide destroy denied', () => {
    expect(defaultRole.config.canDestroyAllObjectRecords).toBe(false);
  });

  it('grants per-object destroy on exactly the two danger-zone objects', () => {
    const destroyGrants = (defaultRole.config.objectPermissions ?? []).filter(
      (permission) => permission.canDestroyObjectRecords === true,
    );
    expect(
      destroyGrants.map((grant) => grant.objectUniversalIdentifier).sort(),
    ).toEqual(
      [
        FORMULA_DEFINITION_OBJECT_UNIVERSAL_IDENTIFIER,
        VARIATION_CONFIG_OBJECT_UNIVERSAL_IDENTIFIER,
      ].sort(),
    );
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/roles/__tests__/default-role.spec.ts`
Expected: FAIL — no `objectPermissions` / empty destroy grants (the `success` and role-wide cases pass already).

- [ ] **Step 3: Apply the spec's fix verbatim** in `default-role.ts`: add the two imports and the `objectPermissions` array from spec §Fix, leaving every existing flag (including `canDestroyAllObjectRecords: false` at `:36`) unchanged. `formulaOverride` is deliberately NOT granted.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/roles/__tests__/default-role.spec.ts`
Expected: PASS (3/3).

- [ ] **Step 5: Full suite + commit**

Run: `npx vitest run` — expected all green.

```bash
git add packages/twenty-apps/community/formula-field/src/roles
git commit -m "fix(formula-field): grant per-object destroy for danger-zone Delete completely"
```

---

### Task 3: Docs — ADR 0030, README operational note, spec status

**Files:**
- Create: `docs/adr/0030-blank-text-convergence.md` (app dir; 0030 confirmed next free number)
- Modify: `README.md` (app dir) — add to `### Common operational situations` (`:700`); also fix the stale CLI verb at `:693` (`twenty app deploy --private` → `app:publish --private`)
- Modify: `docs/plans/2026-08-12-delete-completely-destroy-permission.md` — status + review headers, one wording fix

**Interfaces:** consumes `textValuesConverged` (Task 1) and the grant (Task 2).

- [ ] **Step 1: Write ADR 0030** following the house format (read `docs/adr/0026-string-values-and-concatenation.md` for the template). Required content:
  - Context: the platform stores both `''` and `null` as SQL NULL for TEXT (write-side collapse) and reads SQL NULL back as `''` — a TEXT column can never hold `''`, and stored blank is one indistinguishable state. Strict-identity convergence rewrote blank results forever (finding F3, live 2026-08-12/13: 301 rows every sweep pass, updatedAt/updatedBy falsified; recompute lane observed live, event-lane spurious-pin manifestation code-verified). Prior art: the definition-row F4 fix (`storedValueText`).
  - Decision: blank-equivalent equality (`textValuesConverged`: `null ≡ ''`, both operand orders) at the two convergence checks only — recompute no-op guard, event-lane `storedValuesEqual` — for kind TEXT only. Read (`normalizeStoredValue`) and write (`buildTargetWriteData`) semantics unchanged.
  - Why not read-side folding (the forcing cell): a genuinely computed `''` (ADR 0026 D2 all-blank concat, `""` literal) written and read back as `''` would compare `null` (folded stored) vs `''` (computed) and rewrite forever — folding trades one loop for another. Do NOT restate buildTargetWriteData's "an empty string is written AS an empty string" comment as a storage claim; the platform collapses the written `''` to SQL NULL — the distinction exists only in the mutation payload.
  - Consequences: blank-computing TEXT formulas perform zero writes over blank columns; the app never tries to distinguish stored NULL from stored `''`; SELECT/NUMBER/date kinds keep strict identity (boundary pinned by test).
- [ ] **Step 2: README `Common operational situations` entry** (match the list style at `:700`): "Delete completely says 'Entity performing the request does not have permission'" — the app role grants destroy on its two objects only, and the server intersects the USER's role with the app role: a member whose own role lacks destroy on these objects is still denied by design; ask a workspace admin. Plus the `:693` verb fix.
- [ ] **Step 3: Update the spec's headers**: `Status: IMPLEMENTED on feat/formula-field-fix-wave (live verification pending — plan Task 4)`; `Design review: DONE 2026-08-13 (plan review, opus) — both formerly-unverified claims VERIFIED`. In §Alternatives, reword "the definition lifecycle trigger fires on destroy, not delete" to: a soft delete would run the `.deleted` handler, whose semantics are reversible-trash (ADR 0009) and would leave a trash row; only destroy emits `formulaDefinition.destroyed`, whose handler performs the terminal cleanup. Also correct §Root cause 4's cite `default-role.ts:26-34` → `:29-38` (flag at `:36`).
- [ ] **Step 4: Commit**

```bash
git add packages/twenty-apps/community/formula-field/docs packages/twenty-apps/community/formula-field/README.md
git commit -m "docs(formula-field): ADR 0030 blank-TEXT convergence + destroy-permission ops note"
```

---

### Task 4: Live verification on the local stack + version bump

The dev stack should already be up (detached; logs at `~/.twenty-dev-logs/`, health `curl -s localhost:3000/healthz`). If down, restart detached per the same pattern (server/worker/front via `npx nx`, logs to that dir). The app is currently UNINSTALLED in the dev workspace; native opportunity fields survive — verified: `ctrlText` (text) and `dealScore` (double precision) exist, with `ctrlText` = 'high' on 1584 rows / 'low' on 1266 / NULL on 301 — exactly what `IF(dealScore > 100, "high", "low")` computes, so the fixture below converges with ZERO writes from the very first pass (no F1 backfill slog applies). Workspace schema for read-only SQL (Postgres MCP): `workspace_1wgvd1injqtife6y4rvfbu3h5`. App tables (e.g. the override table) were removed at uninstall — re-derive their names from information_schema AFTER install; do not hard-code `_formulaOverride`.

**Files:**
- Modify: `package.json` (app dir) — `"version": "0.5.1"`
- Create: `verification-reports/2026-08-13-fix-wave/EVIDENCE.md` (app dir; dir is git-excluded like its sibling)

**Interfaces:** consumes everything; produces the evidence file and the wave's verdict.

- [ ] **Step 1: Bump version to 0.5.1 and commit**

```bash
git add packages/twenty-apps/community/formula-field/package.json
git commit -m "chore(formula-field): bump to 0.5.1 for the fix wave"
```

(Local sync below does not gate on version; the bump is publish/install hygiene — the platform's watermark from the burned 0.5.0 line gates registry installs.)

- [ ] **Step 2: Register + sync the local app.** From the app dir with the env sourced and URL verified as localhost: `node /home/sasha_shin/twenty/node_modules/twenty-sdk/dist/cli.cjs dev --once` (build + typecheck + register + sync + regenerate client — the README Runbook `:674-679` verb; `app:install` is registry-only and NOT for local source). Then assert the built manifest carries the grant (the spec's silent-typo mitigation): `grep -c 'canDestroyObjectRecords' .twenty/output/manifest.json` returns ≥2 and both rows name the two object universal identifiers (read them from the two object files). Verify install: `GET $TWENTY_API_URL/rest/formulaDefinitions` returns 200 with an empty list.
- [ ] **Step 3: F3 churn-stop check (recompute lane).** Create via REST a definition replicating the live writer: target `ctrlText`, expression `IF(dealScore > 100, "high", "low")`, enabled. Sync the sweep cadence to `*/3 * * * *` the sanctioned way (edit `formula-sweep.ts:120` — currently `'0 * * * *'` — locally + `dev --once` re-sync; revert the file in Step 7). Data is pre-converged (see intro), so assert via SQL from the FIRST tick onward, two ticks minimum: `SELECT count(*) FROM workspace_1wgvd1injqtife6y4rvfbu3h5.opportunity WHERE "updatedAt" > '<tick ISO>'` = **0** each tick (pre-fix this was 301/tick). Record tick times + counts in EVIDENCE.md.
- [ ] **Step 4: F3 spurious-pin check (event lane).** Do NOT patch an unrelated field — the override loop only runs for formulas whose targetField is in the event's updatedFields. Reachable path: pick a row with `dealScore > 100` (ctrlText 'high'), PATCH `dealScore` to `null` via REST; the app's event recompute clears ctrlText ('high' → NULL, a real diff), and THAT app write fires a second event carrying ctrlText in updatedFields with `after.ctrlText = ''`. Pre-fix, the handler would upsert a spurious ACTIVE pin for `opportunity.ctrlText#<id>`; post-fix, none. Wait ~15s, then assert via SQL that the (re-derived) override table has NO row named `opportunity.ctrlText#<that id>`. Restore `dealScore` afterward. Record in EVIDENCE.md.
- [ ] **Step 5: Delete-completely happy path (must exercise field deletion).** The Step-3 definition reuses a native field (`createdField: false` → the flow deletes no fields — it cannot prove the fix). Instead: in the UI (Playwright, localhost:3001, prefilled login) create a NEW definition through the wizard so the app creates the value field (`createdField: true`), let it activate, then run "Delete completely" from its danger zone: expect NO permission error; definition row, wizard-created value field, and companion all gone. Then create a second wizard definition and fabricate an orphan (hard-delete its value field via the metadata API, the way the broken flow used to leave rows) and run "Delete completely" on it: expect completion (spec's idempotent-retry claim, review-verified at delete-definition-completely.ts:138-163 — this is the live confirmation). If the variation-config danger zone is cheaply reachable, repeat the happy path there; else note it as a cloud-checklist item. Record all in EVIDENCE.md.
- [ ] **Step 6: Permission rows + intersection checks.** Via Postgres MCP: assert two rows in `core."objectPermission"` for the app role with `canDestroyObjectRecords = true`. Best-effort: if the dev seed has a non-admin member, verify Delete completely still denies for them (intersection by design); else note SKIPPED. Record in EVIDENCE.md.
- [ ] **Step 7: Teardown + verdict.** Revert the cadence tweak (`git checkout -- packages/twenty-apps/community/formula-field/src/logic-functions/formula-sweep.ts`) and `dev --once` the clean build; delete the Step-3 REST definition (Delete completely — it deletes no fields, which is correct for `createdField: false`); confirm `git status` clean except intended commits. Fill EVIDENCE.md verdicts (churn-stop / spurious-pin / delete-completely / permissions), each PASS/FAIL with timestamps.

---

## Self-review notes (author, updated after the opus plan review 2026-08-13)

- The opus review's mechanical corrections (17) and semantic findings (14) are FOLDED into this revision: gate-legal fixtures (was the BLOCKER — `amount * 2` on TEXT is refused whole-definition and green-washes the tests), explicit red/green split per test step, FakeClient `writes` log for record-write assertions, `handlers.spec.ts` (not a new file) with pin-test idioms, `defineRole().config` unwrapping + `success` assertion, `src/`-rooted imports, `dev --once` (not `app:deploy`/`app:install`) for local sync, manifest.json grant assertion (spec §Test plan 1), non-vacuous event-lane live check (dealScore 150→NULL clear-echo), wizard-created definition for the delete happy path (`createdField: true`), README `:700` placement + `:693` stale verb, non-widening boundary test, tripwire instead of pre-authorized expectation edits, spec wording fix for the lifecycle-trigger claim.
- Convergence matrix: verified loop-free and idempotent in every cell on both lanes (review finding 5); the `'x'`→computed-`''` cell is the forcing argument for equality-side over read-side folding — captured in ADR 0030 (Task 3).
- Both spec claims (idempotent retry, lifecycle-trigger-on-destroy) review-VERIFIED with citations; Task 4 Step 5 live-confirms the retry claim.
- Event-lane severity language kept honest: live incident observed on the recompute lane only; event payloads verified to carry post-format `''` (platform read), so the spurious-pin path is mechanically reachable but was never observed live.
