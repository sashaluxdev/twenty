import { beforeEach, describe, expect, it, vi } from 'vitest';

import { parse } from 'src/engine/parser';
import { handleFormulaChange } from 'src/logic-functions/lib/handle-formula-change';
import { handleRecordUpdate } from 'src/logic-functions/lib/handle-record-update';
import { validateFormula } from 'src/logic-functions/lib/save-validation';
import {
  activateOverride,
  deactivateOverride,
  decodeMirrorOverrideValue,
  findOverride,
  upsertOverride,
} from 'src/logic-functions/lib/override-repository';
import {
  loadAllEnabledFormulas,
  recordEvaluationHeartbeat,
} from 'src/logic-functions/lib/formula-repository';
import { recomputeForRecord } from 'src/logic-functions/lib/recompute';
import { type FormulaDefinitionRecord } from 'src/logic-functions/lib/types';
import { FakeClient } from 'src/logic-functions/lib/__tests__/fake-client';

// See recompute.spec.ts: compileFormula binds `parse` from the parser module, so
// the parser module is the only seam where the real parse count is observable.
vi.mock('src/engine/parser', async (importActual) => {
  const actual = await importActual<typeof import('src/engine/parser')>();
  return { ...actual, parse: vi.fn(actual.parse) };
});

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
    // Was branch 1b; now the strict kind gate's comparison rule (Task 3). The
    // gate only runs against a known target kind, so this needs a
    // targetFieldType where 1b did not.
    const def: FormulaDefinitionRecord = {
      id: 'f1',
      targetObject: 'opportunity',
      targetField: 'formulaScore',
      targetFieldType: 'NUMBER',
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
      'Cannot compare number with text using "=" (kinds must match)',
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

  it('disables a mirror whose non-mirrorable target kind cannot be mirrored', async () => {
    const def: FormulaDefinitionRecord = {
      id: 'm1',
      targetObject: 'opportunity',
      targetField: 'mirrorField',
      targetFieldType: 'RELATION',
      expression: 'sourceField',
      enabled: true,
    };
    client.seed('formulaDefinition', [def]);

    const result = await handleFormulaChange({
      client,
      after: def,
      updatedFields: ['expression'],
    });

    expect(result.valid).toBe(false);
    const stored = client.get('formulaDefinition', 'm1')!;
    expect(stored.enabled).toBe(false);
    expect(stored.lastError).toBe('Field kind RELATION cannot be mirrored');
  });

  it('disables a mirror whose same-record source kind differs from the target', async () => {
    const def: FormulaDefinitionRecord = {
      id: 'm1',
      targetObject: 'opportunity',
      targetField: 'mirrorField',
      targetFieldType: 'SELECT',
      expression: 'sourceField',
      enabled: true,
    };
    client.seed('formulaDefinition', [def]);
    client.setFieldKinds('opportunity', { sourceField: 'TEXT' });

    const result = await handleFormulaChange({
      client,
      after: def,
      updatedFields: ['expression'],
    });

    expect(result.valid).toBe(false);
    const stored = client.get('formulaDefinition', 'm1')!;
    expect(stored.enabled).toBe(false);
    expect(stored.lastError).toBe(
      'Cannot mirror TEXT field "sourceField" onto a SELECT field (kinds must match)',
    );
  });

  it('preloads the cross-ref source object kinds to reject a cross-record mirror mismatch', async () => {
    const companyId = '20202020-1c25-4d02-bf25-6aeccf7ea419';
    const def: FormulaDefinitionRecord = {
      id: 'm1',
      targetObject: 'opportunity',
      targetField: 'mirrorField',
      targetFieldType: 'SELECT',
      expression: `[company:${companyId}:name]`,
      enabled: true,
    };
    client.seed('formulaDefinition', [def]);
    client.setFieldKinds('company', { name: 'TEXT' });

    const result = await handleFormulaChange({
      client,
      after: def,
      updatedFields: ['expression'],
    });

    expect(result.valid).toBe(false);
    const stored = client.get('formulaDefinition', 'm1')!;
    expect(stored.enabled).toBe(false);
    expect(stored.lastError).toBe(
      'Cannot mirror TEXT field "name" onto a SELECT field (kinds must match)',
    );
  });

  it('preloads kinds for a cross-record operand that is not a bare mirror ref (strict kind gate, Task 3)', async () => {
    // The widened preload (Task 3) fetches kinds for every cross-referenced
    // object the expression reads, not only a bare-ref mirror source — this
    // cross-record field sits inside a comparison on an ENGINE-family target.
    const companyId = '20202020-1c25-4d02-bf25-6aeccf7ea419';
    const def: FormulaDefinitionRecord = {
      id: 'f1',
      targetObject: 'opportunity',
      targetField: 'formulaScore',
      targetFieldType: 'NUMBER',
      expression: `IF([company:${companyId}:closeDate] = "2026-01-15", 1, 0)`,
      enabled: true,
    };
    client.seed('formulaDefinition', [def]);
    client.setFieldKinds('company', { closeDate: 'DATE' });

    const result = await handleFormulaChange({
      client,
      after: def,
      updatedFields: ['expression'],
    });

    expect(result.valid).toBe(false);
    const stored = client.get('formulaDefinition', 'f1')!;
    expect(stored.enabled).toBe(false);
    expect(stored.lastError).toBe(
      'Cannot compare date with text using "=" (kinds must match)',
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

describe('validateFormula string-comparison field-kind validation', () => {
  const candidate = (expression: string, targetFieldType?: string) => ({
    id: 'f1',
    targetObject: 'opportunity',
    targetField: 'formulaScore',
    targetFieldType,
    expression,
  });

  it('accepts a string comparison against a SELECT field', () => {
    const result = validateFormula({
      candidate: candidate('IF(stage = "QUALIFIED", 1, 0)'),
      existingFormulas: [],
      fieldKinds: () => new Map([['stage', 'SELECT']]),
    });
    expect(result.valid).toBe(true);
  });

  it('accepts a string comparison against a TEXT field', () => {
    const result = validateFormula({
      candidate: candidate('IF(tier = "gold", 1, 0)'),
      existingFormulas: [],
      fieldKinds: () => new Map([['tier', 'TEXT']]),
    });
    expect(result.valid).toBe(true);
  });

  it('rejects a string comparison against a NUMBER field with the exact message', () => {
    // Was branch 1b; now the strict kind gate's comparison rule (Task 3). The
    // gate only runs against a known target kind, so this needs a
    // targetFieldType where 1b did not.
    const result = validateFormula({
      candidate: candidate('IF(amount = "big", 1, 0)', 'NUMBER'),
      existingFormulas: [],
      fieldKinds: () => new Map([['amount', 'NUMBER']]),
    });
    expect(result.valid).toBe(false);
    expect((result as { valid: false; error: string }).error).toBe(
      'Cannot compare number with text using "=" (kinds must match)',
    );
  });

  it('is valid when the kinds accessor is omitted (backward compatible)', () => {
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
      fieldKinds: () => new Map([['amount', 'NUMBER']]),
    });
    expect(result.valid).toBe(true);
  });

  it('passes a cross-record string comparison (runtime-null semantics)', () => {
    const companyId = '20202020-1c25-4d02-bf25-6aeccf7ea419';
    const result = validateFormula({
      candidate: candidate(`IF([company:${companyId}:employees] = "x", 1, 0)`),
      existingFormulas: [],
      fieldKinds: () => new Map([['amount', 'NUMBER']]),
    });
    expect(result.valid).toBe(true);
  });
});

describe('validateFormula mirror validation', () => {
  const COMPANY_ID = '20202020-1c25-4d02-bf25-6aeccf7ea419';

  const mirror = (expression: string, targetFieldType: string) => ({
    id: 'm1',
    targetObject: 'opportunity',
    targetField: 'mirrorField',
    expression,
    targetFieldType,
  });

  const errorOf = (result: ReturnType<typeof validateFormula>) =>
    (result as { valid: false; error: string }).error;

  // (a) target kind is not in the mirror allowlist at all.
  it('rejects a non-mirrorable target kind with the exact message', () => {
    const result = validateFormula({
      candidate: mirror('status', 'RELATION'),
      existingFormulas: [],
    });
    expect(result.valid).toBe(false);
    expect(errorOf(result)).toBe('Field kind RELATION cannot be mirrored');
  });

  // (b) allowlisted target but the expression is not a bare whole-field ref.
  it('rejects an operator expression onto a mirrorable target', () => {
    const result = validateFormula({
      candidate: mirror('status + otherField', 'SELECT'),
      existingFormulas: [],
    });
    expect(result.valid).toBe(false);
    expect(errorOf(result)).toBe(
      'Only a plain field reference can be mirrored onto a SELECT field',
    );
  });

  it('rejects a dotted subpath ref onto a mirrorable target', () => {
    const result = validateFormula({
      candidate: mirror('amount.amountMicros', 'SELECT'),
      existingFormulas: [],
    });
    expect(result.valid).toBe(false);
    expect(errorOf(result)).toBe(
      'Only a plain field reference can be mirrored onto a SELECT field',
    );
  });

  // (c) source kind known via accessor and different from target kind.
  it('rejects a same-record source of a different kind with the exact message', () => {
    const result = validateFormula({
      candidate: mirror('sourceField', 'SELECT'),
      existingFormulas: [],
      fieldKinds: (object) =>
        object === 'opportunity'
          ? new Map([['sourceField', 'TEXT']])
          : undefined,
    });
    expect(result.valid).toBe(false);
    expect(errorOf(result)).toBe(
      'Cannot mirror TEXT field "sourceField" onto a SELECT field (kinds must match)',
    );
  });

  it('rejects a cross-record source of a different kind (preloaded source object)', () => {
    const result = validateFormula({
      candidate: mirror(`[company:${COMPANY_ID}:name]`, 'SELECT'),
      existingFormulas: [],
      fieldKinds: (object) =>
        object === 'company' ? new Map([['name', 'TEXT']]) : undefined,
    });
    expect(result.valid).toBe(false);
    expect(errorOf(result)).toBe(
      'Cannot mirror TEXT field "name" onto a SELECT field (kinds must match)',
    );
  });

  it('accepts a same-kind same-record mirror', () => {
    const result = validateFormula({
      candidate: mirror('sourceField', 'SELECT'),
      existingFormulas: [],
      fieldKinds: () => new Map([['sourceField', 'SELECT']]),
    });
    expect(result.valid).toBe(true);
  });

  it('accepts a same-kind cross-record mirror', () => {
    const result = validateFormula({
      candidate: mirror(`[company:${COMPANY_ID}:name]`, 'SELECT'),
      existingFormulas: [],
      fieldKinds: (object) =>
        object === 'company' ? new Map([['name', 'SELECT']]) : undefined,
    });
    expect(result.valid).toBe(true);
  });

  it('rejects a bare SELECT-source ref onto a NUMBER target (strict kind gate, Task 3)', () => {
    // Previously an engine-family target skipped the mirror block (1c)
    // entirely, so this bare ref passed unchecked here — any mismatch would
    // only surface later, at eval time. The strict kind gate now types the bare
    // ref's output (SELECT -> text) and rejects it against the NUMBER target at
    // save time instead.
    const result = validateFormula({
      candidate: mirror('sourceField', 'NUMBER'),
      existingFormulas: [],
      fieldKinds: () => new Map([['sourceField', 'SELECT']]),
    });
    expect(result.valid).toBe(false);
    expect(errorOf(result)).toMatch(
      /computes text but the target field holds number/,
    );
  });

  it('leaves an engine-family target (NUMBER) unaffected for a subpath expression', () => {
    const result = validateFormula({
      candidate: mirror('amount.amountMicros', 'NUMBER'),
      existingFormulas: [],
    });
    expect(result.valid).toBe(true);
  });

  // Accessor omitted: only (a)/(b) run — (c) degrades gracefully (passes).
  it('degrades gracefully with no accessor: unknown source kind passes', () => {
    const result = validateFormula({
      candidate: mirror('sourceField', 'SELECT'),
      existingFormulas: [],
    });
    expect(result.valid).toBe(true);
  });

  it('still runs (a) with no accessor', () => {
    const result = validateFormula({
      candidate: mirror('status', 'ACTOR'),
      existingFormulas: [],
    });
    expect(result.valid).toBe(false);
    expect(errorOf(result)).toBe('Field kind ACTOR cannot be mirrored');
  });

  it('still runs (b) with no accessor', () => {
    const result = validateFormula({
      candidate: mirror('a + b', 'LINKS'),
      existingFormulas: [],
    });
    expect(result.valid).toBe(false);
    expect(errorOf(result)).toBe(
      'Only a plain field reference can be mirrored onto a LINKS field',
    );
  });

  // Accessor gap: source object present but the field is absent from the map.
  it('passes when the accessor lacks the source field (accessor gap)', () => {
    const result = validateFormula({
      candidate: mirror('sourceField', 'SELECT'),
      existingFormulas: [],
      fieldKinds: () => new Map([['otherField', 'TEXT']]),
    });
    expect(result.valid).toBe(true);
  });
});

describe('override restore (deactivate keeps value, activate restores)', () => {
  it('retains the value when deactivated and restores it on re-activate', async () => {
    const client = new FakeClient();
    await upsertOverride(client, 'opportunity', 'formulaScore', 'o1', {
      numeric: 42,
    });

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

describe('mirror override text (overrideValueText round trip)', () => {
  it('stores a composite value as JSON text with a null numeric column', async () => {
    const client = new FakeClient();
    const composite = { firstName: 'Ada', lastName: 'Lovelace' };
    await upsertOverride(client, 'company', 'mirror', 'c1', {
      text: JSON.stringify(composite),
    });

    const ov = await findOverride(client, 'company', 'mirror', 'c1');
    expect(ov?.active).toBe(true);
    expect(ov?.overrideValue ?? null).toBeNull();
    expect(ov?.overrideValueText).toBe(JSON.stringify(composite));
  });

  it('retains overrideValueText across deactivate and restores it on activate', async () => {
    const client = new FakeClient();
    const composite = { firstName: 'Ada', lastName: 'Lovelace' };
    await upsertOverride(client, 'company', 'mirror', 'c1', {
      text: JSON.stringify(composite),
    });

    await deactivateOverride(client, 'company', 'mirror', 'c1');
    let ov = await findOverride(client, 'company', 'mirror', 'c1');
    expect(ov?.active).toBe(false);
    expect(ov?.overrideValueText).toBe(JSON.stringify(composite)); // retained

    const restored = await activateOverride(client, 'company', 'mirror', 'c1');
    expect(restored?.active).toBe(true);
    expect(JSON.parse(restored!.overrideValueText!)).toEqual(composite);
  });
});

describe('decodeMirrorOverrideValue', () => {
  it('parses well-formed JSON text into its raw value', () => {
    expect(decodeMirrorOverrideValue(JSON.stringify('ACTIVE'))).toEqual({
      restorable: true,
      value: 'ACTIVE',
    });
    expect(decodeMirrorOverrideValue(JSON.stringify({ a: [1, 2] }))).toEqual({
      restorable: true,
      value: { a: [1, 2] },
    });
  });

  it('treats corrupted text as not restorable (pin-current fallback)', () => {
    expect(decodeMirrorOverrideValue('{not json')).toEqual({
      restorable: false,
      value: null,
    });
  });

  it('treats null/undefined text as not restorable', () => {
    expect(decodeMirrorOverrideValue(null)).toEqual({
      restorable: false,
      value: null,
    });
    expect(decodeMirrorOverrideValue(undefined)).toEqual({
      restorable: false,
      value: null,
    });
  });
});

describe('mirror override toggle-off restores the source value', () => {
  it('deactivate + mirror recompute writes the source value back', async () => {
    const client = new FakeClient();
    client.setFieldKinds('company', { source: 'SELECT', mirror: 'SELECT' });
    client.seed('company', [{ id: 'c1', source: 'ACTIVE', mirror: 'PINNED' }]);
    await upsertOverride(client, 'company', 'mirror', 'c1', {
      text: JSON.stringify('PINNED'),
    });

    await deactivateOverride(client, 'company', 'mirror', 'c1');
    await recomputeForRecord({
      client,
      formula: {
        id: 'm1',
        targetObject: 'company',
        targetField: 'mirror',
        targetFieldType: 'SELECT',
        expression: 'source',
        enabled: true,
      },
      targetRecordId: 'c1',
    });

    expect(client.get('company', 'c1')!.mirror).toBe('ACTIVE');
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

  it('ignores an app echo on a mirror target (event raw equals the source value)', async () => {
    client = new FakeClient();
    client.setFieldKinds('company', { source: 'SELECT', mirror: 'SELECT' });
    client.seed('formulaDefinition', [
      {
        id: 'm1',
        targetObject: 'company',
        targetField: 'mirror',
        targetFieldType: 'SELECT',
        expression: 'source',
        enabled: true,
      },
    ]);
    client.seed('company', [{ id: 'c1', source: 'ACTIVE', mirror: 'ACTIVE' }]);

    await handleRecordUpdate({
      client,
      objectName: 'company',
      recordId: 'c1',
      after: { id: 'c1', mirror: 'ACTIVE' },
      updatedFields: ['mirror'],
      actorWorkspaceMemberId: 'wm-1',
    });

    // Current target equals the mirror source -> app's own write, not a pin.
    expect(client.get('formulaOverride', 'formulaOverride-0')).toBeUndefined();
  });

  it('creates a text override when a HUMAN edits a mirror target away from the source', async () => {
    client = new FakeClient();
    client.setFieldKinds('company', { source: 'SELECT', mirror: 'SELECT' });
    client.seed('formulaDefinition', [
      {
        id: 'm1',
        targetObject: 'company',
        targetField: 'mirror',
        targetFieldType: 'SELECT',
        expression: 'source',
        enabled: true,
      },
    ]);
    client.seed('company', [{ id: 'c1', source: 'ACTIVE', mirror: 'MANUAL' }]);

    await handleRecordUpdate({
      client,
      objectName: 'company',
      recordId: 'c1',
      after: { id: 'c1', mirror: 'MANUAL' },
      updatedFields: ['mirror'],
      actorWorkspaceMemberId: 'wm-1',
    });

    const override = client.get('formulaOverride', 'formulaOverride-0');
    expect(override).toBeDefined();
    expect(override!.recordId).toBe('c1');
    expect(override!.targetField).toBe('mirror');
    expect(override!.overrideValueText).toBe(JSON.stringify('MANUAL'));
    expect(override!.overrideValue ?? null).toBeNull();
    // The human's manual value is left in place.
    expect(client.get('company', 'c1')!.mirror).toBe('MANUAL');
  });

  it('ignores an app echo on a COMPOSITE mirror target (deep-equal source value)', async () => {
    client = new FakeClient();
    client.setFieldKinds('company', { source: 'FULL_NAME', mirror: 'FULL_NAME' });
    client.seed('formulaDefinition', [
      {
        id: 'm1',
        targetObject: 'company',
        targetField: 'mirror',
        targetFieldType: 'FULL_NAME',
        expression: 'source',
        enabled: true,
      },
    ]);
    const composite = { firstName: 'Ada', lastName: 'Lovelace' };
    client.seed('company', [{ id: 'c1', source: composite, mirror: composite }]);

    await handleRecordUpdate({
      client,
      objectName: 'company',
      recordId: 'c1',
      after: { id: 'c1', mirror: composite },
      updatedFields: ['mirror'],
      actorWorkspaceMemberId: 'wm-1',
    });

    // The stored composite deep-equals the mirror source -> the app's own write,
    // not a human pin.
    expect(client.get('formulaOverride', 'formulaOverride-0')).toBeUndefined();
  });

  it('pins a text override when a HUMAN edits a COMPOSITE mirror target away from the source', async () => {
    client = new FakeClient();
    client.setFieldKinds('company', { source: 'FULL_NAME', mirror: 'FULL_NAME' });
    client.seed('formulaDefinition', [
      {
        id: 'm1',
        targetObject: 'company',
        targetField: 'mirror',
        targetFieldType: 'FULL_NAME',
        expression: 'source',
        enabled: true,
      },
    ]);
    const source = { firstName: 'Ada', lastName: 'Lovelace' };
    const manual = { firstName: 'Grace', lastName: 'Hopper' };
    client.seed('company', [{ id: 'c1', source, mirror: manual }]);

    await handleRecordUpdate({
      client,
      objectName: 'company',
      recordId: 'c1',
      after: { id: 'c1', mirror: manual },
      updatedFields: ['mirror'],
      actorWorkspaceMemberId: 'wm-1',
    });

    const override = client.get('formulaOverride', 'formulaOverride-0');
    expect(override).toBeDefined();
    expect(override!.recordId).toBe('c1');
    expect(override!.targetField).toBe('mirror');
    expect(override!.overrideValueText).toBe(JSON.stringify(manual));
    expect(override!.overrideValue ?? null).toBeNull();
    // The human's manual composite is left in place.
    expect(client.get('company', 'c1')!.mirror).toEqual(manual);
  });

  it('skips a superseded stale echo on a mirror target (no spurious pin)', async () => {
    client = new FakeClient();
    client.setFieldKinds('company', { source: 'SELECT', mirror: 'SELECT' });
    client.seed('formulaDefinition', [
      {
        id: 'm1',
        targetObject: 'company',
        targetField: 'mirror',
        targetFieldType: 'SELECT',
        expression: 'source',
        enabled: true,
      },
    ]);
    // Already converged to CONVERGED, but a stale echo of an earlier value arrives.
    client.seed('company', [{ id: 'c1', source: 'ACTIVE', mirror: 'CONVERGED' }]);

    await handleRecordUpdate({
      client,
      objectName: 'company',
      recordId: 'c1',
      after: { id: 'c1', mirror: 'STALE_ECHO' },
      updatedFields: ['mirror'],
      actorWorkspaceMemberId: 'wm-1',
    });

    expect(client.get('formulaOverride', 'formulaOverride-0')).toBeUndefined();
    expect(client.get('company', 'c1')!.mirror).toBe('CONVERGED');
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

// Lane switch (Task 7): a deployed TEXT mirror is now a one-term engine formula,
// so it runs the ENGINE override-detection funnel (strict string compare) while
// keeping the mirror lane's storage conventions — the pin lives in
// overrideValueText as JSON, exactly as the rows already deployed do.
describe('handleRecordUpdate — TEXT target on the engine lane', () => {
  let client: FakeClient;

  const seedTextMirror = (): void => {
    client.setFieldKinds('company', { source: 'TEXT', mirror: 'TEXT' });
    client.seed('formulaDefinition', [
      {
        id: 'mt',
        targetObject: 'company',
        targetField: 'mirror',
        targetFieldType: 'TEXT',
        expression: 'source',
        enabled: true,
      },
    ]);
  };

  beforeEach(() => {
    client = new FakeClient();
  });

  it('writes the source value from the event payload without refetching the record', async () => {
    seedTextMirror();
    client.seed('company', [{ id: 'c1', source: 'NEW', mirror: 'OLD' }]);

    await handleRecordUpdate({
      client,
      objectName: 'company',
      recordId: 'c1',
      after: { id: 'c1', source: 'NEW', mirror: 'OLD' },
      updatedFields: ['source'],
    });

    expect(client.writes).toEqual(['company:c1:mirror="NEW"']);
    // The mirror lane always refetched (its composite kinds are not
    // sub-selection-safe in an event payload). A TEXT column is a plain scalar,
    // so the engine lane trusts `after` — one fewer read per event.
    expect(
      client.querySelections.filter((selection) => selection.company !== undefined),
    ).toHaveLength(0);
  });

  it('ignores the app echo of its own TEXT write (no spurious pin)', async () => {
    seedTextMirror();
    client.seed('company', [{ id: 'c1', source: 'ACTIVE', mirror: 'ACTIVE' }]);

    await handleRecordUpdate({
      client,
      objectName: 'company',
      recordId: 'c1',
      after: { id: 'c1', mirror: 'ACTIVE' },
      updatedFields: ['mirror'],
      actorWorkspaceMemberId: 'wm-1',
    });

    expect(client.get('formulaOverride', 'formulaOverride-0')).toBeUndefined();
  });

  it('pins the JSON text slot when a HUMAN edits a TEXT target away from the computed value', async () => {
    seedTextMirror();
    client.seed('company', [{ id: 'c1', source: 'ACTIVE', mirror: 'MANUAL' }]);

    await handleRecordUpdate({
      client,
      objectName: 'company',
      recordId: 'c1',
      after: { id: 'c1', mirror: 'MANUAL' },
      updatedFields: ['mirror'],
      actorWorkspaceMemberId: 'wm-1',
    });

    const override = client.get('formulaOverride', 'formulaOverride-0');
    expect(override).toBeDefined();
    expect(override!.targetField).toBe('mirror');
    // The deployed convention, unchanged: JSON in the text column, numeric null.
    expect(override!.overrideValueText).toBe(JSON.stringify('MANUAL'));
    expect(override!.overrideValue ?? null).toBeNull();
    expect(client.get('company', 'c1')!.mirror).toBe('MANUAL');
  });

  it('skips a superseded stale echo on a TEXT target', async () => {
    seedTextMirror();
    client.seed('company', [{ id: 'c1', source: 'ACTIVE', mirror: 'CONVERGED' }]);

    await handleRecordUpdate({
      client,
      objectName: 'company',
      recordId: 'c1',
      after: { id: 'c1', mirror: 'STALE_ECHO' },
      updatedFields: ['mirror'],
      actorWorkspaceMemberId: 'wm-1',
    });

    expect(client.get('formulaOverride', 'formulaOverride-0')).toBeUndefined();
    expect(client.get('company', 'c1')!.mirror).toBe('CONVERGED');
  });

  // Finding M5: a pinned TEXT target stores its value in overrideValueText, so
  // an outcome that read the numeric column would report every pinned record as
  // empty — and the heartbeat would then blank a real lastValueText.
  it('reports an ACTIVE TEXT override from the text column, not the numeric one', async () => {
    seedTextMirror();
    client.seed('company', [{ id: 'c1', source: 'ACTIVE', mirror: 'PINNED' }]);
    client.seed('formulaOverride', [
      {
        id: 'ov-text',
        name: 'company.mirror#c1',
        targetObject: 'company',
        targetField: 'mirror',
        recordId: 'c1',
        overrideValue: null,
        overrideValueText: JSON.stringify('PINNED'),
        active: true,
      },
    ]);

    const outcomes = await handleRecordUpdate({
      client,
      objectName: 'company',
      recordId: 'c1',
      after: { id: 'c1', source: 'ACTIVE', mirror: 'PINNED' },
      updatedFields: ['source'],
    });

    const outcome = outcomes.find((entry) => entry.formulaId === 'mt');
    expect(outcome?.overridden).toBe(true);
    expect(outcome?.value).toEqual({ kind: 'text', value: 'PINNED' });
    // The pin still suppresses the recompute: the source says ACTIVE.
    expect(client.get('company', 'c1')!.mirror).toBe('PINNED');
    expect(client.writes).toHaveLength(0);
  });

  it('still reports a numeric target override from the numeric column', async () => {
    client.seed('formulaDefinition', [
      {
        id: 'fn',
        targetObject: 'opportunity',
        targetField: 'formulaScore',
        expression: 'formulaInputA + 1',
        enabled: true,
      },
    ]);
    client.seed('opportunity', [{ id: 'o1', formulaInputA: 5, formulaScore: 99 }]);
    client.seed('formulaOverride', [
      {
        id: 'ov-num',
        name: 'opportunity.formulaScore#o1',
        targetObject: 'opportunity',
        targetField: 'formulaScore',
        recordId: 'o1',
        overrideValue: 99,
        overrideValueText: null,
        active: true,
      },
    ]);

    const outcomes = await handleRecordUpdate({
      client,
      objectName: 'opportunity',
      recordId: 'o1',
      after: { id: 'o1', formulaInputA: 5, formulaScore: 99 },
      updatedFields: ['formulaInputA'],
    });

    const outcome = outcomes.find((entry) => entry.formulaId === 'fn');
    expect(outcome?.value).toEqual({ kind: 'number', value: 99 });
  });

  it('restores the source value after a TEXT override is toggled off', async () => {
    seedTextMirror();
    client.seed('company', [{ id: 'c1', source: 'ACTIVE', mirror: 'PINNED' }]);
    await upsertOverride(client, 'company', 'mirror', 'c1', {
      text: JSON.stringify('PINNED'),
    });
    await deactivateOverride(client, 'company', 'mirror', 'c1');

    await handleRecordUpdate({
      client,
      objectName: 'company',
      recordId: 'c1',
      after: { id: 'c1', source: 'ACTIVE', mirror: 'PINNED' },
      updatedFields: ['source'],
    });

    expect(client.get('company', 'c1')!.mirror).toBe('ACTIVE');
  });
});

// Task 7 makes the hourly sweep time-bounded; an unstable definition order
// would then let a time-bounded sweep starve whichever definitions land late.
describe('loadEnabledFormulas ordering', () => {
  it('requests a stable id-ordered page so a time-bounded sweep cannot starve a definition', async () => {
    const client = new FakeClient();
    client.seed('formulaDefinition', [
      {
        id: 'formula-b',
        enabled: true,
        targetObject: 'opportunity',
        targetField: 'b',
      },
      {
        id: 'formula-a',
        enabled: true,
        targetObject: 'opportunity',
        targetField: 'a',
      },
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

// Write boundary (Task 6): the heartbeat dispatches on the outcome's tagged
// kind, not on a re-parse of the expression. A text-kind outcome takes the same
// lastValueText lane deployed mirrors already use.
describe('recordEvaluationHeartbeat — text-kind outcome', () => {
  const textFormula = (
    overrides: Partial<FormulaDefinitionRecord> = {},
  ): FormulaDefinitionRecord => ({
    id: 'ft',
    targetObject: 'company',
    targetField: 'invoiceCode',
    targetFieldType: 'TEXT',
    expression: '"ACME-" & invoiceNumber',
    enabled: true,
    ...overrides,
  });

  it('writes lastValueText (JSON-encoded) and leaves lastValue untouched', async () => {
    const client = new FakeClient();
    client.seed('formulaDefinition', [
      textFormula() as Record<string, unknown> & { id: string },
    ]);

    await recordEvaluationHeartbeat(
      client,
      textFormula(),
      { value: { kind: 'text', value: 'ACME-42' }, error: null },
      false,
    );

    const stored = client.get('formulaDefinition', 'ft')!;
    expect(stored.lastValueText).toBe(JSON.stringify('ACME-42'));
    expect(stored.lastValue ?? null).toBeNull();
  });

  it('performs zero writes when the text and error are unchanged', async () => {
    const client = new FakeClient();
    const formula = textFormula({ lastValueText: '"ACME-42"', lastError: '' });
    client.seed('formulaDefinition', [
      formula as Record<string, unknown> & { id: string },
    ]);
    const before = client.mutations;

    await recordEvaluationHeartbeat(
      client,
      formula,
      { value: { kind: 'text', value: 'ACME-42' }, error: null },
      false,
    );

    expect(client.mutations).toBe(before);
  });
});

// Task 5: an event pays for the SCHEMA once, not once per matched formula. The
// compile stays per definition (each has its own program); the kind map is
// object-keyed, so one union map serves every formula the event touches.
describe('handleRecordUpdate hoisted compilation and kinds (once per event)', () => {
  const seedTwoFormulas = (client: FakeClient): void => {
    client.seed('formulaDefinition', [
      {
        id: 'fa',
        targetObject: 'opportunity',
        targetField: 'scoreA',
        targetFieldType: 'NUMBER',
        expression: 'amount + 1',
        enabled: true,
      },
      {
        id: 'fb',
        targetObject: 'opportunity',
        targetField: 'scoreB',
        targetFieldType: 'NUMBER',
        expression: 'amount * 10',
        enabled: true,
      },
    ]);
    client.setFieldKinds('opportunity', {
      amount: 'NUMBER',
      scoreA: 'NUMBER',
      scoreB: 'NUMBER',
    });
    client.seed('opportunity', [
      { id: 'o1', amount: 5, scoreA: null, scoreB: null },
    ]);
  };

  const amountEvent = (client: FakeClient) =>
    handleRecordUpdate({
      client,
      objectName: 'opportunity',
      recordId: 'o1',
      after: { id: 'o1', amount: 5, scoreA: null, scoreB: null },
      updatedFields: ['amount'],
    });

  it('keeps two engine-lane formulas isolated when one event matches both', async () => {
    // A scoping error in the hoist (one `compiled` leaking across the formula
    // loop) writes formula A's result into formula B's field and surfaces NO
    // error at all — this pin is the only thing that catches it.
    const client = new FakeClient();
    seedTwoFormulas(client);

    await amountEvent(client);

    expect(client.get('opportunity', 'o1')!.scoreA).toBe(6);
    expect(client.get('opportunity', 'o1')!.scoreB).toBe(50);
  });

  it('compiles each definition exactly once for the recompute path', async () => {
    const client = new FakeClient();
    seedTwoFormulas(client);
    vi.mocked(parse).mockClear();

    await amountEvent(client);

    // 4 = 2 definitions x (1 for the runtime cycle guard, which builds its own
    // dependency graph and is not part of this hoist, + 1 for the recompute
    // path). Before the hoist the recompute path alone paid 2 per definition
    // (safeCompile, then a second compile inside computeFormulaValueForRecord).
    expect(vi.mocked(parse)).toHaveBeenCalledTimes(4);
  });

  it('resolves the field-kind map once per event, not once per formula', async () => {
    const client = new FakeClient();
    seedTwoFormulas(client);
    const real = client.fieldKinds;
    let calls = 0;
    client.fieldKinds = async (object: string): Promise<Map<string, string>> => {
      calls += 1;
      return real(object);
    };

    await amountEvent(client);

    // One object (opportunity) across both formulas -> one resolution.
    expect(calls).toBe(1);
  });

  it('resolves nothing when the event affects no formula at all', async () => {
    // Final-review efficiency finding: the kind resolution and the per-event
    // gate walks used to run on EVERY event for this object, even one touching
    // a field no definition reads and no definition targets. Both are now
    // decided from the compiled dependencies first, so this event pays neither.
    const client = new FakeClient();
    seedTwoFormulas(client);
    const real = client.fieldKinds;
    let calls = 0;
    client.fieldKinds = async (object: string): Promise<Map<string, string>> => {
      calls += 1;
      return real(object);
    };

    const outcomes = await handleRecordUpdate({
      client,
      objectName: 'opportunity',
      recordId: 'o1',
      // `description` is neither an input of either formula nor a value field.
      after: { id: 'o1', amount: 5, scoreA: null, scoreB: null },
      updatedFields: ['description'],
      actorWorkspaceMemberId: 'wm-1',
    });

    expect(calls).toBe(0);
    expect(outcomes).toHaveLength(0);
    expect(client.writes).toHaveLength(0);
  });

  it('shares one kind map between the override path and the recompute loop', async () => {
    // Both loops engage: a human edited the value field AND an input changed.
    // Before the hoist that cost 4 resolutions (one per formula per loop); now
    // the union map is resolved once and threaded into both.
    const client = new FakeClient();
    seedTwoFormulas(client);
    const real = client.fieldKinds;
    let calls = 0;
    client.fieldKinds = async (object: string): Promise<Map<string, string>> => {
      calls += 1;
      return real(object);
    };

    await handleRecordUpdate({
      client,
      objectName: 'opportunity',
      recordId: 'o1',
      after: { id: 'o1', amount: 5, scoreA: 3, scoreB: null },
      updatedFields: ['amount', 'scoreA'],
      actorWorkspaceMemberId: 'wm-1',
    });

    // 2 = the event's union map + the ONE unprefetched record read the override
    // path performs, which keeps resolving its own kinds on purpose: that call
    // THROWING is what turns a metadata failure into a per-record error instead
    // of a silently-scalar selection on a composite field.
    expect(calls).toBe(2);
  });
});

// Task 6: a definition whose kinds do not check is skipped by BOTH event loops.
// The recompute loop would write a silently-wrong value; the override loop would
// turn a human edit into a pinned row on the strength of "what would the formula
// say?" — which has no answer while the definition is broken, exactly the
// posture the OFFLINE skip already encodes.
describe('handleRecordUpdate per-definition static gate', () => {
  const seedGatedDefinition = (client: FakeClient): void => {
    client.setFieldKinds('opportunity', {
      closeDate: 'DATE',
      formulaScore: 'NUMBER',
    });
    client.seed('formulaDefinition', [
      {
        id: 'fg',
        targetObject: 'opportunity',
        targetField: 'formulaScore',
        targetFieldType: 'NUMBER',
        // The B6 legacy shape: a DATE column compared to a bare text literal.
        expression: 'IF(closeDate = "2026-01-15", 1, 0)',
        enabled: true,
      },
    ]);
  };

  it('event path skips gate-failing formulas in BOTH loops: no recompute write, no override row', async () => {
    const client = new FakeClient();
    seedGatedDefinition(client);
    client.seed('opportunity', [
      { id: 'o1', closeDate: '2026-01-15', formulaScore: 7 },
    ]);

    // Loop 1: a human edited the value field away from what the (broken)
    // formula computes — pre-gate this pinned an override row.
    const outcomes = await handleRecordUpdate({
      client,
      objectName: 'opportunity',
      recordId: 'o1',
      after: { id: 'o1', closeDate: '2026-01-15', formulaScore: 7 },
      updatedFields: ['formulaScore', 'closeDate'],
      actorWorkspaceMemberId: 'wm-1',
    });

    expect(outcomes).toHaveLength(0);
    // FakeClient.mutations is a scalar counter and cannot be filtered; the
    // filterable record of what ran is mutationSelections.
    expect(
      client.mutationSelections.filter(
        (selection) => selection.createFormulaOverride !== undefined,
      ),
    ).toHaveLength(0);
    expect(client.get('formulaOverride', 'formulaOverride-0')).toBeUndefined();

    // Loop 2: the app's own input-change event, no actor, so the override loop
    // does not run at all — pre-gate this wrote formulaScore=0 onto the record.
    await handleRecordUpdate({
      client,
      objectName: 'opportunity',
      recordId: 'o1',
      after: { id: 'o1', closeDate: '2026-01-15', formulaScore: 7 },
      updatedFields: ['closeDate'],
      actorWorkspaceMemberId: null,
    });

    expect(
      client.mutationSelections.filter(
        (selection) => selection.updateOpportunity !== undefined,
      ),
    ).toHaveLength(0);
    expect(client.writes).toHaveLength(0);
    expect(client.get('opportunity', 'o1')!.formulaScore).toBe(7);
  });

  // F4 companion: the sweep's gated TEXT-target lane rewrote lastValueText: null
  // over the '' the API returns for a NULL column, once per pass. The event path
  // must stay at zero definition writes for the same definition — it declines to
  // act at all, so it never reaches the heartbeat.
  it('event path leaves a gated TEXT-target definition row untouched', async () => {
    const client = new FakeClient();
    client.setFieldKinds('opportunity', {
      amount: 'NUMBER',
      formulaLabel: 'TEXT',
    });
    client.seed('formulaDefinition', [
      {
        id: 'ftg',
        targetObject: 'opportunity',
        targetField: 'formulaLabel',
        targetFieldType: 'TEXT',
        // Computes number onto a text target (live S5 / T4 Text Greeting).
        expression: 'amount * 2',
        enabled: true,
        // The NULL lastValueText column as the record API hands it back.
        lastValueText: '',
        lastError: 'Formula computes number but the target field holds text',
      },
    ]);
    client.seed('opportunity', [{ id: 'o1', amount: 10, formulaLabel: null }]);

    const outcomes = await handleRecordUpdate({
      client,
      objectName: 'opportunity',
      recordId: 'o1',
      after: { id: 'o1', amount: 10, formulaLabel: null },
      updatedFields: ['amount'],
    });

    expect(outcomes).toHaveLength(0);
    expect(
      client.mutationSelections.filter(
        (selection) => selection.updateFormulaDefinition !== undefined,
      ),
    ).toHaveLength(0);
    expect(client.writes).toHaveLength(0);
  });

  it('event path renders TEXT(dateField) as a date string, not the epoch-day serial', async () => {
    // Companion to the recompute-path pins: the event path resolves its own
    // kinds and runs its own gate walk, which is what stamps `renderAs`. If
    // that stamp is lost the evaluator silently falls back to 'value' and
    // writes the serial.
    const client = new FakeClient();
    client.setFieldKinds('opportunity', {
      closeDate: 'DATE',
      closeDateLabel: 'TEXT',
    });
    client.seed('formulaDefinition', [
      {
        id: 'ftd',
        targetObject: 'opportunity',
        targetField: 'closeDateLabel',
        targetFieldType: 'TEXT',
        expression: 'TEXT(closeDate)',
        enabled: true,
      },
    ]);
    client.seed('opportunity', [
      { id: 'o1', closeDate: '2026-01-15', closeDateLabel: null },
    ]);

    await handleRecordUpdate({
      client,
      objectName: 'opportunity',
      recordId: 'o1',
      after: { id: 'o1', closeDate: '2026-01-15', closeDateLabel: null },
      updatedFields: ['closeDate'],
    });

    const stored = client.get('opportunity', 'o1')!.closeDateLabel;
    expect(stored).toBe('2026-01-15');
    expect(stored).not.toMatch(/^\d+$/);
  });

  it('negative control: the same event still recomputes a PASSING definition', async () => {
    const client = new FakeClient();
    client.setFieldKinds('opportunity', {
      closeDate: 'DATE',
      formulaScore: 'NUMBER',
    });
    client.seed('formulaDefinition', [
      {
        id: 'fp',
        targetObject: 'opportunity',
        targetField: 'formulaScore',
        targetFieldType: 'NUMBER',
        expression: 'IF(closeDate = DATE("2026-01-15"), 1, 0)',
        enabled: true,
      },
    ]);
    client.seed('opportunity', [
      { id: 'o1', closeDate: '2026-01-15', formulaScore: null },
    ]);

    await handleRecordUpdate({
      client,
      objectName: 'opportunity',
      recordId: 'o1',
      after: { id: 'o1', closeDate: '2026-01-15', formulaScore: null },
      updatedFields: ['closeDate'],
    });

    expect(client.get('opportunity', 'o1')!.formulaScore).toBe(1);
  });
});
