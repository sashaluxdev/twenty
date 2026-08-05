import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { compileFormula } from 'src/engine';
import { parse } from 'src/engine/parser';
import { recordEvaluationHeartbeat } from 'src/logic-functions/lib/formula-repository';
import {
  planRecomputeForRecord,
  recomputeAllRecords,
  recomputeForRecord,
} from 'src/logic-functions/lib/recompute';
import { type FormulaDefinitionRecord } from 'src/logic-functions/lib/types';
import { FakeClient } from 'src/logic-functions/lib/__tests__/fake-client';

// Parse-count seam: compileFormula binds `parse` from src/engine/parser
// directly, so spying on the src/engine barrel records nothing. A pass-through
// spy on the parser module is the only place the real call count is observable.
vi.mock('src/engine/parser', async (importActual) => {
  const actual = await importActual<typeof import('src/engine/parser')>();
  return { ...actual, parse: vi.fn(actual.parse) };
});

const formula = (
  overrides: Partial<FormulaDefinitionRecord> = {},
): FormulaDefinitionRecord => ({
  id: 'f1',
  targetObject: 'opportunity',
  targetField: 'formulaScore',
  expression: 'formulaInputA + formulaInputB * 2',
  enabled: true,
  ...overrides,
});

describe('recomputeForRecord', () => {
  let client: FakeClient;

  beforeEach(() => {
    client = new FakeClient();
  });

  it('writes the computed value when it changed', async () => {
    client.seed('opportunity', [
      { id: 'o1', formulaInputA: 5, formulaInputB: 10, formulaScore: null },
    ]);

    const outcome = await recomputeForRecord({
      client,
      formula: formula(),
      targetRecordId: 'o1',
    });

    expect(outcome.value).toEqual({ kind: 'number', value: 25 });
    expect(outcome.changed).toBe(true);
    expect(client.get('opportunity', 'o1')!.formulaScore).toBe(25);
  });

  it('suppresses the write when the value is unchanged (recursion guard)', async () => {
    client.seed('opportunity', [
      { id: 'o1', formulaInputA: 5, formulaInputB: 10, formulaScore: 25 },
    ]);

    const outcome = await recomputeForRecord({
      client,
      formula: formula(),
      targetRecordId: 'o1',
    });

    expect(outcome.value).toEqual({ kind: 'number', value: 25 });
    expect(outcome.changed).toBe(false);
    expect(client.writes).toHaveLength(0);
    expect(client.mutations).toBe(0);
  });

  it('uses the prefetched record without an extra query', async () => {
    client.seed('opportunity', [
      { id: 'o1', formulaInputA: 1, formulaInputB: 1, formulaScore: null },
    ]);

    const outcome = await recomputeForRecord({
      client,
      formula: formula(),
      targetRecordId: 'o1',
      prefetchedRecord: {
        id: 'o1',
        formulaInputA: 3,
        formulaInputB: 4,
        formulaScore: null,
      },
    });

    // Uses prefetched inputs (3 + 4*2 = 11), no read query needed.
    expect(outcome.value).toEqual({ kind: 'number', value: 11 });
    expect(client.queries).toBe(0);
  });

  it('clears the value to null under null propagation', async () => {
    client.seed('opportunity', [
      { id: 'o1', formulaInputA: 5, formulaInputB: null, formulaScore: 25 },
    ]);

    const outcome = await recomputeForRecord({
      client,
      formula: formula(),
      targetRecordId: 'o1',
    });

    expect(outcome.value).toEqual({ kind: 'number', value: null });
    expect(outcome.changed).toBe(true);
    expect(client.get('opportunity', 'o1')!.formulaScore).toBeNull();
  });

  it('records an error and leaves the value unchanged on divide-by-zero', async () => {
    client.seed('opportunity', [
      { id: 'o1', formulaInputA: 5, formulaScore: 99 },
    ]);

    const outcome = await recomputeForRecord({
      client,
      formula: formula({ expression: 'formulaInputA / 0' }),
      targetRecordId: 'o1',
    });

    expect(outcome.error).toMatch(/DIVISION_BY_ZERO/);
    expect(outcome.changed).toBe(false);
    // Last good value retained.
    expect(client.get('opportunity', 'o1')!.formulaScore).toBe(99);
  });

  it('skips a manually overridden record (leaves its value untouched)', async () => {
    client.seed('opportunity', [
      { id: 'o1', formulaInputA: 5, formulaInputB: 10, formulaScore: 99 },
    ]);

    const outcome = await recomputeForRecord({
      client,
      formula: formula(),
      targetRecordId: 'o1',
      overriddenRecordIds: new Set(['o1']),
    });

    expect(outcome.overridden).toBe(true);
    expect(outcome.changed).toBe(false);
    expect(client.writes).toHaveLength(0);
    // The pinned value stands even though the formula would say 25.
    expect(client.get('opportunity', 'o1')!.formulaScore).toBe(99);
  });

  it('resolves cross-record references', async () => {
    const companyId = '20202020-1c25-4d02-bf25-6aeccf7ea419';
    client.seed('opportunity', [
      { id: 'o1', formulaInputA: 5, formulaCrossScore: null },
    ]);
    client.seed('company', [{ id: companyId, employees: 100 }]);

    const outcome = await recomputeForRecord({
      client,
      formula: formula({
        targetField: 'formulaCrossScore',
        expression: `formulaInputA + [company:${companyId}:employees]`,
      }),
      targetRecordId: 'o1',
    });

    expect(outcome.value).toEqual({ kind: 'number', value: 105 });
    expect(client.get('opportunity', 'o1')!.formulaCrossScore).toBe(105);
  });
});

