import { beforeEach, describe, expect, it } from 'vitest';

import { handleRecordUpdate } from 'src/logic-functions/lib/handle-record-update';
import { recomputeForRecord } from 'src/logic-functions/lib/recompute';
import { type FormulaDefinitionRecord } from 'src/logic-functions/lib/types';
import { FakeClient } from 'src/logic-functions/lib/__tests__/fake-client';

// Formulas targeting a CURRENCY value field (created by the wizard). The
// numeric domain is micros end-to-end: reads take amountMicros, writes set an
// integer amountMicros and keep the record's currency code.

const currencyFormula = (
  overrides: Partial<FormulaDefinitionRecord> = {},
): FormulaDefinitionRecord => ({
  id: 'f1',
  targetObject: 'company',
  targetField: 'budget',
  targetFieldType: 'CURRENCY',
  expression: 'employees * 1000000',
  enabled: true,
  ...overrides,
});

describe('recomputeForRecord with a CURRENCY target field', () => {
  let client: FakeClient;

  beforeEach(() => {
    client = new FakeClient();
  });

  it('writes integer micros and preserves the currency code', async () => {
    client.seed('company', [
      {
        id: 'c1',
        employees: 10,
        budget: { amountMicros: null, currencyCode: 'EUR' },
      },
    ]);

    const outcome = await recomputeForRecord({
      client,
      formula: currencyFormula(),
      targetRecordId: 'c1',
    });

    expect(outcome.changed).toBe(true);
    expect(outcome.value).toBe(10_000_000);
    expect(client.get('company', 'c1')!.budget).toEqual({
      amountMicros: 10_000_000,
      currencyCode: 'EUR',
    });
  });

  it('suppresses the write when the stored micros already match', async () => {
    client.seed('company', [
      {
        id: 'c1',
        employees: 10,
        budget: { amountMicros: 10_000_000, currencyCode: 'EUR' },
      },
    ]);

    const outcome = await recomputeForRecord({
      client,
      formula: currencyFormula(),
      targetRecordId: 'c1',
    });

    expect(outcome.changed).toBe(false);
    expect(client.writes).toHaveLength(0);
  });

  it('converges on fractional results by rounding before comparing', async () => {
    // 10 / 3 -> 3.33…; stored micros are integers, so the effective value is 3.
    client.seed('company', [
      {
        id: 'c1',
        employees: 10,
        budget: { amountMicros: 3, currencyCode: 'USD' },
      },
    ]);

    const outcome = await recomputeForRecord({
      client,
      formula: currencyFormula({ expression: 'employees / 3' }),
      targetRecordId: 'c1',
    });

    expect(outcome.changed).toBe(false);
    expect(client.writes).toHaveLength(0);
  });

  it('clears the value with a null amount when the formula yields null', async () => {
    client.seed('company', [
      {
        id: 'c1',
        employees: null,
        budget: { amountMicros: 5, currencyCode: 'GBP' },
      },
    ]);

    const outcome = await recomputeForRecord({
      client,
      formula: currencyFormula({ expression: 'employees * 2' }),
      targetRecordId: 'c1',
    });

    expect(outcome.changed).toBe(true);
    expect(client.get('company', 'c1')!.budget).toEqual({
      amountMicros: null,
      currencyCode: 'GBP',
    });
  });
});

describe('formulas with a CURRENCY dependency (input) field', () => {
  let client: FakeClient;

  beforeEach(() => {
    client = new FakeClient();
    client.setFieldKinds('company', { budget: 'CURRENCY' });
  });

  it('sub-selects composite dependencies so activation recompute can fetch', async () => {
    // Regression: without field-kind-aware selection the record fetch selects
    // { budget } as a scalar — the server silently returns null (no error) —
    // and every record sat empty until an edit supplied a prefetched payload.
    client.seed('company', [
      {
        id: 'c1',
        budget: { amountMicros: 5_000_000_000, currencyCode: 'USD' },
        marginOut: null,
      },
    ]);

    const outcome = await recomputeForRecord({
      client,
      formula: currencyFormula({
        targetField: 'marginOut',
        targetFieldType: 'NUMBER',
        expression: 'budget / 1000000',
      }),
      targetRecordId: 'c1',
    });

    expect(outcome.changed).toBe(true);
    expect(outcome.value).toBe(5000);
    expect(client.get('company', 'c1')!.marginOut).toBe(5000);

    const recordQuery = client.querySelections.find(
      (selection) => selection.company,
    );
    expect(recordQuery.company.budget).toEqual({
      amountMicros: true,
      currencyCode: true,
    });
  });

  it('falls back to scalar selection when the field kind is unknown', async () => {
    client.seed('company', [{ id: 'c1', employees: 4, out: null }]);

    const outcome = await recomputeForRecord({
      client,
      formula: currencyFormula({
        targetField: 'out',
        targetFieldType: 'NUMBER',
        expression: 'employees * 2',
      }),
      targetRecordId: 'c1',
    });

    expect(outcome.value).toBe(8);
    const recordQuery = client.querySelections.find(
      (selection) => selection.company,
    );
    expect(recordQuery.company.employees).toBe(true);
  });
});

describe('manual override detection on a CURRENCY value field', () => {
  let client: FakeClient;

  beforeEach(() => {
    client = new FakeClient();
    client.seed('formulaDefinition', [
      currencyFormula() as Record<string, unknown> & { id: string },
    ]);
  });

  it('records a human edit (micros differ from the formula) as an override', async () => {
    client.seed('company', [
      {
        id: 'c1',
        employees: 10,
        budget: { amountMicros: 999, currencyCode: 'EUR' },
      },
    ]);

    await handleRecordUpdate({
      client,
      objectName: 'company',
      recordId: 'c1',
      after: {
        id: 'c1',
        employees: 10,
        budget: { amountMicros: 999, currencyCode: 'EUR' },
      },
      updatedFields: ['budget'],
      actorWorkspaceMemberId: 'member-1',
    });

    expect(client.get('formulaOverride', 'formulaOverride-0')).toMatchObject({
      targetObject: 'company',
      targetField: 'budget',
      recordId: 'c1',
      overrideValue: 999,
      active: true,
    });
  });

  it('ignores the app recompute write (micros match the formula)', async () => {
    client.seed('company', [
      {
        id: 'c1',
        employees: 10,
        budget: { amountMicros: 10_000_000, currencyCode: 'EUR' },
      },
    ]);

    await handleRecordUpdate({
      client,
      objectName: 'company',
      recordId: 'c1',
      after: {
        id: 'c1',
        employees: 10,
        budget: { amountMicros: 10_000_000, currencyCode: 'EUR' },
      },
      updatedFields: ['budget'],
      actorWorkspaceMemberId: 'member-1',
    });

    expect(client.get('formulaOverride', 'formulaOverride-0')).toBeUndefined();
  });
});
