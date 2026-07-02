import { beforeEach, describe, expect, it } from 'vitest';

import { recomputeForRecord } from 'src/logic-functions/lib/recompute';
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
