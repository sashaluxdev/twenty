import { beforeEach, describe, expect, it } from 'vitest';

import { handleFormulaChange } from 'src/logic-functions/lib/handle-formula-change';
import { handleRecordUpdate } from 'src/logic-functions/lib/handle-record-update';
import { validateFormula } from 'src/logic-functions/lib/save-validation';
import {
  activateOverride,
  deactivateOverride,
  findOverride,
  upsertOverride,
} from 'src/logic-functions/lib/override-repository';
import { type FormulaDefinitionRecord } from 'src/logic-functions/lib/types';
import { FakeClient } from 'src/logic-functions/lib/__tests__/fake-client';

describe('handleFormulaChange (save-time validation)', () => {
  let client: FakeClient;

  beforeEach(() => {
    client = new FakeClient();
  });

  it('persists dependencies and clears the error for a valid formula', async () => {
    const def: FormulaDefinitionRecord = {
      id: 'f1',
      targetObject: 'opportunity',
      targetField: 'formulaScore',
      expression: 'formulaInputA + formulaInputB * 2',
      enabled: true,
      lastError: 'stale',
    };
    client.seed('formulaDefinition', [def]);
    client.seed('opportunity', [
      { id: 'o1', formulaInputA: 2, formulaInputB: 3, formulaScore: null },
    ]);

    const result = await handleFormulaChange({
      client,
      after: def,
      updatedFields: ['expression'],
    });

    expect(result.valid).toBe(true);
    const stored = client.get('formulaDefinition', 'f1')!;
    expect(stored.lastError).toBe('');
    expect(stored.dependencies).toEqual({
      crossRecordRefs: [],
      sameRecordFields: ['formulaInputA', 'formulaInputB'],
    });
    // Populated the value across records: 2 + 3*2 = 8.
    expect(client.get('opportunity', 'o1')!.formulaScore).toBe(8);
  });

  it('disables the formula and records a CLEAR error on a cycle', async () => {
    // Two formulas that reference each other's target field.
    const a: FormulaDefinitionRecord = {
      id: 'a',
      targetObject: 'opportunity',
      targetField: 'formulaScore',
      expression: 'formulaCrossScore + 1',
      enabled: true,
    };
    const b: FormulaDefinitionRecord = {
      id: 'b',
      targetObject: 'opportunity',
      targetField: 'formulaCrossScore',
      expression: 'formulaScore + 1',
      enabled: true,
    };
    client.seed('formulaDefinition', [a, b]);

    // b is created last -> forms the cycle with a.
    const result = await handleFormulaChange({
      client,
      after: b,
      updatedFields: undefined,
    });

    expect(result.valid).toBe(false);
    const stored = client.get('formulaDefinition', 'b')!;
    expect(stored.enabled).toBe(false);
    expect(stored.lastError).toMatch(/cycle/i);
    expect(String(stored.lastError)).toContain('->');
  });

  it('rejects a parse error with a clear message', async () => {
    const bad: FormulaDefinitionRecord = {
      id: 'x',
      targetObject: 'opportunity',
      targetField: 'formulaScore',
      expression: '1 + ;',
      enabled: true,
    };
    client.seed('formulaDefinition', [bad]);

    const result = await handleFormulaChange({
      client,
      after: bad,
      updatedFields: undefined,
    });

    expect(result.valid).toBe(false);
    expect(client.get('formulaDefinition', 'x')!.enabled).toBe(false);
    expect(String(client.get('formulaDefinition', 'x')!.lastError)).toMatch(
      /TOKENIZE_ERROR|PARSE_ERROR/,
    );
  });

  it('rejects and disables a definition with an injection-shaped target field (finding M1)', async () => {
    const bad: FormulaDefinitionRecord = {
      id: 'inj',
      targetObject: 'opportunity',
      targetField: 'score) { id } evil(',
      expression: 'formulaInputA',
      enabled: true,
    };
    client.seed('formulaDefinition', [bad]);

    const result = await handleFormulaChange({
      client,
      after: bad,
      updatedFields: undefined,
    });

    expect(result.valid).toBe(false);
    const stored = client.get('formulaDefinition', 'inj')!;
    expect(stored.enabled).toBe(false);
    expect(String(stored.lastError)).toMatch(/Invalid target field name/);
  });

  it('disables a formula whose string comparison targets a non-SELECT/TEXT field', async () => {
    const def: FormulaDefinitionRecord = {
      id: 'f1',
      targetObject: 'opportunity',
      targetField: 'formulaScore',
      expression: 'IF(amount = "big", 1, 0)',
      enabled: true,
    };
    client.seed('formulaDefinition', [def]);
    client.setFieldKinds('opportunity', { amount: 'NUMBER' });

    const result = await handleFormulaChange({
      client,
      after: def,
      updatedFields: ['expression'],
    });

    expect(result.valid).toBe(false);
    const stored = client.get('formulaDefinition', 'f1')!;
    expect(stored.enabled).toBe(false);
    expect(stored.lastError).toBe(
      'String comparison against "amount" is not supported (field type NUMBER; only SELECT and TEXT fields)',
    );
  });

  it('accepts a string comparison against a SELECT field (preloaded kinds)', async () => {
    const def: FormulaDefinitionRecord = {
      id: 'f1',
      targetObject: 'opportunity',
      targetField: 'formulaScore',
      expression: 'IF(stage = "QUALIFIED", 1, 0)',
      enabled: true,
    };
    client.seed('formulaDefinition', [def]);
    client.setFieldKinds('opportunity', { stage: 'SELECT' });
    client.seed('opportunity', [
      { id: 'o1', stage: 'QUALIFIED', formulaScore: null },
    ]);

    const result = await handleFormulaChange({
      client,
      after: def,
      updatedFields: ['expression'],
    });

    expect(result.valid).toBe(true);
    expect(client.get('formulaDefinition', 'f1')!.enabled).not.toBe(false);
  });

  it('ignores its own bookkeeping-only writes (no re-processing loop)', async () => {
    const def: FormulaDefinitionRecord = {
      id: 'f1',
      targetObject: 'opportunity',
      targetField: 'formulaScore',
      expression: 'formulaInputA',
      enabled: true,
    };
    client.seed('formulaDefinition', [def]);
    const before = client.mutations;

    const result = await handleFormulaChange({
      client,
      after: def,
      updatedFields: ['lastValue', 'lastEvaluatedAt'],
    });

    expect(result.handled).toBe(false);
    expect(client.mutations).toBe(before);
  });
});