describe('recomputeForRecord string comparisons (SELECT/TEXT/cross-record)', () => {
  let client: FakeClient;

  beforeEach(() => {
    client = new FakeClient();
  });

  it('computes the then-branch when a SELECT field equals the string literal', async () => {
    client.setFieldKinds('opportunity', {
      stage: 'SELECT',
      branchA: 'NUMBER',
      branchB: 'NUMBER',
    });
    client.seed('opportunity', [
      { id: 'o1', stage: 'QUALIFIED', branchA: 1, branchB: 2, formulaScore: null },
    ]);

    const outcome = await recomputeForRecord({
      client,
      formula: formula({ expression: 'IF(stage = "QUALIFIED", branchA, branchB)' }),
      targetRecordId: 'o1',
    });

    expect(outcome.value).toEqual({ kind: 'number', value: 1 });
    expect(client.get('opportunity', 'o1')!.formulaScore).toBe(1);
  });

  it('computes the else-branch when a SELECT field differs from the literal', async () => {
    client.setFieldKinds('opportunity', {
      stage: 'SELECT',
      branchA: 'NUMBER',
      branchB: 'NUMBER',
    });
    client.seed('opportunity', [
      { id: 'o1', stage: 'NEW', branchA: 1, branchB: 2, formulaScore: null },
    ]);

    const outcome = await recomputeForRecord({
      client,
      formula: formula({ expression: 'IF(stage = "QUALIFIED", branchA, branchB)' }),
      targetRecordId: 'o1',
    });

    expect(outcome.value).toEqual({ kind: 'number', value: 2 });
  });

  it('null-propagates (no write) when the compared SELECT field is null', async () => {
    client.setFieldKinds('opportunity', {
      stage: 'SELECT',
      branchA: 'NUMBER',
      branchB: 'NUMBER',
    });
    client.seed('opportunity', [
      { id: 'o1', stage: null, branchA: 1, branchB: 2, formulaScore: null },
    ]);
    const before = client.mutations;

    const outcome = await recomputeForRecord({
      client,
      formula: formula({ expression: 'IF(stage = "QUALIFIED", branchA, branchB)' }),
      targetRecordId: 'o1',
    });

    // null stage -> null string operand -> null IF -> null result. Stored value
    // is already null, so no write (no-op suppression path).
    expect(outcome.value).toEqual({ kind: 'number', value: null });
    expect(outcome.changed).toBe(false);
    expect(client.mutations).toBe(before);
  });

  it('compares against a TEXT field', async () => {
    client.setFieldKinds('opportunity', {
      tier: 'TEXT',
      branchA: 'NUMBER',
      branchB: 'NUMBER',
    });
    client.seed('opportunity', [
      { id: 'o1', tier: 'gold', branchA: 10, branchB: 20, formulaScore: null },
    ]);

    const outcome = await recomputeForRecord({
      client,
      formula: formula({ expression: 'IF(tier = "gold", branchA, branchB)' }),
      targetRecordId: 'o1',
    });

    expect(outcome.value).toEqual({ kind: 'number', value: 10 });
  });

  it('reports NON_NUMERIC_VALUE (no write) when a text value reaches a numeric target', async () => {
    // Text now survives evaluation, so the coercion that used to fail at resolve
    // time fails at the write boundary instead — same reported error, still an
    // outcome rather than a thrown exception, and still no write.
    client.setFieldKinds('opportunity', { tier: 'TEXT' });
    client.seed('opportunity', [{ id: 'o1', tier: 'gold', formulaScore: null }]);
    const before = client.mutations;

    const outcome = await recomputeForRecord({
      client,
      formula: formula({ expression: 'tier' }),
      targetRecordId: 'o1',
    });

    expect(outcome.error).toMatch(/NON_NUMERIC_VALUE/);
    expect(outcome.changed).toBe(false);
    expect(client.mutations).toBe(before);
  });

  it('still writes a numeric-shaped text value to a numeric target', async () => {
    client.setFieldKinds('opportunity', { tier: 'TEXT' });
    client.seed('opportunity', [{ id: 'o1', tier: '042', formulaScore: null }]);

    const outcome = await recomputeForRecord({
      client,
      formula: formula({ expression: 'tier' }),
      targetRecordId: 'o1',
    });

    expect(outcome.value).toEqual({ kind: 'number', value: 42 });
    expect(client.get('opportunity', 'o1')!.formulaScore).toBe(42);
  });

  it('resolves a cross-record string comparison', async () => {
    const companyId = '20202020-1c25-4d02-bf25-6aeccf7ea419';
    client.setFieldKinds('opportunity', { branchA: 'NUMBER', branchB: 'NUMBER' });
    client.setFieldKinds('company', { name: 'TEXT' });
    client.seed('opportunity', [
      { id: 'o1', branchA: 10, branchB: 20, formulaScore: null },
    ]);
    client.seed('company', [{ id: companyId, name: 'Acme' }]);

    const outcome = await recomputeForRecord({
      client,
      formula: formula({
        expression: `IF([company:${companyId}:name] = "Acme", branchA, branchB)`,
      }),
      targetRecordId: 'o1',
    });

    expect(outcome.value).toEqual({ kind: 'number', value: 10 });
    expect(client.get('opportunity', 'o1')!.formulaScore).toBe(10);
  });
});

