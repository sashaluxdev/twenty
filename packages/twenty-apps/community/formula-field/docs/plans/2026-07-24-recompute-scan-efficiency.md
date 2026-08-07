# Recompute Scan Efficiency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut a full-object formula recompute from ~2 API requests per record to ~2 requests per *page*, so a 387-record backfill completes inside the 30s logic-function budget instead of timing out and restarting from the first record.

**Architecture:** `recomputeAllRecords` already paginates with a stable `id ASC` cursor but selects only `edges.node.id`, then re-fetches every record one at a time. `recomputeForRecord` already accepts a `prefetchedRecord` and skips its fetch when that record carries the dependency fields plus the target field. We close that gap by building the scan page's node selection from the same builders the per-record fetch uses, then feed each node straight in as `prefetchedRecord`. On top of that we cache loop-invariant cross-record reads for the duration of a pass, batch the writes through the server's `updateMany` resolver, and persist a scan cursor so a pass that still overruns resumes instead of rewinding to record zero.

**Tech Stack:** TypeScript, Twenty Apps SDK 2.19 (`twenty-sdk` / `twenty-client-sdk` 2.18), raw-GraphQL dynamic client, Vitest 4.

## Global Constraints

- Package root for every path in this plan: `packages/twenty-apps/community/formula-field`. Paths below are relative to it unless stated otherwise.
- Test runner is **Vitest**, not Jest: `npx vitest run <path>`. There is no jest config in this package.
- Files under `src/logic-functions/` must **not** import `twenty-shared` (oxlint rule). Duck-type shapes instead.
- Named exports only. No default exports except the `defineLogicFunction` / `defineObject` module defaults that already exist.
- No `any` in new code. The existing `FormulaClient` type uses `any` for `query`/`mutation` selections; new code layered on it must still be typed at its own boundaries.
- Comments: short-form `//` only, explaining WHY. No JSDoc blocks. Do not restate what the code says.
- Write-avoidance is load-bearing everywhere: a no-op write re-fires the record trigger. Never introduce a write that fires when nothing changed.
- Scan order must stay `orderBy: [{ id: AscNullsFirst }]`. ADR 0022 depends on it: the definition heartbeat samples "first non-error, non-null outcome" of the scan, and an unstable order made that sample flip run-to-run and churn timeline rows.
- `RecomputeOutcome[]` returned by `recomputeAllRecords` must stay in scan order, for the same ADR 0022 reason.
- Per-record fault isolation must survive: one bad record becomes one error outcome, never an aborted pass.
- Run `npx vitest run` (whole suite) and `npm run lint` before every commit. The suite is fast; there is no excuse for skipping it.
- Do **not** deploy to cloud as part of this plan. Deployment is a separate, explicitly-approved step.

---

## Background: what the review actually found

Numbers verified against the live workspace on 2026-07-24 (387 opportunities, 19 enabled definitions, all targeting `opportunity`).

Per record, for a plain same-record formula, the current scan costs:

| Work | Requests |
|---|---|
| `fetchRecord` inside `computeFormulaValueForRecord` | 1 |
| `update<Object>` when the value changed | 0 or 1 |

So a 387-record backfill is 4 page queries + 387 reads + up to 387 writes, ~778 requests. At the observed throughput that overruns the 30s `timeoutSeconds` on `on-formula-definition-created` / `on-formula-definition-updated`, and because `after` is a local variable seeded `undefined` on every invocation, the next pass restarts at the first record id. Records past the timeout horizon are never reached by that trigger at all; only the hourly `formula-sweep` (120s) eventually gets to them.

Three things I asserted before reading the code carefully, that are **wrong** and are therefore not in this plan:

1. *"`resolveFieldKinds` is a per-record network hit."* It is not. `createDynamicCoreClient` caches field kinds per workspace with a 60s TTL over a single `loadAllObjectsWithFields()` call (`src/logic-functions/lib/dynamic-client.ts:156-193`). After the first call it is a map lookup. Hoisting it saves nothing.
2. *"Group batched writes by computed value."* Unsafe. `buildTargetWriteData(targetField, targetFieldType, result, currentRaw, currencyCode)` takes the record's **current** raw value, so two records with an identical computed value can need different write payloads (currency-code preservation). Group by the serialized payload instead.
3. *"Raise `timeoutSeconds` first."* Lowest-value change of the set, and it masks the cursor bug rather than fixing it. Not in this plan. Revisit only if Phases 1-4 leave a real object that still cannot finish.

Two hazards the review surfaced that shape the design:

- **A widened page query converts per-record fault isolation into whole-pass failure.** Today a field the live schema dropped (deactivated, renamed) throws inside one record's `fetchRecord`, becomes that record's error outcome, and the scan continues. Selected in `edges.node`, the same dead field throws out of the page query, out of `recomputeAllRecords`, and out of `formula-sweep`'s per-formula loop, killing every remaining formula in the pass. `FakeClient.assertSelectedFieldsAlive` already models this (`__tests__/fake-client.ts:92-106`) — the codebase calls it the R1 poison window. **The id-only fallback in Task 2 is not optional.**
- **Mirror definitions use a different selection vocabulary.** `computeMirrorValueForRecord` selects `[sourceField, targetField]` through `selectionEntryForMirrorKind`, not `selectionEntryForFieldKind`. A prefetch built with the wrong vocabulary would still satisfy the key-presence `needsFetch` check while carrying a wrongly-shaped composite, so the mirror would compare garbage against its source and either write spuriously or suppress a real write. The selection builder must branch on `isMirrorDefinition`.

Expected result, 387 records, same-record formula:

| Stage | Reads | Writes |
|---|---|---|
| Today | 4 pages + 387 | up to 387 |
| After Task 2 | 4 pages | up to 387 |
| After Task 5 | 4 pages | 4 to 40 |

## Explicitly out of scope

**Single-pass multi-formula evaluation.** All 19 definitions target `opportunity`. In principle `formula-sweep` could page the object *once*, selecting the union of every definition's dependency fields and target fields, evaluate all 19 per record, and issue one write per record carrying 19 fields — collapsing 19 separate scans into one. That is the real architectural ceiling and it is roughly a 10x further win on the sweep.

It is not in this plan because formula-on-formula chaining makes it a design problem, not a mechanical one: when definition B reads the field definition A writes, a combined pass must evaluate in topological order and feed A's freshly computed value to B, rather than relying on A's write firing `on-record-updated` to converge B. The dependency graph needed for that ordering already exists (`findCyclicTargets`, `refreshFormulaStatuses`), so this is tractable — as its own ADR and its own plan, after this one lands and the measurements are in.

## File structure

**Modified:**

- `src/logic-functions/lib/recompute.ts` — the scan. Gains a scan-selection builder, prefetch wiring, an id-only fallback, a per-pass cross-record cache, a compute/write split, and batched flushing. This file is 775 lines today and will grow; Task 5 extracts the write path into a sibling to keep it under control.
- `src/logic-functions/lib/formula-repository.ts` — `loadEnabledFormulas` gains a stable `orderBy`; new `updateScanCursor` helper (Task 6).
- `src/logic-functions/lib/handle-formula-change.ts` — `scanCursor` joins `BOOKKEEPING_FIELDS` (Task 6).
- `src/logic-functions/lib/types.ts` — `FormulaDefinitionRecord.scanCursor` (Task 6).
- `src/objects/formula-definition.object.ts` — the `scanCursor` field (Task 6).
- `src/logic-functions/lib/__tests__/fake-client.ts` — batch-mutation support (Task 5).

**Created:**

- `src/logic-functions/lib/scan-selection.ts` — builds the page-node selection for a definition. Separate file because it is the one piece both the engine and mirror paths must agree on, and it needs its own focused test.
- `src/logic-functions/lib/batch-write.ts` — groups and flushes batched value writes (Task 5).
- `src/logic-functions/lib/plural.ts` — `pluralize` moved out of `recompute.ts` so the batch writer can use it without an import cycle (Task 5).
- `src/logic-functions/lib/__tests__/scan-selection.spec.ts`
- `src/logic-functions/lib/__tests__/scan-prefetch.spec.ts`
- `src/logic-functions/lib/__tests__/cross-record-cache.spec.ts`
- `src/logic-functions/lib/__tests__/batch-write.spec.ts`
- `src/logic-functions/lib/__tests__/scan-resume.spec.ts`
- `docs/adr/0025-recompute-scan-efficiency.md`

## Agent batching

Four batches, each ≤5 agents, dispatched one batch at a time. Read every report before dispatching the next batch. No `fable` subagents.

