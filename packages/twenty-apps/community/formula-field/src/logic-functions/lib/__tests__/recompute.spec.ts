import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { recordEvaluationHeartbeat } from 'src/logic-functions/lib/formula-repository';
import {
  recomputeAllRecords,
  recomputeForRecord,
} from 'src/logic-functions/lib/recompute';
import { type FormulaDefinitionRecord } from 'src/logic-functions/lib/types';
import { FakeClient } from 'src/logic-functions/lib/__tests__/fake-client';

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

    expect(outcome.value).toBe(25);
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

    expect(outcome.value).toBe(25);
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
    expect(outcome.value).toBe(11);
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

    expect(outcome.value).toBeNull();
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

    expect(outcome.value).toBe(105);
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

    expect(outcome.value).toBe(1);
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

    expect(outcome.value).toBe(2);
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
    expect(outcome.value).toBeNull();
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

    expect(outcome.value).toBe(10);
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

    expect(outcome.value).toBe(10);
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
    expect(outcome.value).toBe(0);
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
    expect(before.value).toBe(0);

    vi.setSystemTime(new Date('2026-07-05T12:00:00.000Z'));
    const after = await recomputeForRecord({
      client,
      formula: formula({ expression: 'IF(TODAY() >= formulaInputA, 1, 0)' }),
      targetRecordId: 'o1',
    });
    expect(after.value).toBe(1);
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
      { value: 25, error: null },
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
      { value: 25, error: null },
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
      { value: 25, error: null },
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
      { value: 25, error: null },
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
      { value: 25, error: null },
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

    expect(outcome.value).toBe(10_000_000);
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