describe('recomputeForRecord with TODAY() (ADR 0012)', () => {
  let client: FakeClient;

  beforeEach(() => {
    client = new FakeClient();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('evaluates TODAY() against the current system date, read once per recompute', async () => {
    vi.setSystemTime(new Date('2026-07-04T12:00:00.000Z'));
    client.seed('opportunity', [
      { id: 'o1', formulaInputA: 100, formulaScore: null },
    ]);

    const outcome = await recomputeForRecord({
      client,
      formula: formula({ expression: 'IF(formulaInputA > TODAY(), 1, 0)' }),
      targetRecordId: 'o1',
    });

    // The epoch-day for 2026-07-04 comfortably exceeds 100, so the condition
    // (formulaInputA > TODAY()) is false regardless of the exact serial value —
    // this asserts TODAY() actually reads a real, large epoch-day, not 0/NaN.
    expect(outcome.value).toEqual({ kind: 'number', value: 0 });
    expect(outcome.error).toBeNull();
  });

  it('re-evaluates TODAY() against a later system clock on the next recompute', async () => {
    // A threshold set to "epoch-day of 2026-07-05" — false the day before, true
    // the day after — demonstrates the sweep's convergence story (ADR 0012):
    // no dependency changed, only wall-clock time did.
    const epochDayOf = (iso: string) => Date.parse(iso) / 86_400_000;
    const threshold = epochDayOf('2026-07-05T00:00:00.000Z');

    client.seed('opportunity', [
      { id: 'o1', formulaInputA: threshold, formulaScore: null },
    ]);

    vi.setSystemTime(new Date('2026-07-04T12:00:00.000Z'));
    const before = await recomputeForRecord({
      client,
      formula: formula({ expression: 'IF(TODAY() >= formulaInputA, 1, 0)' }),
      targetRecordId: 'o1',
    });
    expect(before.value).toEqual({ kind: 'number', value: 0 });

    vi.setSystemTime(new Date('2026-07-05T12:00:00.000Z'));
    const after = await recomputeForRecord({
      client,
      formula: formula({ expression: 'IF(TODAY() >= formulaInputA, 1, 0)' }),
      targetRecordId: 'o1',
    });
    expect(after.value).toEqual({ kind: 'number', value: 1 });
    expect(after.changed).toBe(true);
  });
});

describe('recordEvaluationHeartbeat TODAY staleness carve-out (ADR 0015)', () => {
  let client: FakeClient;

  beforeEach(() => {
    client = new FakeClient();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-04T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes lastEvaluatedAt alone on a no-op outcome when the flag is set and the stored heartbeat is >1h stale', async () => {
    const stale = formula({
      lastValue: 25,
      lastError: '',
      lastEvaluatedAt: '2026-07-04T10:00:00.000Z', // 2h old
    });
    const mutationSpy = vi.spyOn(client, 'mutation');

    await recordEvaluationHeartbeat(
      client,
      stale,
      { value: { kind: 'number', value: 25 }, error: null },
      true,
    );

    expect(mutationSpy).toHaveBeenCalledTimes(1);
    const [[selection]] = mutationSpy.mock.calls;
    expect(selection.updateFormulaDefinition.__args.data).toEqual({
      lastEvaluatedAt: '2026-07-04T12:00:00.000Z',
    });
  });

  it('writes nothing on a no-op outcome when the flag is set but the stored heartbeat is fresh (<1h)', async () => {
    const fresh = formula({
      lastValue: 25,
      lastError: '',
      lastEvaluatedAt: '2026-07-04T11:50:00.000Z', // 10min old
    });
    const mutationSpy = vi.spyOn(client, 'mutation');

    await recordEvaluationHeartbeat(
      client,
      fresh,
      { value: { kind: 'number', value: 25 }, error: null },
      true,
    );

    expect(mutationSpy).not.toHaveBeenCalled();
  });

  it('treats an unparseable lastEvaluatedAt as stale (never silently stalls self-heal)', async () => {
    // Date.parse('garbage') is NaN; a naive `now - NaN > threshold` comparison
    // is always false, which would read corrupt data as "fresh" forever.
    const corrupt = formula({
      lastValue: 25,
      lastError: '',
      lastEvaluatedAt: 'garbage-not-a-date',
    });
    const mutationSpy = vi.spyOn(client, 'mutation');

    await recordEvaluationHeartbeat(
      client,
      corrupt,
      { value: { kind: 'number', value: 25 }, error: null },
      true,
    );

    expect(mutationSpy).toHaveBeenCalledTimes(1);
    const [[selection]] = mutationSpy.mock.calls;
    expect(selection.updateFormulaDefinition.__args.data).toEqual({
      lastEvaluatedAt: '2026-07-04T12:00:00.000Z',
    });
  });

  it('preserves M3 write-avoidance: writes nothing on a no-op outcome when the flag is false, even if stale', async () => {
    const stale = formula({
      lastValue: 25,
      lastError: '',
      lastEvaluatedAt: '2026-07-04T10:00:00.000Z', // 2h old
    });
    const mutationSpy = vi.spyOn(client, 'mutation');

    await recordEvaluationHeartbeat(
      client,
      stale,
      { value: { kind: 'number', value: 25 }, error: null },
      false,
    );

    expect(mutationSpy).not.toHaveBeenCalled();
  });

  it('writes the full bookkeeping payload on a changed-value outcome regardless of the flag', async () => {
    const changed = formula({
      lastValue: 10,
      lastError: '',
      lastEvaluatedAt: '2026-07-04T10:00:00.000Z', // 2h old, irrelevant here
    });
    const mutationSpy = vi.spyOn(client, 'mutation');

    await recordEvaluationHeartbeat(
      client,
      changed,
      { value: { kind: 'number', value: 25 }, error: null },
      false,
    );

    expect(mutationSpy).toHaveBeenCalledTimes(1);
    const [[selection]] = mutationSpy.mock.calls;
    expect(selection.updateFormulaDefinition.__args.data).toEqual({
      lastValue: 25,
      lastError: '',
      lastEvaluatedAt: '2026-07-04T12:00:00.000Z',
    });
  });

  // The carve-out is lane-agnostic: a TEXT-target formula reading TODAY() (e.g.
  // IF(TODAY() > dueDate, "Overdue", "OK")) goes long stretches without a value
  // change, so without this its lastEvaluatedAt would read stale forever.
  it('writes lastEvaluatedAt alone on a no-op TEXT outcome when the flag is set and the stored heartbeat is stale', async () => {
    const stale = formula({
      targetFieldType: 'TEXT',
      lastValueText: '"OK"',
      lastError: '',
      lastEvaluatedAt: '2026-07-04T10:00:00.000Z', // 2h old
    });
    const mutationSpy = vi.spyOn(client, 'mutation');

    await recordEvaluationHeartbeat(
      client,
      stale,
      { value: { kind: 'text', value: 'OK' }, error: null },
      true,
    );

    expect(mutationSpy).toHaveBeenCalledTimes(1);
    const [[selection]] = mutationSpy.mock.calls;
    expect(selection.updateFormulaDefinition.__args.data).toEqual({
      lastEvaluatedAt: '2026-07-04T12:00:00.000Z',
    });
  });

  it('writes nothing on a no-op TEXT outcome when the flag is set but the stored heartbeat is fresh', async () => {
    const fresh = formula({
      targetFieldType: 'TEXT',
      lastValueText: '"OK"',
      lastError: '',
      lastEvaluatedAt: '2026-07-04T11:30:00.000Z', // 30min old
    });
    const mutationSpy = vi.spyOn(client, 'mutation');

    await recordEvaluationHeartbeat(
      client,
      fresh,
      { value: { kind: 'text', value: 'OK' }, error: null },
      true,
    );

    expect(mutationSpy).not.toHaveBeenCalled();
  });

  it('preserves M3 write-avoidance on the text lane: no write on a no-op outcome when the flag is false', async () => {
    const stale = formula({
      targetFieldType: 'TEXT',
      lastValueText: '"OK"',
      lastError: '',
      lastEvaluatedAt: '2026-07-04T10:00:00.000Z', // 2h old
    });
    const mutationSpy = vi.spyOn(client, 'mutation');

    await recordEvaluationHeartbeat(
      client,
      stale,
      { value: { kind: 'text', value: 'OK' }, error: null },
      false,
    );

    expect(mutationSpy).not.toHaveBeenCalled();
  });

  // Mirrors are bare refs, so the flag is never true for a raw outcome — the
  // guard is uniform, and the zero-write mirror heartbeat is unaffected.
  it('keeps the raw (mirror) lane write-avoidant on a no-op outcome', async () => {
    const stale = formula({
      targetFieldType: 'SELECT',
      lastValueText: '"ACTIVE"',
      lastError: '',
      lastEvaluatedAt: '2026-07-04T10:00:00.000Z', // 2h old
    });
    const mutationSpy = vi.spyOn(client, 'mutation');

    await recordEvaluationHeartbeat(
      client,
      stale,
      { value: { kind: 'raw', value: 'ACTIVE' }, error: null },
      false,
    );

    expect(mutationSpy).not.toHaveBeenCalled();
  });
});

// Guards recompute.ts's dependencySelectionOverrides (the CURRENCY-activation
// fix): a composite dependency MUST be fetched with a sub-selection, never as a
// scalar `true`. The hardened FakeClient returns null for a scalar selection of
// a CURRENCY field (mirroring the server's silent null), so reverting the
// override would make Test A compute null -> red.
describe('recomputeForRecord composite dependency selection', () => {
  let client: FakeClient;

  beforeEach(() => {
    client = new FakeClient();
    client.setFieldKinds('opportunity', { amount: 'CURRENCY' });
  });

  it('fetches a CURRENCY dependency via sub-selection and computes the value', async () => {
    client.seed('opportunity', [
      {
        id: 'o1',
        amount: { amountMicros: 5_000_000, currencyCode: 'JPY' },
        formulaScore: null,
      },
    ]);

    const outcome = await recomputeForRecord({
      client,
      formula: formula({ expression: 'amount.amountMicros * 2' }),
      targetRecordId: 'o1',
    });

    expect(outcome.value).toEqual({ kind: 'number', value: 10_000_000 });
    expect(client.get('opportunity', 'o1')!.formulaScore).toBe(10_000_000);
  });

  it('selects the CURRENCY dependency as a composite sub-selection, not a scalar', async () => {
    client.seed('opportunity', [
      {
        id: 'o1',
        amount: { amountMicros: 5_000_000, currencyCode: 'JPY' },
        formulaScore: null,
      },
    ]);

    await recomputeForRecord({
      client,
      formula: formula({ expression: 'amount.amountMicros * 2' }),
      targetRecordId: 'o1',
    });

    const recordQuery = client.querySelections.find(
      (selection) => selection.opportunity,
    );
    expect(recordQuery.opportunity.amount).toEqual({
      amountMicros: true,
      currencyCode: true,
    });
  });
});

// Lane switch (Task 7): a TEXT target is no longer a mirror. A deployed TEXT
// mirror's expression is a BARE REF, so it becomes a one-term engine formula and
// must keep writing exactly what the mirror lane wrote. These tests pin the
// WRITE PAYLOADS (client.writes), which is the observable the deployed data
// depends on, not which internal function produced them.
describe('TEXT target on the engine lane — deployed-mirror write parity', () => {
  let client: FakeClient;

  const textMirror = (
    overrides: Partial<FormulaDefinitionRecord> = {},
  ): FormulaDefinitionRecord => ({
    id: 'ft',
    targetObject: 'company',
    targetField: 'mirror',
    targetFieldType: 'TEXT',
    expression: 'source',
    enabled: true,
    ...overrides,
  });

  beforeEach(() => {
    client = new FakeClient();
    client.setFieldKinds('company', { source: 'TEXT', mirror: 'TEXT' });
  });

  it('writes the source string verbatim and converges on the second run', async () => {
    client.seed('company', [{ id: 'c1', source: 'hello world', mirror: null }]);

    const first = await recomputeForRecord({
      client,
      formula: textMirror(),
      targetRecordId: 'c1',
    });

    expect(first.changed).toBe(true);
    expect(first.value).toEqual({ kind: 'text', value: 'hello world' });
    expect(client.writes).toEqual(['company:c1:mirror="hello world"']);

    const second = await recomputeForRecord({
      client,
      formula: textMirror(),
      targetRecordId: 'c1',
    });

    expect(second.changed).toBe(false);
    expect(client.writes).toHaveLength(1);
  });

  // B5: numeric-shaped strings stay lazy, so a zip code keeps its leading zero
  // exactly as the mirror lane's raw passthrough did.
  it('keeps a numeric-shaped string verbatim (leading zeros preserved)', async () => {
    client.seed('company', [{ id: 'c1', source: '042', mirror: null }]);

    await recomputeForRecord({
      client,
      formula: textMirror(),
      targetRecordId: 'c1',
    });

    expect(client.writes).toEqual(['company:c1:mirror="042"']);
  });

  it('writes an empty string as an empty string, not a clear', async () => {
    client.seed('company', [{ id: 'c1', source: '', mirror: 'OLD' }]);

    await recomputeForRecord({
      client,
      formula: textMirror(),
      targetRecordId: 'c1',
    });

    expect(client.writes).toEqual(['company:c1:mirror=""']);
  });

  it('clears the target once when the source is null, then suppresses', async () => {
    client.seed('company', [{ id: 'c1', source: null, mirror: 'OLD' }]);

    const first = await recomputeForRecord({
      client,
      formula: textMirror(),
      targetRecordId: 'c1',
    });
    expect(first.changed).toBe(true);
    expect(client.writes).toEqual(['company:c1:mirror=null']);

    const second = await recomputeForRecord({
      client,
      formula: textMirror(),
      targetRecordId: 'c1',
    });
    expect(second.changed).toBe(false);
    expect(client.writes).toHaveLength(1);
  });

  it('suppresses the write entirely when source and target are both empty', async () => {
    client.seed('company', [{ id: 'c1', source: null, mirror: null }]);

    const outcome = await recomputeForRecord({
      client,
      formula: textMirror(),
      targetRecordId: 'c1',
    });

    expect(outcome.changed).toBe(false);
    expect(client.writes).toHaveLength(0);
    expect(client.mutations).toBe(0);
  });

  it('copies a cross-referenced TEXT source verbatim', async () => {
    const sourceId = '440efe8c-f140-4fbc-99e6-9267344451b1';
    client.setFieldKinds('opportunity', { mirror: 'TEXT' });
    client.setFieldKinds('company', { name: 'TEXT' });
    client.seed('company', [{ id: sourceId, name: 'Acme Inc' }]);
    client.seed('opportunity', [{ id: 'o1', mirror: null }]);

    const outcome = await recomputeForRecord({
      client,
      formula: textMirror({
        targetObject: 'opportunity',
        expression: `[company:${sourceId}:name]`,
      }),
      targetRecordId: 'o1',
    });

    expect(outcome.value).toEqual({ kind: 'text', value: 'Acme Inc' });
    expect(client.writes).toEqual(['opportunity:o1:mirror="Acme Inc"']);
  });

  it('writes null with no error when the cross-referenced record is missing', async () => {
    const sourceId = '440efe8c-f140-4fbc-99e6-9267344451b1';
    client.setFieldKinds('opportunity', { mirror: 'TEXT' });
    client.seed('opportunity', [{ id: 'o1', mirror: 'STALE' }]);

    const outcome = await recomputeForRecord({
      client,
      formula: textMirror({
        targetObject: 'opportunity',
        expression: `[company:${sourceId}:name]`,
      }),
      targetRecordId: 'o1',
    });

    expect(outcome.error).toBeNull();
    expect(outcome.value).toEqual({ kind: 'text', value: null });
    expect(client.writes).toEqual(['opportunity:o1:mirror=null']);
  });

  // Accepted deltas (ADR 0026): dirty non-string data in a TEXT column, and the
  // B2 date-shaped-content edge. Both used to copy raw; both now render through
  // the engine's canonical text rendering.
  it('renders a dirty non-string scalar canonically (accepted delta)', async () => {
    client.seed('company', [{ id: 'c1', source: 42, mirror: null }]);
    client.seed('company', [{ id: 'c2', source: true, mirror: null }]);

    await recomputeForRecord({
      client,
      formula: textMirror(),
      targetRecordId: 'c1',
    });
    await recomputeForRecord({
      client,
      formula: textMirror(),
      targetRecordId: 'c2',
    });

    expect(client.writes).toEqual([
      'company:c1:mirror="42"',
      'company:c2:mirror="1"',
    ]);
  });

  it('copies date-SHAPED content that is not a real date verbatim', async () => {
    // Part numbers, reference codes and hyphenated phone numbers match the DATE
    // shape. Parsing them threw, and the throw became an error outcome with
    // write: null — every pass, forever, so a deployed mirror over such a column
    // froze at its last pre-upgrade value. Validity-gating restores convergence.
    client.seed('company', [{ id: 'c1', source: '8801-25-03', mirror: null }]);
    client.seed('company', [{ id: 'c2', source: '1234-56-78', mirror: null }]);

    const first = await recomputeForRecord({
      client,
      formula: textMirror(),
      targetRecordId: 'c1',
    });
    const second = await recomputeForRecord({
      client,
      formula: textMirror(),
      targetRecordId: 'c2',
    });

    expect(first.error).toBeNull();
    expect(second.error).toBeNull();
    expect(client.writes).toEqual([
      'company:c1:mirror="8801-25-03"',
      'company:c2:mirror="1234-56-78"',
    ]);
  });

  it('copies date-shaped TEXT content verbatim (B2 reversed)', async () => {
    // REVERSAL (B2): this wrote the epoch-day serial ("20638"), because the
    // resolver sniffed the string's SHAPE. `source` is a TEXT field, so with
    // its kind supplied the resolver copies the bytes — a TEXT mirror over a
    // column of ISO-looking codes keeps them intact.
    client.seed('company', [{ id: 'c1', source: '2026-07-04', mirror: null }]);

    await recomputeForRecord({
      client,
      formula: textMirror(),
      targetRecordId: 'c1',
      fieldKindsByObject: new Map([
        ['company', new Map([['source', 'TEXT'], ['mirror', 'TEXT']])],
      ]),
    });

    expect(client.writes).toEqual(['company:c1:mirror="2026-07-04"']);
  });
});

// B6 RETIRED (strict typing). B6 was the accepted delta where a date-shaped
// string in a TEXT column silently became a serial and flipped an `=`
// comparison. Two changes killed it at the root:
//   - the save gate (Task 3, validation-core) REJECTS `dateField = "literal"`
//     before such a definition can exist, so the delta has no live shape; and
//   - the resolver reads by KIND (this task), so TEXT content is text and a
//     comparison against a text literal means what it says.
// What is left to pin at runtime is the positive case: a real DATE column
// compared to a real DATE literal resolves TRUE.
describe('kind-directed resolution — DATE column vs DATE literal (B6 retired)', () => {
  it('compares a stored date against DATE("...") as TRUE when they match', async () => {
    const client = new FakeClient();
    client.setFieldKinds('company', { signedOn: 'DATE', tier: 'TEXT' });
    client.seed('company', [{ id: 'c1', signedOn: '2026-01-15', tier: null }]);

    const outcome = await recomputeForRecord({
      client,
      formula: {
        id: 'fb6',
        targetObject: 'company',
        targetField: 'tier',
        targetFieldType: 'TEXT',
        expression: 'IF(signedOn = DATE("2026-01-15"), "match", "other")',
        enabled: true,
      },
      targetRecordId: 'c1',
      fieldKindsByObject: new Map([
        ['company', new Map([['signedOn', 'DATE'], ['tier', 'TEXT']])],
      ]),
    });

    expect(outcome.error).toBeNull();
    expect(client.writes).toEqual(['company:c1:tier="match"']);
  });

  it('resolves the SAME stored bytes as text when the column is TEXT', async () => {
    // Same bytes, different column kind, different meaning — this is the whole
    // point of retiring shape-sniffing.
    const client = new FakeClient();
    client.setFieldKinds('company', { signedOn: 'TEXT', tier: 'TEXT' });
    client.seed('company', [{ id: 'c1', signedOn: '2026-01-15', tier: null }]);

    const outcome = await recomputeForRecord({
      client,
      formula: {
        id: 'fb6b',
        targetObject: 'company',
        targetField: 'tier',
        targetFieldType: 'TEXT',
        expression: 'signedOn',
        enabled: true,
      },
      targetRecordId: 'c1',
      fieldKindsByObject: new Map([
        ['company', new Map([['signedOn', 'TEXT'], ['tier', 'TEXT']])],
      ]),
    });

    expect(outcome.error).toBeNull();
    expect(client.writes).toEqual(['company:c1:tier="2026-01-15"']);
  });
});

// F1 guard (ADR 0022's catastrophic mode): a converged definition must perform
// ZERO writes on every subsequent pass. The loop closes only if the value the
// write boundary serializes parses back to the BIT-IDENTICAL float — valuesEqual
// compares with `===`, so 20468.5 !== 20468.499999 would rewrite forever.
describe('F1 convergence guard — date targets perform zero writes when unchanged', () => {
  it('DATE-target formula whose value is unchanged performs zero writes across two passes', async () => {
    const client = new FakeClient();
    client.setFieldKinds('opportunity', { closeDate: 'DATE', dueDate: 'DATE' });
    client.seed('opportunity', [
      { id: 'o1', closeDate: '2026-01-15', dueDate: '2026-01-15' },
    ]);
    const kinds = new Map([
      [
        'opportunity',
        new Map([['closeDate', 'DATE'], ['dueDate', 'DATE']]),
      ],
    ]);
    const dateFormula: FormulaDefinitionRecord = {
      id: 'fd1',
      targetObject: 'opportunity',
      targetField: 'dueDate',
      targetFieldType: 'DATE',
      expression: 'closeDate',
      enabled: true,
    };

    for (const pass of [1, 2]) {
      const plan = await planRecomputeForRecord({
        client,
        formula: dateFormula,
        targetRecordId: 'o1',
        fieldKindsByObject: kinds,
      });
      expect(plan.outcome.error, `pass ${pass}`).toBeNull();
      expect(plan.write, `pass ${pass}`).toBeNull();
    }
    expect(client.writes).toEqual([]);
  });

  it('DATE_TIME-target formula whose value is unchanged performs zero writes across two passes', async () => {
    // Round trip is serial -> ISO string -> store -> re-read -> parse -> serial;
    // the re-parsed float must be bit-identical. Fractional-day precision is the
    // likeliest place for the rewrite loop to open.
    const client = new FakeClient();
    client.setFieldKinds('opportunity', {
      syncedAt: 'DATE_TIME',
      mirroredAt: 'DATE_TIME',
    });
    client.seed('opportunity', [
      {
        id: 'o1',
        syncedAt: '2026-01-15T12:00:00.000Z',
        mirroredAt: '2026-01-15T12:00:00.000Z',
      },
    ]);
    const kinds = new Map([
      [
        'opportunity',
        new Map([
          ['syncedAt', 'DATE_TIME'],
          ['mirroredAt', 'DATE_TIME'],
        ]),
      ],
    ]);
    const dateTimeFormula: FormulaDefinitionRecord = {
      id: 'fd2',
      targetObject: 'opportunity',
      targetField: 'mirroredAt',
      targetFieldType: 'DATE_TIME',
      expression: 'syncedAt',
      enabled: true,
    };

    for (const pass of [1, 2]) {
      const plan = await planRecomputeForRecord({
        client,
        formula: dateTimeFormula,
        targetRecordId: 'o1',
        fieldKindsByObject: kinds,
      });
      expect(plan.outcome.error, `pass ${pass}`).toBeNull();
      expect(plan.write, `pass ${pass}`).toBeNull();
    }
    expect(client.writes).toEqual([]);
  });

  it('converges after ONE write when the date target starts out stale', async () => {
    // The negative control for the two pins above: a real change writes once,
    // and the pass immediately after it is silent.
    const client = new FakeClient();
    client.setFieldKinds('opportunity', { closeDate: 'DATE', dueDate: 'DATE' });
    client.seed('opportunity', [
      { id: 'o1', closeDate: '2026-01-15', dueDate: null },
    ]);
    const kinds = new Map([
      ['opportunity', new Map([['closeDate', 'DATE'], ['dueDate', 'DATE']])],
    ]);
    const dateFormula: FormulaDefinitionRecord = {
      id: 'fd3',
      targetObject: 'opportunity',
      targetField: 'dueDate',
      targetFieldType: 'DATE',
      expression: 'closeDate + 30',
      enabled: true,
    };

    const first = await recomputeForRecord({
      client,
      formula: dateFormula,
      targetRecordId: 'o1',
      fieldKindsByObject: kinds,
    });
    expect(first.error).toBeNull();
    expect(client.writes).toEqual(['opportunity:o1:dueDate="2026-02-14"']);

    const second = await recomputeForRecord({
      client,
      formula: dateFormula,
      targetRecordId: 'o1',
      fieldKindsByObject: kinds,
    });
    expect(second.error).toBeNull();
    expect(second.changed).toBe(false);
    expect(client.writes).toHaveLength(1);
  });
});

describe('TEXT target on the engine lane — concatenation end to end', () => {
  it('writes the concatenated string and records a text heartbeat', async () => {
    const client = new FakeClient();
    client.setFieldKinds('company', {
      invoiceNumber: 'TEXT',
      invoiceCode: 'TEXT',
    });
    client.seed('company', [
      { id: 'c1', invoiceNumber: '007', invoiceCode: null },
    ]);
    const concatFormula: FormulaDefinitionRecord = {
      id: 'fc',
      targetObject: 'company',
      targetField: 'invoiceCode',
      targetFieldType: 'TEXT',
      expression: '"ACME-" & invoiceNumber',
      enabled: true,
    };
    client.seed('formulaDefinition', [
      concatFormula as Record<string, unknown> & { id: string },
    ]);

    const outcome = await recomputeForRecord({
      client,
      formula: concatFormula,
      targetRecordId: 'c1',
    });

    expect(outcome.value).toEqual({ kind: 'text', value: 'ACME-007' });
    expect(client.writes).toEqual(['company:c1:invoiceCode="ACME-007"']);

    await recomputeAllRecords(client, concatFormula);

    // The heartbeat rides the outcome's 'text' tag into lastValueText; the
    // NUMBER-typed lastValue column stays untouched.
    expect(client.get('formulaDefinition', 'fc')!.lastValueText).toBe(
      JSON.stringify('ACME-007'),
    );
    expect(client.get('formulaDefinition', 'fc')!.lastValue ?? null).toBeNull();
  });
});

// ADR 0023: the definition-page sweep passes shouldContinue so an unmount can
// stop the sweep at the next record boundary instead of running it to
// completion orphaned. Guarded at the top of both the outer page loop and the
// inner per-edge loop (see recomputeAllRecords).
describe('recomputeAllRecords shouldContinue (ADR 0023)', () => {
  it('stops processing records once shouldContinue returns false', async () => {
    const client = new FakeClient();
    client.seed('opportunity', [
      { id: 'o1', formulaInputA: 1, formulaInputB: 1, formulaScore: null },
      { id: 'o2', formulaInputA: 2, formulaInputB: 2, formulaScore: null },
      { id: 'o3', formulaInputA: 3, formulaInputB: 3, formulaScore: null },
    ]);

    // Lets the outer loop's initial check pass, and the first record's inner
    // check pass, then stops — so exactly one record gets processed.
    let calls = 0;
    const shouldContinue = () => {
      calls += 1;
      return calls <= 2;
    };

    const outcomes = await recomputeAllRecords(client, formula(), {
      shouldContinue,
    });

    // Fewer writes than the seeded record count: the sweep stopped early
    // rather than converging every record.
    expect(client.writes).toHaveLength(1);
    expect(outcomes).toHaveLength(1);
  });
});

// Task 5: parse and metadata work are properties of the DEFINITION, so they must
// be paid once per pass. These are behavioral call-count pins, not timings.
describe('recomputeAllRecords hoisted compilation (once per pass)', () => {
  const seedEngineLane = (client: FakeClient, count: number): void => {
    client.setFieldKinds('opportunity', {
      formulaInputA: 'NUMBER',
      formulaInputB: 'NUMBER',
      formulaScore: 'NUMBER',
    });
    client.seed(
      'opportunity',
      Array.from({ length: count }, (_unused, index) => ({
        id: `o${String(index + 1).padStart(3, '0')}`,
        formulaInputA: index + 1,
        formulaInputB: 1,
        formulaScore: null,
      })),
    );
  };

  const fieldKindsCallCount = (client: FakeClient): { count: () => number } => {
    const real = client.fieldKinds;
    let calls = 0;
    client.fieldKinds = async (object: string): Promise<Map<string, string>> => {
      calls += 1;
      return real(object);
    };
    return { count: () => calls };
  };

  beforeEach(() => {
    vi.mocked(parse).mockClear();
  });

  it('compiles once per pass, not per record', async () => {
    const client = new FakeClient();
    seedEngineLane(client, 3);

    await recomputeAllRecords(
      client,
      formula({ targetFieldType: 'NUMBER' }),
    );

    expect(vi.mocked(parse)).toHaveBeenCalledTimes(1);
  });

  it('compiles once per pass on the mirror lane too', async () => {
    const client = new FakeClient();
    client.setFieldKinds('company', { source: 'SELECT', mirror: 'SELECT' });
    client.seed('company', [
      { id: 'c1', source: 'ACTIVE', mirror: null },
      { id: 'c2', source: 'CHURNED', mirror: null },
      { id: 'c3', source: 'ACTIVE', mirror: null },
    ]);

    await recomputeAllRecords(client, {
      id: 'fm',
      targetObject: 'company',
      targetField: 'mirror',
      targetFieldType: 'SELECT',
      expression: 'source',
      enabled: true,
    });

    expect(vi.mocked(parse)).toHaveBeenCalledTimes(1);
    expect(client.get('company', 'c2')!.mirror).toBe('CHURNED');
  });

  it('resolves field kinds a constant number of times regardless of record count', async () => {
    const smallClient = new FakeClient();
    seedEngineLane(smallClient, 3);
    const smallCalls = fieldKindsCallCount(smallClient);
    await recomputeAllRecords(smallClient, formula({ targetFieldType: 'NUMBER' }));

    const largeClient = new FakeClient();
    seedEngineLane(largeClient, 12);
    const largeCalls = fieldKindsCallCount(largeClient);
    await recomputeAllRecords(largeClient, formula({ targetFieldType: 'NUMBER' }));

    expect(largeCalls.count()).toBe(smallCalls.count());
    // Host object only: one resolution for the resolver's kind map, one for the
    // scan selection (which keeps its OWN failure semantics — see scan-prefetch).
    expect(smallCalls.count()).toBe(2);
  });

  it('resolves no kind map at all on the mirror lane', async () => {
    // The mirror lane never consults fieldKindsByObject: computeMirrorValueForRecord
    // resolves the source field's kind itself. Resolving the resolver's map here
    // would be rent paid for nothing.
    const client = new FakeClient();
    client.setFieldKinds('company', { source: 'SELECT', mirror: 'SELECT' });
    client.seed('company', [{ id: 'c1', source: 'ACTIVE', mirror: null }]);
    const calls = fieldKindsCallCount(client);

    await recomputeAllRecords(client, {
      id: 'fm',
      targetObject: 'company',
      targetField: 'mirror',
      targetFieldType: 'SELECT',
      expression: 'source',
      enabled: true,
    });

    // Scan selection (source kind) + the one per-record mirror source resolution.
    expect(calls.count()).toBe(2);
  });

  it('planRecomputeForRecord uses the provided compiled program', async () => {
    // Sentinel: the definition says "2", the precompiled program says "1". A
    // recompile inside planRecomputeForRecord would yield 2.
    const client = new FakeClient();
    client.setFieldKinds('opportunity', { formulaScore: 'NUMBER' });
    client.seed('opportunity', [{ id: 'o1', formulaScore: null }]);

    const plan = await planRecomputeForRecord({
      client,
      formula: formula({ expression: '2', targetFieldType: 'NUMBER' }),
      targetRecordId: 'o1',
      compiled: compileFormula('1'),
    });

    expect(plan.outcome.error).toBeNull();
    expect(plan.outcome.value).toEqual({ kind: 'number', value: 1 });
  });
});