| Batch | Tasks | Agents | Model | Why |
|---|---|---|---|---|
| 1 | Task 1, Task 2 | 1 implementer | `opus` | Mirror-vs-engine selection vocabulary and the fallback contract are exactly the "get it subtly wrong and it silently writes garbage" case. |
| | | 1 reviewer | `opus` | Blast radius is every formula in every sweep. |
| 2 | Task 3, Task 4 | 1 implementer | `sonnet` | Mechanical caching and a one-line `orderBy`. Fully specified below. |
| | | 1 reviewer | `sonnet` | Mechanical diff. |
| 3 | Task 5 | 1 implementer | `opus` | Compute/write split, payload grouping, outcome ordering, new FakeClient surface. Real design judgment. |
| | | 1 reviewer | `opus` | Touches the recursion guard. |
| 4 | Task 6, Task 7 | 1 implementer | `sonnet` | Field addition + deadline plumbing + ADR, all specified. |
| | | 1 reviewer | `opus` | A schema field ships to a live cloud workspace; the bookkeeping-loop interaction is subtle. |

After Batch 4, one final whole-branch reviewer on `opus`.

---

### Task 1: Scan-selection builder

Build the page-node field selection for a definition, branching on mirror vs engine. Returns `null` when the scan must fall back to id-only (unparseable expression, unresolvable mirror source kind, missing target object/field) so the caller keeps today's per-record behaviour.

**Files:**
- Create: `src/logic-functions/lib/scan-selection.ts`
- Create: `src/logic-functions/lib/__tests__/scan-selection.spec.ts`
- Modify: `src/logic-functions/lib/recompute.ts` — export `fieldSelection`, `dependencySelectionOverrides` and `resolveFieldKinds` so the new module can reuse them

**Interfaces:**
- Consumes: `compileFormula`, `bareReferenceOf` from `src/engine`; `isMirrorDefinition`, `selectionEntryForMirrorKind` from `src/logic-functions/lib/mirror-kinds`; `selectionEntryForFieldKind` from `src/logic-functions/lib/value-io`; `FormulaClient`, `FormulaDefinitionRecord` from `src/logic-functions/lib/types`.
- Produces:
  ```ts
  export type ScanSelection = { fields: string[]; overrides: Record<string, unknown> };
  export const buildScanSelection: (
    client: FormulaClient,
    formula: FormulaDefinitionRecord,
  ) => Promise<ScanSelection | null>;
  export const scanNodeSelection: (scan: ScanSelection) => Record<string, unknown>;
  ```
  Task 2 consumes both.

- [ ] **Step 1: Export the three helpers `scan-selection.ts` needs**

In `src/logic-functions/lib/recompute.ts`, add the `export` keyword to three existing declarations. Change:

```ts
const fieldSelection = (fields: string[]): Record<string, boolean> => {
```
```ts
const resolveFieldKinds = async (
```
```ts
const dependencySelectionOverrides = (
```

to:

```ts
export const fieldSelection = (fields: string[]): Record<string, boolean> => {
```
```ts
export const resolveFieldKinds = async (
```
```ts
export const dependencySelectionOverrides = (
```

Change nothing else in those functions.

- [ ] **Step 2: Write the failing test**

Create `src/logic-functions/lib/__tests__/scan-selection.spec.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';

import { buildScanSelection } from 'src/logic-functions/lib/scan-selection';
import { type FormulaDefinitionRecord } from 'src/logic-functions/lib/types';
import { FakeClient } from 'src/logic-functions/lib/__tests__/fake-client';

const definition = (
  overrides: Partial<FormulaDefinitionRecord>,
): FormulaDefinitionRecord => ({
  id: 'formula-1',
  targetObject: 'opportunity',
  targetField: 'score',
  targetFieldType: 'NUMBER',
  expression: 'amount + 1',
  enabled: true,
  ...overrides,
});

describe('buildScanSelection', () => {
  let client: FakeClient;

  beforeEach(() => {
    client = new FakeClient();
    client.setFieldKinds('opportunity', {
      amount: 'CURRENCY',
      score: 'NUMBER',
      stage: 'SELECT',
      name: 'TEXT',
    });
  });

  it('selects the dependency fields plus the target field for an engine formula', async () => {
    const scan = await buildScanSelection(client, definition({}));

    expect(scan).not.toBeNull();
    expect(scan?.fields).toEqual(['amount']);
    // CURRENCY dependency needs a sub-selection; a scalar selection would
    // silently read null.
    expect(scan?.overrides.amount).toEqual({ amountMicros: true, currencyCode: true });
    // NUMBER target needs no sub-selection.
    expect(scan?.overrides.score).toBe(true);
  });

  it('selects source and target through the mirror vocabulary for a same-record mirror', async () => {
    const scan = await buildScanSelection(
      client,
      definition({
        expression: 'stage',
        targetField: 'stageCopy',
        targetFieldType: 'SELECT',
      }),
    );

    expect(scan?.fields).toEqual(['stage', 'stageCopy']);
    expect(scan?.overrides.stage).toBe(true);
    expect(scan?.overrides.stageCopy).toBe(true);
  });

  it('selects only the target field for a cross-record mirror', async () => {
    client.setFieldKinds('company', { name: 'TEXT' });
    const scan = await buildScanSelection(
      client,
      definition({
        expression: 'company[rec-1].name',
        targetField: 'companyName',
        targetFieldType: 'TEXT',
      }),
    );

    expect(scan?.fields).toEqual(['companyName']);
  });

  it('returns null when the expression does not parse', async () => {
    expect(await buildScanSelection(client, definition({ expression: '((' }))).toBeNull();
  });

  it('returns null when a mirror source field kind cannot be resolved', async () => {
    const scan = await buildScanSelection(
      client,
      definition({
        expression: 'unknownField',
        targetField: 'copy',
        targetFieldType: 'TEXT',
      }),
    );

    // Parity with computeMirrorValueForRecord: an unresolvable kind must fail
    // visibly per record, never be guessed at page level.
    expect(scan).toBeNull();
  });

  it('returns null when the definition has no target object or field', async () => {
    expect(await buildScanSelection(client, definition({ targetObject: null }))).toBeNull();
    expect(await buildScanSelection(client, definition({ targetField: null }))).toBeNull();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
cd packages/twenty-apps/community/formula-field
npx vitest run src/logic-functions/lib/__tests__/scan-selection.spec.ts
```

Expected: FAIL — `Cannot find module 'src/logic-functions/lib/scan-selection'`.

If the cross-record-mirror test's expression syntax `company[rec-1].name` is rejected by the parser, read `src/engine/` for the actual cross-reference syntax and fix the test to match before implementing. Do not change the assertion, only the expression literal.

- [ ] **Step 4: Implement the builder**

Create `src/logic-functions/lib/scan-selection.ts`:

```ts
import { bareReferenceOf, compileFormula } from 'src/engine';
import {
  isMirrorDefinition,
  selectionEntryForMirrorKind,
} from 'src/logic-functions/lib/mirror-kinds';
import {
  dependencySelectionOverrides,
  fieldSelection,
  resolveFieldKinds,
} from 'src/logic-functions/lib/recompute';
import {
  type FormulaClient,
  type FormulaDefinitionRecord,
} from 'src/logic-functions/lib/types';
import { selectionEntryForFieldKind } from 'src/logic-functions/lib/value-io';

// The field selection a scan page must carry so every node arrives complete
// enough for recomputeForRecord's prefetch check to skip its per-record fetch.
export type ScanSelection = {
  fields: string[];
  overrides: Record<string, unknown>;
};

// null means "scan id-only and let the per-record path handle it": the
// expression does not parse, a mirror source kind is unresolvable, or the
// definition is not fully configured. Guessing a selection shape here would
// hand the mirror comparison a wrongly-projected value, which reads as a real
// difference and writes.
export const buildScanSelection = async (
  client: FormulaClient,
  formula: FormulaDefinitionRecord,
): Promise<ScanSelection | null> => {
  const targetObject = formula.targetObject ?? '';
  const targetField = formula.targetField ?? '';
  if (targetObject === '' || targetField === '') {
    return null;
  }

  let compiled: ReturnType<typeof compileFormula>;
  try {
    compiled = compileFormula(formula.expression ?? '');
  } catch {
    return null;
  }

  if (isMirrorDefinition(compiled.ast, formula.targetFieldType)) {
    const bare = bareReferenceOf(compiled.ast);
    if (bare === null) {
      return null;
    }
    const targetEntry = selectionEntryForMirrorKind(formula.targetFieldType);

    // Cross-record mirror: only the current target value lives on the scanned
    // record; the source is fetched once per pass by the cross-record cache.
    if (bare.kind !== 'same') {
      return { fields: [targetField], overrides: { [targetField]: targetEntry } };
    }

    const sourceKind = (await resolveFieldKinds(client, targetObject)).get(bare.field);
    if (sourceKind === undefined) {
      return null;
    }
    return {
      fields: [bare.field, targetField],
      overrides: {
        [bare.field]: selectionEntryForMirrorKind(sourceKind),
        [targetField]: targetEntry,
      },
    };
  }

  const fieldKinds = await resolveFieldKinds(client, targetObject);
  return {
    fields: compiled.dependencies.sameRecordFields,
    overrides: {
      ...dependencySelectionOverrides(compiled.dependencies.sameRecordFields, fieldKinds),
      [targetField]: selectionEntryForFieldKind(formula.targetFieldType),
    },
  };
};

export const scanNodeSelection = (
  scan: ScanSelection,
): Record<string, unknown> => ({
  ...fieldSelection(scan.fields),
  ...scan.overrides,
});
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
npx vitest run src/logic-functions/lib/__tests__/scan-selection.spec.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 6: Run the whole suite and lint**

```bash
npx vitest run && npm run lint
```

Expected: all green.

Note for Task 2: `scan-selection.ts` imports values from `recompute.ts`, and Task 2 makes `recompute.ts` import values back. That is a genuine ESM import cycle. It resolves at runtime because every use on both sides is inside a function body, not at module top level — nothing is read during module evaluation. Keep it that way: do not add a top-level `const` in either module that reads an import from the other.

- [ ] **Step 7: Commit**

```bash
git add src/logic-functions/lib/scan-selection.ts \
        src/logic-functions/lib/__tests__/scan-selection.spec.ts \
        src/logic-functions/lib/recompute.ts
