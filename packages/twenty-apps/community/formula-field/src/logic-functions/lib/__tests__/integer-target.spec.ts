import { beforeEach, describe, expect, it } from 'vitest';

import { handleRecordUpdate } from 'src/logic-functions/lib/handle-record-update';
import { recomputeForRecord } from 'src/logic-functions/lib/recompute';
import { type FormulaDefinitionRecord } from 'src/logic-functions/lib/types';
import {
  isIntegerBackedFormat,
  normalizeComputedValue,
} from 'src/logic-functions/lib/value-io';
import { FakeClient } from 'src/logic-functions/lib/__tests__/fake-client';

// finding M2: the wizard "integer" format creates a NUMBER field with
// settings.dataType 'int' (GraphQL Int scalar), which throws on a fractional
// write. recompute must round integer-backed targets — driven by the definition
// record's outputFormat — before every write AND comparison, exactly as CURRENCY
// rounds micros, or `x / 3` fails forever.

const integerFormula = (
  overrides: Partial<FormulaDefinitionRecord> = {},
): FormulaDefinitionRecord => ({
  id: 'f1',
  targetObject: 'opportunity',
  targetField: 'formulaScore',
  targetFieldType: 'NUMBER',
  outputFormat: 'integer',
  expression: 'formulaInputA / 3',
  enabled: true,
  ...overrides,
});

describe('isIntegerBackedFormat', () => {
  it('is true only for the integer output format', () => {
    expect(isIntegerBackedFormat('integer')).toBe(true);
    expect(isIntegerBackedFormat('decimal')).toBe(false);
    expect(isIntegerBackedFormat('percent')).toBe(false);
    expect(isIntegerBackedFormat(null)).toBe(false);
    expect(isIntegerBackedFormat(undefined)).toBe(false);
  });
});

describe('normalizeComputedValue with integerBacked', () => {
  it('rounds a NUMBER value to a whole number only when integer-backed', () => {
    expect(
      normalizeComputedValue('NUMBER', 3.3333, { integerBacked: true }),
    ).toBe(3);
    expect(
      normalizeComputedValue('NUMBER', 3.6, { integerBacked: true }),
    ).toBe(4);
    // Decimal NUMBER (not integer-backed) keeps the fraction.
    expect(
      normalizeComputedValue('NUMBER', 3.3333, { integerBacked: false }),
    ).toBe(3.3333);
    expect(normalizeComputedValue('NUMBER', 3.3333)).toBe(3.3333);
    expect(
      normalizeComputedValue('NUMBER', null, { integerBacked: true }),
    ).toBeNull();
  });
});

describe('recomputeForRecord on an integer-backed target', () => {
  let client: FakeClient;

  beforeEach(() => {
    client = new FakeClient();
  });

  it('rounds a fractional result before writing the Int scalar', async () => {
    client.seed('opportunity', [
      { id: 'o1', formulaInputA: 10, formulaScore: null },
    ]);

    const outcome = await recomputeForRecord({
      client,
      formula: integerFormula(),
      targetRecordId: 'o1',
    });

    // 10 / 3 = 3.333… -> rounds to 3 (whole number, Int-safe).
    expect(outcome.changed).toBe(true);
    expect(outcome.value).toBe(3);
    expect(client.get('opportunity', 'o1')!.formulaScore).toBe(3);
  });

  it('converges: a stored rounded value is not rewritten (no loop)', async () => {
    client.seed('opportunity', [
      { id: 'o1', formulaInputA: 10, formulaScore: 3 },
    ]);

    const outcome = await recomputeForRecord({
      client,
      formula: integerFormula(),
      targetRecordId: 'o1',
    });

    expect(outcome.changed).toBe(false);
    expect(client.writes).toHaveLength(0);
    expect(client.mutations).toBe(0);
  });
});

describe('override detection on an integer-backed target', () => {
  let client: FakeClient;

  beforeEach(() => {
    client = new FakeClient();
    client.seed('formulaDefinition', [
      integerFormula() as Record<string, unknown> & { id: string },
    ]);
  });

  it('records a human edit that differs from the rounded formula value', async () => {
    // Formula says 10/3 -> 3; the user pinned 4.
    client.seed('opportunity', [
      { id: 'o1', formulaInputA: 10, formulaScore: 4 },
    ]);

    await handleRecordUpdate({
      client,
      objectName: 'opportunity',
      recordId: 'o1',
      after: { id: 'o1', formulaInputA: 10, formulaScore: 4 },
      updatedFields: ['formulaScore'],
      actorWorkspaceMemberId: 'wm-1',
    });

    expect(client.get('formulaOverride', 'formulaOverride-0')).toMatchObject({
      recordId: 'o1',
      targetField: 'formulaScore',
      overrideValue: 4,
      active: true,
    });
  });

  it('ignores the app recompute write once rounded (matches the formula)', async () => {
    client.seed('opportunity', [
      { id: 'o1', formulaInputA: 10, formulaScore: 3 },
    ]);

    await handleRecordUpdate({
      client,
      objectName: 'opportunity',
      recordId: 'o1',
      after: { id: 'o1', formulaInputA: 10, formulaScore: 3 },
      updatedFields: ['formulaScore'],
      actorWorkspaceMemberId: 'wm-1',
    });

    expect(client.get('formulaOverride', 'formulaOverride-0')).toBeUndefined();
  });
});