describe('validateFormula string-comparison field-kind validation', () => {
  const candidate = (expression: string) => ({
    id: 'f1',
    targetObject: 'opportunity',
    targetField: 'formulaScore',
    expression,
  });

  it('accepts a string comparison against a SELECT field', () => {
    const result = validateFormula({
      candidate: candidate('IF(stage = "QUALIFIED", 1, 0)'),
      existingFormulas: [],
      targetObjectFieldKinds: new Map([['stage', 'SELECT']]),
    });
    expect(result.valid).toBe(true);
  });

  it('accepts a string comparison against a TEXT field', () => {
    const result = validateFormula({
      candidate: candidate('IF(tier = "gold", 1, 0)'),
      existingFormulas: [],
      targetObjectFieldKinds: new Map([['tier', 'TEXT']]),
    });
    expect(result.valid).toBe(true);
  });

  it('rejects a string comparison against a NUMBER field with the exact message', () => {
    const result = validateFormula({
      candidate: candidate('IF(amount = "big", 1, 0)'),
      existingFormulas: [],
      targetObjectFieldKinds: new Map([['amount', 'NUMBER']]),
    });
    expect(result.valid).toBe(false);
    expect((result as { valid: false; error: string }).error).toBe(
      'String comparison against "amount" is not supported (field type NUMBER; only SELECT and TEXT fields)',
    );
  });

  it('is valid when the kinds map is omitted (backward compatible)', () => {
    const result = validateFormula({
      candidate: candidate('IF(amount = "big", 1, 0)'),
      existingFormulas: [],
    });
    expect(result.valid).toBe(true);
  });

  it('passes an unknown field that is not in the kinds map', () => {
    const result = validateFormula({
      candidate: candidate('IF(mystery = "x", 1, 0)'),
      existingFormulas: [],
      targetObjectFieldKinds: new Map([['amount', 'NUMBER']]),
    });
    expect(result.valid).toBe(true);
  });

  it('passes a cross-record string comparison (runtime-null semantics)', () => {
    const companyId = '20202020-1c25-4d02-bf25-6aeccf7ea419';
    const result = validateFormula({
      candidate: candidate(`IF([company:${companyId}:employees] = "x", 1, 0)`),
      existingFormulas: [],
      targetObjectFieldKinds: new Map([['amount', 'NUMBER']]),
    });
    expect(result.valid).toBe(true);
  });
});