git commit -m "feat(formula-field): build scan page field selection per definition"
```

---

### Task 2: Prefetch the scan page

Wire the selection from Task 1 into `recomputeAllRecords`'s page query and pass each node in as `prefetchedRecord`, with an id-only fallback when the widened query fails.

**Files:**
- Modify: `src/logic-functions/lib/recompute.ts:661-743` (`recomputeAllRecords`)
- Create: `src/logic-functions/lib/__tests__/scan-prefetch.spec.ts`

**Interfaces:**
- Consumes: `buildScanSelection`, `scanNodeSelection`, `type ScanSelection` from Task 1.
- Produces: no signature change. `recomputeAllRecords(client, formula, options)` keeps its shape; `RecomputeOutcome[]` keeps scan order.

- [ ] **Step 1: Write the failing test**

Create `src/logic-functions/lib/__tests__/scan-prefetch.spec.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';

import { recomputeAllRecords } from 'src/logic-functions/lib/recompute';
import { type FormulaDefinitionRecord } from 'src/logic-functions/lib/types';
import { FakeClient } from 'src/logic-functions/lib/__tests__/fake-client';

const FORMULA: FormulaDefinitionRecord = {
  id: 'formula-1',
  targetObject: 'opportunity',
  targetField: 'score',
  targetFieldType: 'NUMBER',
  outputFormat: 'integer',
  expression: 'amount + 1',
  enabled: true,
};

const seedOpportunities = (client: FakeClient, count: number): void => {
  client.setFieldKinds('opportunity', { amount: 'NUMBER', score: 'NUMBER' });
  client.seed(
    'opportunity',
    Array.from({ length: count }, (_unused, index) => ({
      id: `opp-${String(index + 1).padStart(3, '0')}`,
      amount: index + 1,
      score: null,
    })),
  );
};

const singularReads = (client: FakeClient): unknown[] =>
  client.querySelections.filter(
    (selection) => selection.opportunity !== undefined,
  );

const pageReads = (client: FakeClient): any[] =>
  client.querySelections.filter(
    (selection) => selection.opportunities !== undefined,
  );

