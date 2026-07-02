import { beforeEach, describe, expect, it } from 'vitest';

import { handleFormulaChange } from 'src/logic-functions/lib/handle-formula-change';
import { handleRecordUpdate } from 'src/logic-functions/lib/handle-record-update';
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