describe('override restore (deactivate keeps value, activate restores)', () => {
  it('retains the value when deactivated and restores it on re-activate', async () => {
    const client = new FakeClient();
    await upsertOverride(client, 'opportunity', 'formulaScore', 'o1', 42);

    let ov = await findOverride(client, 'opportunity', 'formulaScore', 'o1');
    expect(ov?.active).toBe(true);
    expect(ov?.overrideValue).toBe(42);

    await deactivateOverride(client, 'opportunity', 'formulaScore', 'o1');
    ov = await findOverride(client, 'opportunity', 'formulaScore', 'o1');
    expect(ov?.active).toBe(false);
    expect(ov?.overrideValue).toBe(42); // value retained, not deleted

    const restored = await activateOverride(
      client,
      'opportunity',
      'formulaScore',
      'o1',
    );
    expect(restored?.active).toBe(true);
    expect(restored?.overrideValue).toBe(42); // restored to the last value
  });

  it('activateOverride returns null when there is nothing to restore', async () => {
    const client = new FakeClient();
    const restored = await activateOverride(
      client,
      'opportunity',
      'formulaScore',
      'missing',
    );
    expect(restored).toBeNull();
  });
});

describe('handleRecordUpdate (event-driven recompute)', () => {
  let client: FakeClient;

  beforeEach(() => {
    client = new FakeClient();
    client.seed('formulaDefinition', [
      {
        id: 'f1',
        targetObject: 'opportunity',
        targetField: 'formulaScore',
        expression: 'formulaInputA + formulaInputB * 2',
        enabled: true,
      },
    ]);
  });

  it('recomputes when a dependency field changed', async () => {
    client.seed('opportunity', [
      { id: 'o1', formulaInputA: 5, formulaInputB: 10, formulaScore: null },
    ]);

    const outcomes = await handleRecordUpdate({
      client,
      objectName: 'opportunity',
      recordId: 'o1',
      after: { id: 'o1', formulaInputA: 5, formulaInputB: 10, formulaScore: null },
      updatedFields: ['formulaInputA'],
    });

    expect(outcomes.some((o) => o.changed)).toBe(true);
    expect(client.get('opportunity', 'o1')!.formulaScore).toBe(25);
  });

  it('skips recompute when only the output field changed (no self-trigger)', async () => {
    client.seed('opportunity', [
      { id: 'o1', formulaInputA: 5, formulaInputB: 10, formulaScore: 25 },
    ]);
    const before = client.mutations;

    const outcomes = await handleRecordUpdate({
      client,
      objectName: 'opportunity',
      recordId: 'o1',
      after: { id: 'o1', formulaInputA: 5, formulaInputB: 10, formulaScore: 25 },
      // Our own write of the output field only.
      updatedFields: ['formulaScore'],
    });

    expect(outcomes).toHaveLength(0);
    expect(client.mutations).toBe(before);
  });

  it('never recomputes formulas caught in a cycle (no ping-pong storm)', async () => {
    // Two mutually-referencing formulas enabled directly (bypassing save-time
    // validation). The runtime guard must refuse to recompute either.
    client = new FakeClient();
    client.seed('formulaDefinition', [
      {
        id: 'a',
        targetObject: 'opportunity',
        targetField: 'formulaScore',
        expression: 'formulaCrossScore + 1',
        enabled: true,
      },
      {
        id: 'b',
        targetObject: 'opportunity',
        targetField: 'formulaCrossScore',
        expression: 'formulaScore + 1',
        enabled: true,
      },
    ]);
    client.seed('opportunity', [
      { id: 'o1', formulaScore: 0, formulaCrossScore: 0 },
    ]);

    const outcomes = await handleRecordUpdate({
      client,
      objectName: 'opportunity',
      recordId: 'o1',
      after: { id: 'o1', formulaScore: 0, formulaCrossScore: 0 },
      updatedFields: ['formulaScore'],
    });

    // No writes at all — the cyclic pair is excluded from recompute.
    expect(outcomes).toHaveLength(0);
    expect(client.writes).toHaveLength(0);
  });

  it('creates an override when a HUMAN edits the value field directly (magic)', async () => {
    client.seed('opportunity', [
      { id: 'o1', formulaInputA: 5, formulaInputB: 10, formulaScore: 3 },
    ]);

    await handleRecordUpdate({
      client,
      objectName: 'opportunity',
      recordId: 'o1',
      after: { id: 'o1', formulaInputA: 5, formulaInputB: 10, formulaScore: 3 },
      updatedFields: ['formulaScore'],
      actorWorkspaceMemberId: 'wm-1', // a real person made the edit
    });

    const override = client.get('formulaOverride', 'formulaOverride-0');
    expect(override).toBeDefined();
    expect(override!.recordId).toBe('o1');
    expect(override!.targetField).toBe('formulaScore');
    expect(override!.overrideValue).toBe(3);
  });

  it('does NOT create an override when a recompute write matches the formula (even with a human actor)', async () => {
    // Reproduces the bug: editing an input triggers a recompute whose write
    // event carries the user's identity. The written value equals the formula,
    // so it must be treated as a recompute, not a manual override.
    client.seed('opportunity', [
      { id: 'o1', formulaInputA: 5, formulaInputB: 10, formulaScore: 25 },
    ]);

    await handleRecordUpdate({
      client,
      objectName: 'opportunity',
      recordId: 'o1',
      after: { id: 'o1', formulaInputA: 5, formulaInputB: 10, formulaScore: 25 },
      updatedFields: ['formulaScore'],
      actorWorkspaceMemberId: 'wm-1', // propagated user identity on the recompute
    });

    // 5 + 10*2 = 25 == written value -> no override.
    expect(client.get('formulaOverride', 'formulaOverride-0')).toBeUndefined();
  });

  it('does NOT create an override when the APP writes the value (no actor)', async () => {
    client.seed('opportunity', [
      { id: 'o1', formulaInputA: 5, formulaInputB: 10, formulaScore: 25 },
    ]);

    await handleRecordUpdate({
      client,
      objectName: 'opportunity',
      recordId: 'o1',
      after: { id: 'o1', formulaInputA: 5, formulaInputB: 10, formulaScore: 25 },
      updatedFields: ['formulaScore'],
      actorWorkspaceMemberId: null, // the app's own recompute write
    });

    expect(client.get('formulaOverride', 'formulaOverride-0')).toBeUndefined();
  });

  it('does not recompute a record that already has an override', async () => {
    client.seed('opportunity', [
      { id: 'o1', formulaInputA: 5, formulaInputB: 10, formulaScore: 99 },
    ]);
    client.seed('formulaOverride', [
      {
        id: 'ov1',
        name: 'opportunity.formulaScore#o1',
        targetObject: 'opportunity',
        targetField: 'formulaScore',
        recordId: 'o1',
        overrideValue: 99,
        active: true,
      },
    ]);

    const outcomes = await handleRecordUpdate({
      client,
      objectName: 'opportunity',
      recordId: 'o1',
      after: { id: 'o1', formulaInputA: 5, formulaInputB: 10, formulaScore: 99 },
      updatedFields: ['formulaInputA'],
    });

    const outcome = outcomes.find((entry) => entry.formulaId === 'f1');
    expect(outcome?.overridden).toBe(true);
    // The formula would say 25, but the pinned 99 is untouched.
    expect(client.get('opportunity', 'o1')!.formulaScore).toBe(99);
  });

  it('performs zero definition-row writes on a no-op recompute (heartbeat write-avoidance, finding M3)', async () => {
    // The definition already holds the value the formula computes, and the
    // record is already correct: recompute changes nothing, so NOTHING — not
    // even a lastEvaluatedAt bump — may be written back to the definition row.
    client.seed('formulaDefinition', [
      {
        id: 'f1',
        targetObject: 'opportunity',
        targetField: 'formulaScore',
        expression: 'formulaInputA + formulaInputB * 2',
        enabled: true,
        lastValue: 25,
        lastError: '',
      },
    ]);
    client.seed('opportunity', [
      { id: 'o1', formulaInputA: 5, formulaInputB: 10, formulaScore: 25 },
    ]);
    const before = client.mutations;

    await handleRecordUpdate({
      client,
      objectName: 'opportunity',
      recordId: 'o1',
      after: { id: 'o1', formulaInputA: 5, formulaInputB: 10, formulaScore: 25 },
      updatedFields: ['formulaInputA'],
    });

    expect(client.mutations).toBe(before);
  });

  it('does NOT create a spurious override when the stored value was superseded (echo-race, finding m1)', async () => {
    // The record has already converged to 29 (inputs 9,10), but a STALE echo of
    // the app's earlier write of 25 arrives carrying a user identity and lacking
    // the input fields. Comparing a fresh recompute to that stale snapshot would
    // fabricate an override; the superseded-write guard must skip it.
    client.seed('opportunity', [
      { id: 'o1', formulaInputA: 9, formulaInputB: 10, formulaScore: 29 },
    ]);

    await handleRecordUpdate({
      client,
      objectName: 'opportunity',
      recordId: 'o1',
      after: { id: 'o1', formulaScore: 25 },
      updatedFields: ['formulaScore'],
      actorWorkspaceMemberId: 'wm-1',
    });

    expect(client.get('formulaOverride', 'formulaOverride-0')).toBeUndefined();
    // The converged value is left untouched.
    expect(client.get('opportunity', 'o1')!.formulaScore).toBe(29);
  });

  it('recomputes cross-object formulas when a referenced record changed', async () => {
    const companyId = '20202020-1c25-4d02-bf25-6aeccf7ea419';
    client.seed('formulaDefinition', [
      {
        id: 'fx',
        targetObject: 'opportunity',
        targetField: 'formulaCrossScore',
        expression: `formulaInputA + [company:${companyId}:employees]`,
        enabled: true,
      },
    ]);
    client.seed('opportunity', [
      { id: 'o1', formulaInputA: 5, formulaCrossScore: null },
    ]);
    client.seed('company', [{ id: companyId, employees: 200 }]);

    const outcomes = await handleRecordUpdate({
      client,
      objectName: 'company',
      recordId: companyId,
      after: { id: companyId, employees: 200 },
      updatedFields: ['employees'],
    });

    expect(outcomes.some((o) => o.changed)).toBe(true);
    expect(client.get('opportunity', 'o1')!.formulaCrossScore).toBe(205);
  });
});