describe('recomputeAllRecords page prefetch', () => {
  let client: FakeClient;

  beforeEach(() => {
    client = new FakeClient();
  });

  it('issues no per-record read when the page carries the dependency and target fields', async () => {
    seedOpportunities(client, 5);

    const outcomes = await recomputeAllRecords(client, FORMULA, { pageSize: 2 });

    expect(outcomes).toHaveLength(5);
    expect(outcomes.every((outcome) => outcome.error === null)).toBe(true);
    // 3 pages (2 + 2 + 1), zero singular record reads.
    expect(pageReads(client)).toHaveLength(3);
    expect(singularReads(client)).toHaveLength(0);
  });

  it('still writes the correct values through the prefetched path', async () => {
    seedOpportunities(client, 3);

    await recomputeAllRecords(client, FORMULA, { pageSize: 2 });

    expect(client.get('opportunity', 'opp-001')?.score).toBe(2);
    expect(client.get('opportunity', 'opp-002')?.score).toBe(3);
    expect(client.get('opportunity', 'opp-003')?.score).toBe(4);
  });

  it('preserves scan order in the returned outcomes', async () => {
    seedOpportunities(client, 5);

    const outcomes = await recomputeAllRecords(client, FORMULA, { pageSize: 2 });

    expect(outcomes.map((outcome) => outcome.targetRecordId)).toEqual([
      'opp-001',
      'opp-002',
      'opp-003',
      'opp-004',
      'opp-005',
    ]);
  });

  it('falls back to an id-only scan when the widened page query is rejected', async () => {
    seedOpportunities(client, 3);
    // The live schema dropped `amount`: the widened page selection throws, but
    // the pass must survive and degrade to per-record reads.
    client.rejectFieldOnServer('opportunity', 'amount');

    const outcomes = await recomputeAllRecords(client, FORMULA, { pageSize: 2 });

    expect(outcomes).toHaveLength(3);
    // Every record produced an outcome; each error is isolated to its record.
    expect(outcomes.map((outcome) => outcome.targetRecordId)).toEqual([
      'opp-001',
      'opp-002',
      'opp-003',
    ]);
    expect(outcomes.every((outcome) => outcome.error !== null)).toBe(true);
    // It retried each page id-only rather than aborting.
    expect(pageReads(client).length).toBeGreaterThanOrEqual(3);
  });

  it('scans id-only without per-record regression when the expression does not parse', async () => {
    seedOpportunities(client, 2);

    const outcomes = await recomputeAllRecords(
      client,
      { ...FORMULA, expression: '((' },
      { pageSize: 10 },
    );

    expect(outcomes).toHaveLength(2);
    expect(outcomes.every((outcome) => outcome.error !== null)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run src/logic-functions/lib/__tests__/scan-prefetch.spec.ts
```

Expected: FAIL on the first test — `singularReads` has length 5, not 0, because the scan still selects `id` only.

- [ ] **Step 3: Add the import**

In `src/logic-functions/lib/recompute.ts`, add after the existing `mirror-kinds` import:

```ts
import {
  buildScanSelection,
  scanNodeSelection,
  type ScanSelection,
} from 'src/logic-functions/lib/scan-selection';
```

- [ ] **Step 4: Replace the scan loop**

In `recomputeAllRecords`, replace everything from `let after: string | undefined;` through the closing brace of the `for (;;)` loop (currently `recompute.ts:679-743`) with:

```ts
  // Page nodes carry the dependency + target fields so recomputeForRecord's
  // prefetch check skips its per-record read. Null -> id-only scan.
  let scanSelection: ScanSelection | null = await buildScanSelection(client, formula);

  const queryPage = async (
    cursor: string | undefined,
  ): Promise<Record<string, unknown> | null> => {
    const pageArgs = {
      first: pageSize,
      // Stable scan order (ADR 0022): the heartbeat's representative lastValue
      // is "first non-error, non-null outcome" of this scan. Unordered
      // pagination made that sample flip between records run-to-run, defeating
      // the write-avoidance guard and churning formulaDefinition.updated rows.
      orderBy: [{ id: graphqlEnum('AscNullsFirst') }],
      ...(cursor ? { after: cursor } : {}),
    };
    const build = (nodeSelection: Record<string, unknown>) => ({
      [pluralName]: {
        __args: pageArgs,
        edges: { node: nodeSelection },
        pageInfo: { hasNextPage: true, endCursor: true },
      },
    });

    if (scanSelection !== null) {
      try {
        return await withRetry(() =>
          client.query(build(scanNodeSelection(scanSelection as ScanSelection))),
        );
      } catch {
        // A field the live schema dropped would abort the entire pass here and
        // take every remaining formula in the sweep with it. Degrade to the
        // id-only scan and let per-record fetches surface the error one record
        // at a time (the isolation the widened selection would otherwise cost).
        scanSelection = null;
      }
    }
    return withRetry(() => client.query(build({ id: true })));
  };

  let after: string | undefined;

  for (;;) {
    if (options.shouldContinue && !options.shouldContinue()) {
      break;
    }
    const response = await queryPage(after);

    const connection = response?.[pluralName] as
      | {
          edges?: Array<{ node?: Record<string, unknown> }>;
          pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
        }
      | undefined;
    const edges = connection?.edges ?? [];

    for (const edge of edges) {
      if (options.shouldContinue && !options.shouldContinue()) {
        break;
      }
      const node = edge?.node;
      const id = typeof node?.id === 'string' ? node.id : undefined;
      if (!id) {
        continue;
      }
      try {
        outcomes.push(
          await recomputeForRecord({
            client,
            formula,
            targetRecordId: id,
            // Only a widened page yields a usable prefetch. After a fallback,
            // nodes are id-only and the per-record fetch must run.
            prefetchedRecord: scanSelection !== null ? node : undefined,
            overriddenRecordIds,
          }),
        );
      } catch (error) {
        // Per-record fault isolation: a thrown error (a RangeError from a
        // pathologically deep value included) becomes this record's outcome and
        // the sweep continues, rather than one poisoned record aborting the whole
        // pass. The heartbeat below still runs with the accumulated outcomes.
        outcomes.push({
          formulaId: formula.id,
          targetRecordId: id,
          changed: false,
          value: null,
          error: String(error),
        });
      }
    }

    if (!connection?.pageInfo?.hasNextPage) {
      break;
    }
    after = connection.pageInfo.endCursor ?? undefined;
  }
```

Leave the heartbeat block after the loop exactly as it is.

- [ ] **Step 5: Run the test to verify it passes**

```bash
npx vitest run src/logic-functions/lib/__tests__/scan-prefetch.spec.ts
```

Expected: PASS, 5 tests.

If the fallback test fails because `scanSelection` was already `null` when the loop read it for `prefetchedRecord` on a page fetched *before* the failure: that is correct behaviour (a later page's failure makes earlier pages' prefetch decision moot only for records not yet processed). If it fails for any other reason, read `FakeClient.assertSelectedFieldsAlive` and confirm the widened `edges.node` selection is what throws.

- [ ] **Step 6: Run the whole suite and lint**

```bash
npx vitest run && npm run lint
```

Expected: all green. `pagination.spec.ts`, `currency-target.spec.ts`, `date-target.spec.ts`, `integer-target.spec.ts`, `mirror-target.spec.ts` and `recompute.spec.ts` all exercise this path — if any of them now fails, the prefetch is handing the compute path a wrongly-shaped record. Fix the selection builder, not the test.

- [ ] **Step 7: Commit**

```bash
git add src/logic-functions/lib/recompute.ts \
        src/logic-functions/lib/__tests__/scan-prefetch.spec.ts
git commit -m "perf(formula-field): prefetch scan pages instead of reading each record"
```

---

### Task 3: Per-pass cross-record cache

Cross-record references bake a fixed `recordId` into the expression, so every target record in a pass resolves the *same* referenced records. Today each one is fetched per target record: `fetchCrossRecords` (`recompute.ts:135-172`) for engine formulas, and the source fetch at `recompute.ts:476-482` for cross-record mirrors.

**Files:**
- Modify: `src/logic-functions/lib/recompute.ts`
- Create: `src/logic-functions/lib/__tests__/cross-record-cache.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  export type CrossRecordCache = Map<string, Record<string, unknown> | null>;
  ```
  `RecomputeArgs` gains `crossRecordCache?: CrossRecordCache`. `recomputeAllRecords` creates one per pass and threads it through.

- [ ] **Step 1: Write the failing test**

Create `src/logic-functions/lib/__tests__/cross-record-cache.spec.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';

import { recomputeAllRecords } from 'src/logic-functions/lib/recompute';
import { type FormulaDefinitionRecord } from 'src/logic-functions/lib/types';
import { FakeClient } from 'src/logic-functions/lib/__tests__/fake-client';

describe('cross-record reads within one pass', () => {
  let client: FakeClient;

  beforeEach(() => {
    client = new FakeClient();
    client.setFieldKinds('opportunity', { score: 'NUMBER' });
    client.setFieldKinds('company', { employees: 'NUMBER' });
    client.seed('company', [{ id: 'co-1', employees: 10 }]);
    client.seed(
      'opportunity',
      Array.from({ length: 5 }, (_unused, index) => ({
        id: `opp-${index + 1}`,
        score: null,
      })),
    );
  });

  it('fetches a referenced record once per pass, not once per target record', async () => {
    const formula: FormulaDefinitionRecord = {
      id: 'formula-1',
      targetObject: 'opportunity',
      targetField: 'score',
      targetFieldType: 'NUMBER',
      outputFormat: 'integer',
      expression: 'company[co-1].employees + 1',
      enabled: true,
    };

    const outcomes = await recomputeAllRecords(client, formula, { pageSize: 10 });

    expect(outcomes).toHaveLength(5);
    expect(client.get('opportunity', 'opp-1')?.score).toBe(11);

    const companyReads = client.querySelections.filter(
      (selection) => selection.company !== undefined,
    );
    expect(companyReads).toHaveLength(1);
  });
});
```

Before running: confirm the cross-reference expression syntax against `src/engine/`. If `company[co-1].employees` is not the grammar, fix the literal to match; keep the assertion.

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run src/logic-functions/lib/__tests__/cross-record-cache.spec.ts
```

Expected: FAIL — `companyReads` has length 5, not 1.

- [ ] **Step 3: Add the cache type and thread it into `fetchCrossRecords`**

In `src/logic-functions/lib/recompute.ts`, add below the `crossKey` helper:

```ts
// Cross-record references bake a fixed recordId into the expression, so every
// target record in a pass resolves the same referenced records. Keyed by
// object + id + the exact field set, so a cache shared across formulas can
// never serve a record fetched with a narrower selection.
export type CrossRecordCache = Map<string, Record<string, unknown> | null>;

const crossCacheKey = (
  object: string,
  recordId: string,
  fields: Iterable<string>,
): string => `${object}:${recordId}:${Array.from(fields).sort().join(',')}`;
```

Replace the body of `fetchCrossRecords` with:

```ts
const fetchCrossRecords = async (
  client: FormulaClient,
  dependencies: FormulaDependencies,
  cache?: CrossRecordCache,
): Promise<Map<string, Record<string, unknown> | null>> => {
  const byRecord = new Map<
    string,
    { object: string; recordId: string; fields: Set<string> }
  >();

  for (const ref of dependencies.crossRecordRefs) {
    const key = crossKey(ref.object, ref.recordId);
    const existing = byRecord.get(key);
    if (existing) {
      existing.fields.add(ref.field);
    } else {
      byRecord.set(key, {
        object: ref.object,
        recordId: ref.recordId,
        fields: new Set([ref.field]),
      });
    }
  }

  const results = new Map<string, Record<string, unknown> | null>();

  for (const { object, recordId, fields } of byRecord.values()) {
    const cacheKey = crossCacheKey(object, recordId, fields);
    if (cache?.has(cacheKey)) {
      results.set(crossKey(object, recordId), cache.get(cacheKey) ?? null);
      continue;
    }
    const record = await fetchRecord(
      client,
      object,
      recordId,
      Array.from(fields),
      dependencySelectionOverrides(fields, await resolveFieldKinds(client, object)),
    );
    cache?.set(cacheKey, record);
    results.set(crossKey(object, recordId), record);
  }

  return results;
};
```

- [ ] **Step 4: Thread the cache through the compute path**

In `RecomputeArgs`, add after `overriddenRecordIds`:

```ts
  // Shared across one recomputeAllRecords pass so a fixed cross-reference is
  // fetched once, not once per target record.
  crossRecordCache?: CrossRecordCache;
```

In `computeFormulaValueForRecord`, add `crossRecordCache` to the destructured parameters and pass it through:

```ts
    crossRecords = await fetchCrossRecords(client, dependencies, crossRecordCache);
```

In `computeMirrorValueForRecord`, add `crossRecordCache` to the destructured parameters and replace the cross-record mirror source fetch (currently `recompute.ts:474-491`) with:

```ts
  let sourceRecord: Record<string, unknown> | null;
  const sourceCacheKey = crossCacheKey(sourceObject, bare.ref.recordId, [sourceField]);
  if (crossRecordCache?.has(sourceCacheKey)) {
    sourceRecord = crossRecordCache.get(sourceCacheKey) ?? null;
  } else {
    try {
      sourceRecord = await fetchRecord(
        client,
        sourceObject,
        bare.ref.recordId,
        [sourceField],
        { [sourceField]: selectionEntryForMirrorKind(sourceKind) },
      );
    } catch (error) {
      return {
        rawValue: null,
        sameRecord,
        error: `Failed to load ${sourceObject} ${bare.ref.recordId}: ${
          (error as Error).message
        }`,
      };
    }
    crossRecordCache?.set(sourceCacheKey, sourceRecord);
  }
```

In `recomputeForRecord`, add `crossRecordCache` to the destructured parameters and forward it in both the `computeMirrorValueForRecord` call and the `computeFormulaValueForRecord` call.

- [ ] **Step 5: Create the cache once per pass**

In `recomputeAllRecords`, after the `overriddenRecordIds` load, add:

```ts
  const crossRecordCache: CrossRecordCache = new Map();
```

and add `crossRecordCache,` to the `recomputeForRecord` call inside the loop.

- [ ] **Step 6: Run the test to verify it passes**

```bash
npx vitest run src/logic-functions/lib/__tests__/cross-record-cache.spec.ts
```

Expected: PASS, 1 test.

- [ ] **Step 7: Run the whole suite and lint, then commit**

```bash
npx vitest run && npm run lint
git add src/logic-functions/lib/recompute.ts \
        src/logic-functions/lib/__tests__/cross-record-cache.spec.ts
git commit -m "perf(formula-field): cache cross-record reads for the duration of a pass"
```

---

### Task 4: Deterministic formula order in the sweep

`loadEnabledFormulas` (`src/logic-functions/lib/formula-repository.ts:35-80`) pages without an `orderBy`, so the order the hourly sweep walks its 19 definitions is unspecified. Once the sweep is time-bounded (Task 7), an unstable order means some definitions can be starved indefinitely. One-line fix, folded in here because it shares the sweep's test surface.

**Files:**
- Modify: `src/logic-functions/lib/formula-repository.ts`

**Interfaces:**
- Consumes: `graphqlEnum` from `src/logic-functions/lib/dynamic-client` (import it if `formula-repository.ts` does not already).
- Produces: no signature change.

- [ ] **Step 1: Write the failing test**

Append to `src/logic-functions/lib/__tests__/handlers.spec.ts` (or create a `describe` block in it):

```ts
describe('loadEnabledFormulas ordering', () => {
  it('requests a stable id-ordered page so a time-bounded sweep cannot starve a definition', async () => {
    const client = new FakeClient();
    client.seed('formulaDefinition', [
      { id: 'formula-b', enabled: true, targetObject: 'opportunity', targetField: 'b' },
      { id: 'formula-a', enabled: true, targetObject: 'opportunity', targetField: 'a' },
    ]);

    await loadAllEnabledFormulas(client);

    const pageQuery = client.querySelections.find(
      (selection) => selection.formulaDefinitions !== undefined,
    );
    expect(pageQuery.formulaDefinitions.__args.orderBy).toEqual([
      { id: { __graphqlEnum: 'AscNullsFirst' } },
    ]);
  });
});
```

Add `loadAllEnabledFormulas` to the file's existing imports from `src/logic-functions/lib/formula-repository` if it is not already imported.

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run src/logic-functions/lib/__tests__/handlers.spec.ts
```

Expected: FAIL — `orderBy` is `undefined`.

- [ ] **Step 3: Add the orderBy**

In `src/logic-functions/lib/formula-repository.ts`, inside `loadEnabledFormulas`'s `__args`, add alongside `first` / `after` / `filter`:

```ts
            // Stable order so a time-bounded sweep resumes at a predictable
            // definition instead of starving whichever ones land late in an
            // unspecified ordering.
            orderBy: [{ id: graphqlEnum('AscNullsFirst') }],
```

Add the import if missing:

```ts
import { graphqlEnum } from 'src/logic-functions/lib/dynamic-client';
```

- [ ] **Step 4: Run the test to verify it passes, then the whole suite**

```bash
npx vitest run src/logic-functions/lib/__tests__/handlers.spec.ts
npx vitest run && npm run lint
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/logic-functions/lib/formula-repository.ts \
        src/logic-functions/lib/__tests__/handlers.spec.ts
git commit -m "fix(formula-field): order the enabled-formula scan by id"
```

---

### Task 5: Batch the value writes

After Task 2 the remaining per-record cost is the write. Split compute from write, collect the pass's pending writes, group them by serialized payload, and flush each group through the server's `updateMany` resolver in chunks of 100.

The batch mutation name is `update` + PascalCase plural (`getResolverName`, `packages/twenty-server/src/engine/utils/get-resolver-name.util.ts:27-28`), so `opportunity` -> `updateOpportunities`, with args `{ filter, data }`. The 100 cap is `MUTATION_MAXIMUM_AFFECTED_RECORDS`, surfaced through client-config as a client-side guardrail; chunk to it regardless.

**Files:**
- Create: `src/logic-functions/lib/batch-write.ts`
- Create: `src/logic-functions/lib/__tests__/batch-write.spec.ts`
- Modify: `src/logic-functions/lib/recompute.ts`
- Modify: `src/logic-functions/lib/__tests__/fake-client.ts`

**Interfaces:**
- Consumes: `pluralize`, `withRetry`, `FormulaClient`.
- Produces:
  ```ts
  export type PendingWrite = { recordId: string; data: Record<string, unknown> };
  export type BatchWriteFailure = { recordId: string; error: string };
  export const flushBatchedWrites: (
    client: FormulaClient,
    targetObject: string,
    writes: PendingWrite[],
  ) => Promise<BatchWriteFailure[]>;
  export const MUTATION_CHUNK_SIZE = 100;
  ```

**Design constraints the implementer must honour:**

1. **Group by serialized payload, never by computed value.** `buildTargetWriteData` folds the record's current raw value into the payload (currency-code preservation), so equal values can need unequal payloads.
2. **Outcome order is scan order.** Build every `RecomputeOutcome` during the compute walk with `changed` set optimistically for records that have a pending write, then downgrade `changed` to `false` and attach the error for any record a flush reports as failed. Do not rebuild the array from the groups.
3. **Fall back per record.** If a batch mutation throws, retry that chunk's records individually via the existing single `update<Object>` path, so one bad record does not fail 99 good ones. Report only the records that fail individually.
4. **Flush per page, not per pass.** Flushing at page boundaries keeps memory bounded and means a timeout loses at most one page of writes rather than the whole pass.

- [ ] **Step 1: Add batch-mutation support to FakeClient**

In `src/logic-functions/lib/__tests__/fake-client.ts`, in `async mutation`, insert before the existing generic `if (key.startsWith('update'))` block:

```ts
    // update<ObjectsPlural>({ filter: { id: { in: [...] } }, data })
    if (key.startsWith('update')) {
      const pluralGuess = lowerFirst(key.slice('update'.length));
      const singularForPlural = this.objectKeys().find(
        (obj) => pluralize(obj) === pluralGuess,
      );
      const filter = node?.__args?.filter;
      if (singularForPlural && filter !== undefined) {
        const ids = (filter?.id?.in ?? []) as string[];
        const data = node.__args.data as Record<string, unknown>;
        this.assertSelectedFieldsAlive(singularForPlural, Object.keys(data));
        const updated: Array<{ id: string }> = [];
        for (const id of ids) {
          const record = this.store.get(singularForPlural)?.get(id);
          if (!record) continue;
          for (const [field, value] of Object.entries(data)) {
            record[field] = value as unknown;
            this.writes.push(
              `${singularForPlural}:${id}:${field}=${JSON.stringify(value)}`,
            );
          }
          updated.push({ id });
        }
        return { [key]: updated };
      }
    }
```

The plural check must come before the singular one: `updateOpportunities` would otherwise fall into the `update<Object>` branch, find no object named `opportunities`, and silently return without writing.

- [ ] **Step 2: Write the failing test**

Create `src/logic-functions/lib/__tests__/batch-write.spec.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';

import { flushBatchedWrites } from 'src/logic-functions/lib/batch-write';
import { FakeClient } from 'src/logic-functions/lib/__tests__/fake-client';

describe('flushBatchedWrites', () => {
  let client: FakeClient;

  beforeEach(() => {
    client = new FakeClient();
    client.setFieldKinds('opportunity', { score: 'NUMBER' });
    client.seed(
      'opportunity',
      Array.from({ length: 5 }, (_unused, index) => ({
        id: `opp-${index + 1}`,
        score: null,
      })),
    );
  });

  it('issues one mutation per distinct payload, not one per record', async () => {
    const failures = await flushBatchedWrites(client, 'opportunity', [
      { recordId: 'opp-1', data: { score: 1 } },
      { recordId: 'opp-2', data: { score: 1 } },
      { recordId: 'opp-3', data: { score: 1 } },
      { recordId: 'opp-4', data: { score: 2 } },
      { recordId: 'opp-5', data: { score: 2 } },
    ]);

    expect(failures).toEqual([]);
    expect(client.mutations).toBe(2);
    expect(client.get('opportunity', 'opp-3')?.score).toBe(1);
    expect(client.get('opportunity', 'opp-5')?.score).toBe(2);
  });

  it('chunks a group larger than the mutation cap', async () => {
    client.seed(
      'opportunity',
      Array.from({ length: 250 }, (_unused, index) => ({
        id: `bulk-${String(index).padStart(3, '0')}`,
        score: null,
      })),
    );
    const writes = Array.from({ length: 250 }, (_unused, index) => ({
      recordId: `bulk-${String(index).padStart(3, '0')}`,
      data: { score: 7 },
    }));

    await flushBatchedWrites(client, 'opportunity', writes);

    // 250 records / 100 per chunk = 3 mutations.
    expect(client.mutations).toBe(3);
    expect(client.get('opportunity', 'bulk-249')?.score).toBe(7);
  });

  it('falls back to per-record writes when a batch mutation fails', async () => {
    client.failMutationsFor('updateOpportunities', new Error('batch rejected'));

    const failures = await flushBatchedWrites(client, 'opportunity', [
      { recordId: 'opp-1', data: { score: 1 } },
      { recordId: 'opp-2', data: { score: 1 } },
    ]);

    // Batch failed, both records still written individually.
    expect(failures).toEqual([]);
    expect(client.get('opportunity', 'opp-1')?.score).toBe(1);
    expect(client.get('opportunity', 'opp-2')?.score).toBe(1);
  });

  it('reports only the records whose individual write also fails', async () => {
    client.failMutationsFor('updateOpportunities', new Error('batch rejected'));
    client.failMutationsFor('updateOpportunity', new Error('single rejected'));

    const failures = await flushBatchedWrites(client, 'opportunity', [
      { recordId: 'opp-1', data: { score: 1 } },
    ]);

    expect(failures).toHaveLength(1);
    expect(failures[0].recordId).toBe('opp-1');
    expect(failures[0].error).toContain('single rejected');
  });

  it('does nothing when there is nothing to write', async () => {
    const failures = await flushBatchedWrites(client, 'opportunity', []);

    expect(failures).toEqual([]);
    expect(client.mutations).toBe(0);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
npx vitest run src/logic-functions/lib/__tests__/batch-write.spec.ts
```

Expected: FAIL — `Cannot find module 'src/logic-functions/lib/batch-write'`.

- [ ] **Step 4: Move `pluralize` out of `recompute.ts`**

`batch-write.ts` needs `pluralize`, and Step 7 makes `recompute.ts` import from `batch-write.ts`. Unlike the Task 1/2 cycle this one would be read at module scope, so break it now.

Create `src/logic-functions/lib/plural.ts` and move `IRREGULAR_PLURALS` and `pluralize` into it verbatim from `recompute.ts:45-60`. In `recompute.ts`, replace both declarations with a re-export so existing importers are untouched:

```ts
export { pluralize } from 'src/logic-functions/lib/plural';
```

and add `import { pluralize } from 'src/logic-functions/lib/plural';` for its own internal use.

- [ ] **Step 5: Implement the flusher**

Create `src/logic-functions/lib/batch-write.ts`:

```ts
import { pluralize } from 'src/logic-functions/lib/plural';
import { type FormulaClient } from 'src/logic-functions/lib/types';
import { withRetry } from 'src/logic-functions/lib/with-retry';

// MUTATION_MAXIMUM_AFFECTED_RECORDS. Surfaced by the server through
// client-config as a client-side guardrail rather than enforced in the
// mutation path, so we respect it ourselves.
export const MUTATION_CHUNK_SIZE = 100;

export type PendingWrite = { recordId: string; data: Record<string, unknown> };
export type BatchWriteFailure = { recordId: string; error: string };

const pascalCase = (value: string): string =>
  value.charAt(0).toUpperCase() + value.slice(1);

const chunk = <T>(items: T[], size: number): T[][] => {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
};

const writeOne = async (
  client: FormulaClient,
  targetObject: string,
  write: PendingWrite,
): Promise<BatchWriteFailure | null> => {
  try {
    await withRetry(() =>
      client.mutation({
        [`update${pascalCase(targetObject)}`]: {
          __args: { id: write.recordId, data: write.data },
          id: true,
        },
      }),
    );
    return null;
  } catch (error) {
    return { recordId: write.recordId, error: (error as Error).message };
  }
};

// Groups by the SERIALIZED payload, not by computed value: buildTargetWriteData
// folds the record's current raw value into the payload (currency-code
// preservation), so equal values can need unequal payloads.
export const flushBatchedWrites = async (
  client: FormulaClient,
  targetObject: string,
  writes: PendingWrite[],
): Promise<BatchWriteFailure[]> => {
  if (writes.length === 0) {
    return [];
  }

  const groups = new Map<string, { data: Record<string, unknown>; ids: string[] }>();
  for (const write of writes) {
    const key = JSON.stringify(write.data);
    const group = groups.get(key);
    if (group) {
      group.ids.push(write.recordId);
    } else {
      groups.set(key, { data: write.data, ids: [write.recordId] });
    }
  }

  const batchMutationName = `update${pascalCase(pluralize(targetObject))}`;
  const failures: BatchWriteFailure[] = [];

  for (const group of groups.values()) {
    for (const ids of chunk(group.ids, MUTATION_CHUNK_SIZE)) {
      try {
        await withRetry(() =>
          client.mutation({
            [batchMutationName]: {
              __args: { filter: { id: { in: ids } }, data: group.data },
              id: true,
            },
          }),
        );
      } catch {
        // One rejected batch must not fail the 99 good records in it: retry the
        // chunk record by record and report only what genuinely fails.
        for (const recordId of ids) {
          const failure = await writeOne(client, targetObject, {
            recordId,
            data: group.data,
          });
          if (failure) {
            failures.push(failure);
          }
        }
      }
    }
  }

  return failures;
};
```

- [ ] **Step 6: Run the test to verify it passes**

```bash
npx vitest run src/logic-functions/lib/__tests__/batch-write.spec.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 7: Commit the flusher before wiring it in**

```bash
npx vitest run && npm run lint
git add src/logic-functions/lib/batch-write.ts \
        src/logic-functions/lib/plural.ts \
        src/logic-functions/lib/recompute.ts \
        src/logic-functions/lib/__tests__/batch-write.spec.ts \
        src/logic-functions/lib/__tests__/fake-client.ts
git commit -m "feat(formula-field): add grouped batch writer for value fields"
```

- [ ] **Step 8: Split compute from write in `recomputeForRecord`**

In `src/logic-functions/lib/recompute.ts`, extract a planner. Add above `recomputeForRecord`:

```ts
export type RecomputePlan = {
  outcome: RecomputeOutcome;
  write: PendingWrite | null;
};

// Everything recomputeForRecord does EXCEPT the mutation, so a full-object scan
// can collect a page's writes and flush them in batches. `outcome.changed` is
// optimistic when `write` is non-null: the caller downgrades it if the flush
// reports that record as failed.
export const planRecomputeForRecord = async ({
  client,
  formula,
  targetRecordId,
  prefetchedRecord,
  overriddenRecordIds,
  crossRecordCache,
}: RecomputeArgs): Promise<RecomputePlan> => {
```

Move the entire current body of `recomputeForRecord` into `planRecomputeForRecord`, replacing each of the two mutation blocks with a returned plan:

- Mirror path: instead of the `client.mutation` call and its try/catch, return
  ```ts
    return {
      outcome: { ...base, changed: true, rawValue: mirror.rawValue },
      write: { recordId: targetRecordId, data: { [targetField]: mirror.rawValue } },
    };
  ```
- Engine path: instead of the `client.mutation` call and its try/catch, return
  ```ts
    return {
      outcome: { ...base, value: result, changed: true },
      write: {
        recordId: targetRecordId,
        data: buildTargetWriteData(
          targetField,
          formula.targetFieldType,
          result,
          currentRaw,
          formula.currencyCode,
        ),
      },
    };
  ```
- Every other `return { ...base, ... }` in the body becomes `return { outcome: { ...base, ... }, write: null };`

Then reduce `recomputeForRecord` to a wrapper that preserves its exact current contract for the single-record handlers:

```ts
export const recomputeForRecord = async (
  args: RecomputeArgs,
): Promise<RecomputeOutcome> => {
  const plan = await planRecomputeForRecord(args);
  if (plan.write === null) {
    return plan.outcome;
  }
  const failures = await flushBatchedWrites(
    args.client,
    args.formula.targetObject ?? '',
    [plan.write],
  );
  if (failures.length > 0) {
    return {
      ...plan.outcome,
      changed: false,
      error: `Failed to write ${args.formula.targetField ?? ''}: ${failures[0].error}`,
    };
  }
  return plan.outcome;
};
```

Add the imports:

```ts
import {
  flushBatchedWrites,
  type PendingWrite,
} from 'src/logic-functions/lib/batch-write';
```

Step 4 already broke the `pluralize` cycle, so this import direction is one-way and safe.

- [ ] **Step 9: Flush per page in `recomputeAllRecords`**

In the scan loop, replace the `recomputeForRecord` call with the planner, accumulating per page:

```ts
    const pendingWrites: PendingWrite[] = [];
    const pageOutcomes: RecomputeOutcome[] = [];

    for (const edge of edges) {
      // ... unchanged id extraction ...
      try {
        const plan = await planRecomputeForRecord({
          client,
          formula,
          targetRecordId: id,
          prefetchedRecord: scanSelection !== null ? node : undefined,
          overriddenRecordIds,
          crossRecordCache,
        });
        pageOutcomes.push(plan.outcome);
        if (plan.write !== null) {
          pendingWrites.push(plan.write);
        }
      } catch (error) {
        pageOutcomes.push({
          formulaId: formula.id,
          targetRecordId: id,
          changed: false,
          value: null,
          error: String(error),
        });
      }
    }

    // Flush per page, not per pass: memory stays bounded and a timeout loses at
    // most one page of writes.
    const failures = await flushBatchedWrites(client, targetObject, pendingWrites);
    const failuresByRecordId = new Map(
      failures.map((failure) => [failure.recordId, failure.error]),
    );
    for (const outcome of pageOutcomes) {
      const failure = failuresByRecordId.get(outcome.targetRecordId);
      if (failure !== undefined) {
        outcome.changed = false;
        outcome.error = `Failed to write ${targetField}: ${failure}`;
      }
    }
    outcomes.push(...pageOutcomes);
```

- [ ] **Step 10: Add the scan-level batching test**

Append to `src/logic-functions/lib/__tests__/scan-prefetch.spec.ts`:

```ts
  it('writes a whole page through batched mutations instead of one per record', async () => {
    seedOpportunities(client, 5);
    // All five compute distinct values, so grouping cannot collapse them; the
    // page still flushes as 5 grouped mutations, not 5 singular ones.
    await recomputeAllRecords(client, FORMULA, { pageSize: 5 });

    const singularWrites = client.mutationSelections.filter(
      (selection) => selection.updateOpportunity !== undefined,
    );
    expect(singularWrites).toHaveLength(0);
    expect(client.get('opportunity', 'opp-005')?.score).toBe(6);
  });

  it('collapses a page of identical values into a single mutation', async () => {
    client.setFieldKinds('opportunity', { amount: 'NUMBER', score: 'NUMBER' });
    client.seed(
      'opportunity',
      Array.from({ length: 5 }, (_unused, index) => ({
        id: `flat-${index + 1}`,
        amount: 10,
        score: null,
      })),
    );

    await recomputeAllRecords(client, FORMULA, { pageSize: 10 });

    const batchWrites = client.mutationSelections.filter(
      (selection) => selection.updateOpportunities !== undefined,
    );
    expect(batchWrites).toHaveLength(1);
  });
```

- [ ] **Step 11: Run the whole suite**

```bash
npx vitest run && npm run lint
```

Expected: all green. `recompute.spec.ts`, `mirror-target.spec.ts`, `currency-target.spec.ts` and `integer-target.spec.ts` assert on `client.writes` and `client.mutationSelections` — some will now see `updateOpportunities` where they expected `updateOpportunity`. Update those assertions to match the batched shape; do **not** weaken any assertion about *what value* was written.

- [ ] **Step 12: Commit**

```bash
git add -A src/logic-functions/lib
git commit -m "perf(formula-field): flush scan writes in grouped batches per page"
```

---

### Task 6: Persist a scan cursor

Give `FormulaDefinition` a `scanCursor` field so a pass that cannot finish resumes at the next unscanned record instead of rewinding to the first id.

**Files:**
- Modify: `src/objects/formula-definition.object.ts`
- Modify: `src/logic-functions/lib/types.ts`
- Modify: `src/logic-functions/lib/formula-repository.ts`
- Modify: `src/logic-functions/lib/handle-formula-change.ts:16-24`

**Interfaces:**
- Produces:
  ```ts
  export const updateScanCursor: (
    client: FormulaClient,
    formulaId: string,
    cursor: string | null,
  ) => Promise<void>;
  ```
  `FormulaDefinitionRecord` gains `scanCursor?: string | null`.

- [ ] **Step 1: Add the field to the object definition**

In `src/objects/formula-definition.object.ts`, add to `FORMULA_DEFINITION_FIELDS`:

```ts
  scanCursor: '8f2b6d14-7a35-4c9e-b0d8-3e61f4a72c95',
```

and add to the `fields` array, next to the other system-managed bookkeeping fields:

```ts
    {
      universalIdentifier: FORMULA_DEFINITION_FIELDS.scanCursor,
      type: FieldType.TEXT,
      name: 'scanCursor',
      label: 'Scan cursor',
      description:
        'Resume point for a full-object recompute that ran out of budget. ' +
        'Empty when the last pass completed. System-managed.',
      icon: 'IconBookmark',
      isUIEditable: false,
    },
```

- [ ] **Step 2: Add the field to the record type**

In `src/logic-functions/lib/types.ts`, add to `FormulaDefinitionRecord` after `lastEvaluatedAt`:

```ts
  // Resume point for a budget-bounded full-object recompute (ADR 0025). Empty
  // string or null means "start from the first record".
  scanCursor?: string | null;
```

- [ ] **Step 3: Select the field where definitions are loaded**

In `src/logic-functions/lib/formula-repository.ts`, add `scanCursor: true` to the node selection in `loadEnabledFormulas` alongside `lastError` / `status`. Search the file for every other place that selects a definition's fields and add it there too.

- [ ] **Step 4: Add the cursor writer**

In `src/logic-functions/lib/formula-repository.ts`, add:

```ts
// Write-avoidance is handled by the caller (it only calls this when the cursor
// actually moves) — an unconditional write here would re-fire the definition
// trigger on every page.
export const updateScanCursor = async (
  client: FormulaClient,
  formulaId: string,
  cursor: string | null,
): Promise<void> => {
  await withRetry(() =>
    client.mutation({
      updateFormulaDefinition: {
        __args: { id: formulaId, data: { scanCursor: cursor ?? '' } },
        id: true,
      },
    }),
  );
};
```

- [ ] **Step 5: Register it as bookkeeping**

In `src/logic-functions/lib/handle-formula-change.ts`, add `'scanCursor'` to `BOOKKEEPING_FIELDS`:

```ts
const BOOKKEEPING_FIELDS = new Set([
  'dependencies',
  'lastEvaluatedAt',
  'lastValue',
  'lastValueText',
  'lastError',
  'status',
  'statusReason',
  'scanCursor',
]);
```

Without this, every cursor write re-enters `handleFormulaChange`, which calls `recomputeAllRecords`, which writes the cursor again: an infinite recompute loop against the live workspace. This step is not optional and it is the reason Batch 4 gets an `opus` reviewer.

- [ ] **Step 6: Write the test**

Create `src/logic-functions/lib/__tests__/scan-resume.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { handleFormulaChange } from 'src/logic-functions/lib/handle-formula-change';
import { FakeClient } from 'src/logic-functions/lib/__tests__/fake-client';

describe('scanCursor bookkeeping', () => {
  it('does not re-enter formula handling when only the scan cursor changed', async () => {
    const client = new FakeClient();
    const after = {
      id: 'formula-1',
      targetObject: 'opportunity',
      targetField: 'score',
      targetFieldType: 'NUMBER',
      expression: 'amount + 1',
      enabled: true,
      scanCursor: 'opp-100',
    };

    const result = await handleFormulaChange({
      client,
      after,
      updatedFields: ['scanCursor'],
    });

    expect(result).toEqual({ handled: false, reason: 'bookkeeping-only' });
    expect(client.mutations).toBe(0);
  });
});
```

- [ ] **Step 7: Run the tests, lint, commit**

```bash
npx vitest run src/logic-functions/lib/__tests__/scan-resume.spec.ts
npx vitest run && npm run lint
git add src/objects/formula-definition.object.ts \
        src/logic-functions/lib/types.ts \
        src/logic-functions/lib/formula-repository.ts \
        src/logic-functions/lib/handle-formula-change.ts \
        src/logic-functions/lib/__tests__/scan-resume.spec.ts
git commit -m "feat(formula-field): persist a resume cursor on formula definitions"
```

---

### Task 7: Budget-bounded, resumable scan

Use the cursor from Task 6: start the scan where the last pass stopped, stop at a deadline instead of a timeout, and clear the cursor on a completed pass.

**Files:**
- Modify: `src/logic-functions/lib/recompute.ts`
- Modify: `src/logic-functions/formula-sweep.ts`
- Create: `docs/adr/0025-recompute-scan-efficiency.md`

**Interfaces:**
- Consumes: `updateScanCursor` from Task 6.
- Produces: `RecomputeAllRecordsOptions` gains `deadlineAt?: number` (epoch ms; the scan stops at the next page boundary once `Date.now() >= deadlineAt`).

- [ ] **Step 1: Write the failing test**

Append to `src/logic-functions/lib/__tests__/scan-resume.spec.ts`:

```ts
import { recomputeAllRecords } from 'src/logic-functions/lib/recompute';
import { type FormulaDefinitionRecord } from 'src/logic-functions/lib/types';

const RESUME_FORMULA: FormulaDefinitionRecord = {
  id: 'formula-1',
  targetObject: 'opportunity',
  targetField: 'score',
  targetFieldType: 'NUMBER',
  outputFormat: 'integer',
  expression: 'amount + 1',
  enabled: true,
};

describe('budget-bounded resumable scan', () => {
  const seed = (client: FakeClient, count: number): void => {
    client.setFieldKinds('opportunity', { amount: 'NUMBER', score: 'NUMBER' });
    client.seed('formulaDefinition', [{ ...RESUME_FORMULA }]);
    client.seed(
      'opportunity',
      Array.from({ length: count }, (_unused, index) => ({
        id: `opp-${String(index + 1).padStart(3, '0')}`,
        amount: index + 1,
        score: null,
      })),
    );
  };

  it('stops at a page boundary once the deadline passes and stores the cursor', async () => {
    const client = new FakeClient();
    seed(client, 6);

    // Deadline already passed: exactly one page runs, then the scan yields.
    const outcomes = await recomputeAllRecords(client, RESUME_FORMULA, {
      pageSize: 2,
      deadlineAt: Date.now() - 1,
    });

    expect(outcomes).toHaveLength(2);
    expect(client.get('formulaDefinition', 'formula-1')?.scanCursor).toBe('opp-002');
  });

  it('resumes from the stored cursor instead of the first record', async () => {
    const client = new FakeClient();
    seed(client, 6);

    const outcomes = await recomputeAllRecords(
      client,
      { ...RESUME_FORMULA, scanCursor: 'opp-004' },
      { pageSize: 10 },
    );

    expect(outcomes.map((outcome) => outcome.targetRecordId)).toEqual([
      'opp-005',
      'opp-006',
    ]);
  });

  it('clears the cursor when a pass reaches the end', async () => {
    const client = new FakeClient();
    seed(client, 3);
    client.seed('formulaDefinition', [{ ...RESUME_FORMULA, scanCursor: 'opp-001' }]);

    await recomputeAllRecords(
      client,
      { ...RESUME_FORMULA, scanCursor: 'opp-001' },
      { pageSize: 10 },
    );

    expect(client.get('formulaDefinition', 'formula-1')?.scanCursor).toBe('');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run src/logic-functions/lib/__tests__/scan-resume.spec.ts
```

Expected: FAIL — `deadlineAt` is not an option and no cursor is written.

- [ ] **Step 3: Implement the budget and resume**

In `RecomputeAllRecordsOptions`, add:

```ts
  // Epoch ms. The scan stops at the next PAGE boundary once this passes and
  // persists its cursor, so the next invocation resumes instead of rewinding to
  // the first record id. Page boundary, not record boundary: a partially
  // flushed page would store a cursor past records whose writes never landed.
  deadlineAt?: number;
```

In `recomputeAllRecords`, seed the cursor from the definition:

```ts
  let after: string | undefined = formula.scanCursor || undefined;
```

At the end of each page iteration, after the flush and before the `hasNextPage` check:

```ts
    const nextCursor = connection?.pageInfo?.endCursor ?? undefined;
    const outOfBudget =
      options.deadlineAt !== undefined && Date.now() >= options.deadlineAt;

    if (connection?.pageInfo?.hasNextPage && outOfBudget) {
      await updateScanCursor(client, formula.id, nextCursor ?? null);
      return outcomes;
    }

    if (!connection?.pageInfo?.hasNextPage) {
      // Completed pass: clear the resume point. Write-avoidant.
      if ((formula.scanCursor ?? '') !== '') {
        await updateScanCursor(client, formula.id, null);
      }
      break;
    }
    after = nextCursor;
```

Note the early `return outcomes` on the budget path: it skips the heartbeat, because a partial pass's "first non-error, non-null outcome" is a different sample than a full pass's and would churn `lastValue` between partial and full runs (ADR 0022).

Delete the old `if (!connection?.pageInfo?.hasNextPage) { break; } after = ...` lines that this replaces.

Add the import:

```ts
import {
  recordEvaluationHeartbeat,
  updateScanCursor,
} from 'src/logic-functions/lib/formula-repository';
```

- [ ] **Step 4: Give the sweep a deadline**

In `src/logic-functions/formula-sweep.ts`, add above the handler:

```ts
// The function's declared timeoutSeconds is 120; leave headroom for the
// bookkeeping writes that follow the scans.
const SWEEP_BUDGET_MS = 100_000;
```

Inside `handler`, capture the start and pass a per-formula deadline:

```ts
const startedAt = Date.now();
```

and change the recompute call to:

```ts
    const outcomes = await recomputeAllRecords(client, formula, {
      deadlineAt: startedAt + SWEEP_BUDGET_MS,
    });
```

- [ ] **Step 5: Run the tests**

```bash
npx vitest run src/logic-functions/lib/__tests__/scan-resume.spec.ts
npx vitest run && npm run lint
```

Expected: PASS.

- [ ] **Step 6: Write ADR 0025**

Create `docs/adr/0025-recompute-scan-efficiency.md` following the structure of `docs/adr/0022-timeline-bookkeeping-quiet.md`. It must state:

- **Context:** a full-object recompute cost ~2 API requests per record (a per-record read plus a conditional write), the definition-change handlers run it inside a 30s budget, and the scan cursor was a local variable, so an overrunning pass restarted at the first record id and the tail was never reached by that trigger. Measured 2026-07-24: 387 opportunities, 19 enabled definitions.
- **Decision:** page nodes carry the dependency and target fields so the per-record read disappears; cross-record references are cached for a pass; writes are grouped by serialized payload and flushed through `updateMany` in chunks of 100 at each page boundary; the scan cursor is persisted on the definition and the scan yields at a page boundary when its budget expires.
- **Consequences:** a widened page selection would turn a dropped field from a per-record error into a whole-pass abort, so the scan falls back to an id-only page and per-record reads on any page-query rejection. Batched writes still emit one `record.updated` event per record, so downstream trigger load is unchanged. `scanCursor` is bookkeeping and must stay in `BOOKKEEPING_FIELDS`.
- **Not done:** single-pass multi-formula evaluation per object, which needs topological ordering across formula-on-formula chains. Record it as the identified next step.

- [ ] **Step 7: Commit**

```bash
git add src/logic-functions/lib/recompute.ts \
        src/logic-functions/formula-sweep.ts \
        src/logic-functions/lib/__tests__/scan-resume.spec.ts \
        docs/adr/0025-recompute-scan-efficiency.md
git commit -m "feat(formula-field): resume full-object scans from a persisted cursor"
```

---

## Verification before calling this done

- [ ] `npx vitest run` — whole suite green, no skipped tests.
- [ ] `npm run lint` — clean.
- [ ] `npx tsc --noEmit` — clean.
- [ ] Grep for stragglers: `grep -rn "recomputeForRecord" src/` — every caller still compiles against the wrapper's unchanged signature.
- [ ] Confirm no test was weakened: `git diff main -- 'src/**/__tests__/**'` should show new assertions and mutation-shape updates only, never a removed value assertion.
- [ ] Report the measured request counts for a 387-record scan against the FakeClient (seed 387 records, assert `client.queries` and `client.mutations`) and put the numbers in the ADR's Consequences section, replacing any estimate.

Deployment to cloud is **not** part of this plan. The app version bump and `scanCursor` field rollout to the live workspace need explicit approval, and the field addition means a real schema change on a workspace that currently holds 23 definitions.
