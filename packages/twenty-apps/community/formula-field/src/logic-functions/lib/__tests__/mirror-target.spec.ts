import { beforeEach, describe, expect, it } from 'vitest';

import {
  ENGINE_FAMILY_KINDS,
} from 'src/logic-functions/lib/mirror-kinds';
import { deepJsonEqual } from 'src/logic-functions/lib/deep-equal';
import {
  computeMirrorValueForRecord,
  recomputeAllRecords,
  recomputeForRecord,
} from 'src/logic-functions/lib/recompute';
import { recordEvaluationHeartbeat } from 'src/logic-functions/lib/formula-repository';
import { ENGINE_FAMILY } from 'src/logic-functions/lib/value-io';
import { type FormulaDefinitionRecord } from 'src/logic-functions/lib/types';
import { FakeClient } from 'src/logic-functions/lib/__tests__/fake-client';

// Mirror-mode recompute (design 2026-07-06): a bare whole-field ref onto a
// non-engine target kind copies the source field's raw value onto the target
// verbatim — no coercion, no engine involvement.

const mirrorFormula = (
  overrides: Partial<FormulaDefinitionRecord> = {},
): FormulaDefinitionRecord => ({
  id: 'f1',
  targetObject: 'company',
  targetField: 'mirror',
  targetFieldType: 'SELECT',
  expression: 'source',
  enabled: true,
  ...overrides,
});

describe('deepJsonEqual', () => {
  it('treats null and undefined as equal (both nullish)', () => {
    expect(deepJsonEqual(null, undefined)).toBe(true);
    expect(deepJsonEqual(undefined, null)).toBe(true);
    expect(deepJsonEqual(null, null)).toBe(true);
    expect(deepJsonEqual(undefined, undefined)).toBe(true);
  });

  it('treats a nullish value as unequal to a concrete value', () => {
    expect(deepJsonEqual(null, 0)).toBe(false);
    expect(deepJsonEqual(null, '')).toBe(false);
    expect(deepJsonEqual(undefined, {})).toBe(false);
  });

  it('compares scalars by value and type', () => {
    expect(deepJsonEqual('a', 'a')).toBe(true);
    expect(deepJsonEqual(1, 1)).toBe(true);
    expect(deepJsonEqual(true, true)).toBe(true);
    expect(deepJsonEqual('1', 1)).toBe(false);
    expect(deepJsonEqual(1, 2)).toBe(false);
  });

  it('is insensitive to object key order', () => {
    expect(deepJsonEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(
      deepJsonEqual(
        { primaryLinkUrl: 'u', primaryLinkLabel: 'l', secondaryLinks: [] },
        { secondaryLinks: [], primaryLinkLabel: 'l', primaryLinkUrl: 'u' },
      ),
    ).toBe(true);
  });

  it('is order-sensitive for arrays', () => {
    expect(deepJsonEqual([1, 2, 3], [1, 2, 3])).toBe(true);
    expect(deepJsonEqual([1, 2, 3], [3, 2, 1])).toBe(false);
    expect(deepJsonEqual([1, 2], [1, 2, 3])).toBe(false);
  });

  it('recurses into nested composites', () => {
    expect(
      deepJsonEqual({ a: { b: [1, { c: 2 }] } }, { a: { b: [1, { c: 2 }] } }),
    ).toBe(true);
    expect(
      deepJsonEqual({ a: { b: [1, { c: 2 }] } }, { a: { b: [1, { c: 3 }] } }),
    ).toBe(false);
  });

  it('distinguishes arrays from objects', () => {
    expect(deepJsonEqual([], {})).toBe(false);
  });

  // Depth cap (containment for user-writable RAW_JSON): the cap is 256 levels.
  const nestObject = (depth: number): unknown => {
    let value: unknown = 'leaf';
    for (let index = 0; index < depth; index += 1) {
      value = { next: value };
    }
    return value;
  };

  it('compares equal values nested at the depth cap as equal', () => {
    // The fence is exactly 256: the leaf of a 256-deep nest compares as a scalar
    // at depth 256 (scalars are compared before the depth gate), so it stays equal.
    expect(deepJsonEqual(nestObject(256), nestObject(256))).toBe(true);
  });

  it('treats values nested one past the depth cap as changed without throwing', () => {
    // 257 levels: the 256th object hits the depth gate (depth >= 256) and returns
    // false, so a structurally identical but too-deep value compares unequal
    // (losing only no-op suppression) instead of a RangeError.
    expect(deepJsonEqual(nestObject(257), nestObject(257))).toBe(false);
  });
});

// Drift-guard (FM Task 1 rider): value-io's ENGINE_FAMILY is the single source of
// truth; mirror-kinds' ENGINE_FAMILY_KINDS must be derived from it and never drift.
describe('ENGINE_FAMILY drift guard', () => {
  it('mirror-kinds ENGINE_FAMILY_KINDS equals value-io ENGINE_FAMILY', () => {
    expect([...ENGINE_FAMILY_KINDS].sort()).toEqual([...ENGINE_FAMILY].sort());
  });
});

describe('mirror recompute passthrough — scalar kinds', () => {
  let client: FakeClient;

  beforeEach(() => {
    client = new FakeClient();
    client.setFieldKinds('company', { source: 'SELECT', mirror: 'SELECT' });
  });

  it('copies a SELECT string verbatim', async () => {
    client.seed('company', [{ id: 'c1', source: 'ACTIVE', mirror: null }]);

    const outcome = await recomputeForRecord({
      client,
      formula: mirrorFormula(),
      targetRecordId: 'c1',
    });

    expect(outcome.changed).toBe(true);
    expect(outcome.rawValue).toBe('ACTIVE');
    // Mirrors carry text in the heartbeat, so the numeric outcome value is null.
    expect(outcome.value).toBeNull();
    expect(client.get('company', 'c1')!.mirror).toBe('ACTIVE');
    expect(client.writes).toEqual(['company:c1:mirror="ACTIVE"']);
  });

  it('copies a TEXT string verbatim', async () => {
    client.setFieldKinds('company', { source: 'TEXT', mirror: 'TEXT' });
    client.seed('company', [{ id: 'c1', source: 'hello world', mirror: null }]);

    const outcome = await recomputeForRecord({
      client,
      formula: mirrorFormula({ targetFieldType: 'TEXT' }),
      targetRecordId: 'c1',
    });

    expect(outcome.changed).toBe(true);
    expect(client.get('company', 'c1')!.mirror).toBe('hello world');
  });

  it('copies a BOOLEAN verbatim', async () => {
    client.setFieldKinds('company', { source: 'BOOLEAN', mirror: 'BOOLEAN' });
    client.seed('company', [{ id: 'c1', source: true, mirror: null }]);

    const outcome = await recomputeForRecord({
      client,
      formula: mirrorFormula({ targetFieldType: 'BOOLEAN' }),
      targetRecordId: 'c1',
    });

    expect(outcome.changed).toBe(true);
    expect(client.get('company', 'c1')!.mirror).toBe(true);
  });

  it('copies a RATING number verbatim', async () => {
    client.setFieldKinds('company', { source: 'RATING', mirror: 'RATING' });
    client.seed('company', [{ id: 'c1', source: 4, mirror: null }]);

    const outcome = await recomputeForRecord({
      client,
      formula: mirrorFormula({ targetFieldType: 'RATING' }),
      targetRecordId: 'c1',
    });

    expect(outcome.changed).toBe(true);
    expect(client.get('company', 'c1')!.mirror).toBe(4);
  });

  it('copies a MULTI_SELECT array verbatim', async () => {
    client.setFieldKinds('company', {
      source: 'MULTI_SELECT',
      mirror: 'MULTI_SELECT',
    });
    client.seed('company', [{ id: 'c1', source: ['A', 'B'], mirror: null }]);

    const outcome = await recomputeForRecord({
      client,
      formula: mirrorFormula({ targetFieldType: 'MULTI_SELECT' }),
      targetRecordId: 'c1',
    });

    expect(outcome.changed).toBe(true);
    expect(client.get('company', 'c1')!.mirror).toEqual(['A', 'B']);
  });
});

describe('mirror recompute passthrough — composite kinds', () => {
  let client: FakeClient;

  beforeEach(() => {
    client = new FakeClient();
  });

  it('copies a LINKS composite verbatim and sub-selects it', async () => {
    client.setFieldKinds('company', { source: 'LINKS', mirror: 'LINKS' });
    const links = {
      primaryLinkLabel: 'Site',
      primaryLinkUrl: 'https://x.test',
      secondaryLinks: [{ label: 'Docs', url: 'https://docs.test' }],
    };
    client.seed('company', [{ id: 'c1', source: links, mirror: null }]);

    const outcome = await recomputeForRecord({
      client,
      formula: mirrorFormula({ targetFieldType: 'LINKS' }),
      targetRecordId: 'c1',
    });

    expect(outcome.changed).toBe(true);
    expect(client.get('company', 'c1')!.mirror).toEqual(links);

    const recordQuery = client.querySelections.find((s) => s.company);
    expect(recordQuery.company.source).toEqual({
      primaryLinkLabel: true,
      primaryLinkUrl: true,
      secondaryLinks: true,
    });
    expect(recordQuery.company.mirror).toEqual({
      primaryLinkLabel: true,
      primaryLinkUrl: true,
      secondaryLinks: true,
    });
  });

  it('copies a FULL_NAME composite verbatim and sub-selects it', async () => {
    client.setFieldKinds('company', {
      source: 'FULL_NAME',
      mirror: 'FULL_NAME',
    });
    const name = { firstName: 'Ada', lastName: 'Lovelace' };
    client.seed('company', [{ id: 'c1', source: name, mirror: null }]);

    const outcome = await recomputeForRecord({
      client,
      formula: mirrorFormula({ targetFieldType: 'FULL_NAME' }),
      targetRecordId: 'c1',
    });

    expect(outcome.changed).toBe(true);
    expect(client.get('company', 'c1')!.mirror).toEqual(name);

    const recordQuery = client.querySelections.find((s) => s.company);
    expect(recordQuery.company.source).toEqual({
      firstName: true,
      lastName: true,
    });
  });

  it('copies a RAW_JSON nested object verbatim', async () => {
    client.setFieldKinds('company', { source: 'RAW_JSON', mirror: 'RAW_JSON' });
    const json = { a: { b: [1, 2, 3] }, c: 'x' };
    client.seed('company', [{ id: 'c1', source: json, mirror: null }]);

    const outcome = await recomputeForRecord({
      client,
      formula: mirrorFormula({ targetFieldType: 'RAW_JSON' }),
      targetRecordId: 'c1',
    });

    expect(outcome.changed).toBe(true);
    expect(client.get('company', 'c1')!.mirror).toEqual(json);
  });
});

describe('mirror recompute — no-op suppression and null handling', () => {
  let client: FakeClient;

  beforeEach(() => {
    client = new FakeClient();
  });

  it('suppresses the write when a key-shuffled composite already matches', async () => {
    client.setFieldKinds('company', { source: 'LINKS', mirror: 'LINKS' });
    client.seed('company', [
      {
        id: 'c1',
        source: {
          primaryLinkLabel: 'Site',
          primaryLinkUrl: 'https://x.test',
          secondaryLinks: [],
        },
        // Same content, different key order — deep-equal must suppress.
        mirror: {
          secondaryLinks: [],
          primaryLinkUrl: 'https://x.test',
          primaryLinkLabel: 'Site',
        },
      },
    ]);

    const outcome = await recomputeForRecord({
      client,
      formula: mirrorFormula({ targetFieldType: 'LINKS' }),
      targetRecordId: 'c1',
    });

    expect(outcome.changed).toBe(false);
    expect(client.writes).toHaveLength(0);
  });

  it('writes exactly once on a value change, verbatim', async () => {
    client.setFieldKinds('company', { source: 'SELECT', mirror: 'SELECT' });
    client.seed('company', [{ id: 'c1', source: 'NEW', mirror: 'OLD' }]);

    const outcome = await recomputeForRecord({
      client,
      formula: mirrorFormula(),
      targetRecordId: 'c1',
    });

    expect(outcome.changed).toBe(true);
    expect(client.writes).toEqual(['company:c1:mirror="NEW"']);
  });

  it('writes null once when the source is null, then no-ops', async () => {
    client.setFieldKinds('company', { source: 'SELECT', mirror: 'SELECT' });
    client.seed('company', [{ id: 'c1', source: null, mirror: 'OLD' }]);

    const first = await recomputeForRecord({
      client,
      formula: mirrorFormula(),
      targetRecordId: 'c1',
    });
    expect(first.changed).toBe(true);
    expect(client.get('company', 'c1')!.mirror).toBeNull();
    expect(client.writes).toEqual(['company:c1:mirror=null']);

    const second = await recomputeForRecord({
      client,
      formula: mirrorFormula(),
      targetRecordId: 'c1',
    });
    expect(second.changed).toBe(false);
    expect(client.writes).toHaveLength(1);
  });

  it('fails visibly when the source field kind cannot be resolved', async () => {
    // No fieldKinds registered for the source -> fail-visible, not silent-wrong.
    client.seed('company', [{ id: 'c1', source: 'ACTIVE', mirror: null }]);

    const outcome = await recomputeForRecord({
      client,
      formula: mirrorFormula(),
      targetRecordId: 'c1',
    });

    expect(outcome.changed).toBe(false);
    expect(outcome.error).toContain('source');
    expect(client.writes).toHaveLength(0);
  });
});

describe('mirror recompute — cross-record', () => {
  let client: FakeClient;
  const sourceId = '440efe8c-f140-4fbc-99e6-9267344451b1';

  beforeEach(() => {
    client = new FakeClient();
    client.setFieldKinds('company', { status: 'SELECT' });
    client.setFieldKinds('opportunity', { mirror: 'SELECT' });
  });

  it('copies a cross-referenced source value verbatim', async () => {
    client.seed('company', [{ id: sourceId, status: 'WON' }]);
    client.seed('opportunity', [{ id: 'o1', mirror: null }]);

    const outcome = await recomputeForRecord({
      client,
      formula: mirrorFormula({
        targetObject: 'opportunity',
        expression: `[company:${sourceId}:status]`,
      }),
      targetRecordId: 'o1',
    });

    expect(outcome.changed).toBe(true);
    expect(client.get('opportunity', 'o1')!.mirror).toBe('WON');
  });

  it('treats a missing cross record as null with no error', async () => {
    client.seed('opportunity', [{ id: 'o1', mirror: 'STALE' }]);

    const outcome = await recomputeForRecord({
      client,
      formula: mirrorFormula({
        targetObject: 'opportunity',
        expression: `[company:${sourceId}:status]`,
      }),
      targetRecordId: 'o1',
    });

    expect(outcome.error).toBeNull();
    expect(outcome.rawValue).toBeNull();
    expect(client.get('opportunity', 'o1')!.mirror).toBeNull();
  });
});

describe('computeMirrorValueForRecord', () => {
  it('returns the source raw value and the target record', async () => {
    const client = new FakeClient();
    client.setFieldKinds('company', { source: 'SELECT', mirror: 'SELECT' });
    client.seed('company', [{ id: 'c1', source: 'ACTIVE', mirror: 'OLD' }]);

    const result = await computeMirrorValueForRecord({
      client,
      formula: mirrorFormula(),
      targetRecordId: 'c1',
    });

    expect(result.error).toBeNull();
    expect(result.rawValue).toBe('ACTIVE');
    expect(result.sameRecord).not.toBeNull();
  });
});

describe('mirror heartbeat — lastValueText', () => {
  let client: FakeClient;

  beforeEach(() => {
    client = new FakeClient();
    client.seed('formulaDefinition', [
      mirrorFormula() as Record<string, unknown> & { id: string },
    ]);
  });

  it('writes lastValueText on a value change', async () => {
    await recordEvaluationHeartbeat(
      client,
      mirrorFormula(),
      { value: null, error: null, rawValue: { firstName: 'Ada' } },
      false,
    );

    expect(client.get('formulaDefinition', 'f1')!.lastValueText).toBe(
      JSON.stringify({ firstName: 'Ada' }),
    );
    expect(client.get('formulaDefinition', 'f1')!.lastValue ?? null).toBeNull();
  });

  it('truncates lastValueText at 500 characters', async () => {
    const long = 'x'.repeat(600);
    await recordEvaluationHeartbeat(
      client,
      mirrorFormula(),
      { value: null, error: null, rawValue: long },
      false,
    );

    const text = client.get('formulaDefinition', 'f1')!.lastValueText as string;
    expect(text).toHaveLength(500);
  });

  it('writes null lastValueText for a null source', async () => {
    await recordEvaluationHeartbeat(
      client,
      mirrorFormula(),
      { value: null, error: null, rawValue: null },
      false,
    );

    expect(client.get('formulaDefinition', 'f1')!.lastValueText ?? null).toBeNull();
  });

  it('performs zero writes when text and error are unchanged', async () => {
    const formula = mirrorFormula({ lastValueText: '"ACTIVE"', lastError: '' });
    client.seed('formulaDefinition', [
      formula as Record<string, unknown> & { id: string },
    ]);
    const before = client.mutations;

    await recordEvaluationHeartbeat(
      client,
      formula,
      { value: null, error: null, rawValue: 'ACTIVE' },
      false,
    );

    expect(client.mutations).toBe(before);
  });
});

describe('mirror heartbeat via recomputeAllRecords', () => {
  it('populates lastValueText from a representative record', async () => {
    const client = new FakeClient();
    client.setFieldKinds('company', { source: 'SELECT', mirror: 'SELECT' });
    client.seed('company', [{ id: 'c1', source: 'ACTIVE', mirror: null }]);
    client.seed('formulaDefinition', [
      mirrorFormula() as Record<string, unknown> & { id: string },
    ]);

    await recomputeAllRecords(client, mirrorFormula());

    expect(client.get('formulaDefinition', 'f1')!.lastValueText).toBe(
      JSON.stringify('ACTIVE'),
    );
  });

  it('degrades an unserializable mirror value to a marker in lastValueText', async () => {
    const client = new FakeClient();
    client.seed('formulaDefinition', [
      mirrorFormula() as Record<string, unknown> & { id: string },
    ]);

    const circular: Record<string, unknown> = {};
    circular.self = circular;

    await recordEvaluationHeartbeat(
      client,
      mirrorFormula(),
      { value: null, error: null, rawValue: circular },
      false,
    );

    expect(client.get('formulaDefinition', 'f1')!.lastValueText).toBe(
      '[unserializable]',
    );
  });
});

describe('recomputeAllRecords per-record fault isolation', () => {
  it('contains a thrown error to one record and completes the sweep', async () => {
    const client = new FakeClient();
    client.setFieldKinds('company', { source: 'RAW_JSON', mirror: 'RAW_JSON' });
    client.seed('company', [
      { id: 'c1', source: { ok: 1 }, mirror: null },
      { id: 'c2', source: { poison: true }, mirror: null },
      { id: 'c3', source: { ok: 3 }, mirror: null },
    ]);
    client.seed('formulaDefinition', [
      mirrorFormula({ targetFieldType: 'RAW_JSON' }) as Record<string, unknown> & {
        id: string;
      },
    ]);

    // The mirror path resolves the source field kind exactly once per record, so
    // throwing on the 2nd resolution poisons the 2nd record (c2) mid-sweep —
    // standing in for a RangeError escaping recomputeForRecord.
    const realFieldKinds = client.fieldKinds;
    let resolveCount = 0;
    client.fieldKinds = async (object: string): Promise<Map<string, string>> => {
      resolveCount += 1;
      if (resolveCount === 2) {
        throw new RangeError('Maximum call stack size exceeded');
      }
      return realFieldKinds(object);
    };

    const outcomes = await recomputeAllRecords(
      client,
      mirrorFormula({ targetFieldType: 'RAW_JSON' }),
    );

    // Every record produced an outcome — the poisoned one did not abort the sweep.
    expect(outcomes.map((outcome) => outcome.targetRecordId)).toEqual([
      'c1',
      'c2',
      'c3',
    ]);
    expect(outcomes.filter((outcome) => outcome.error).length).toBe(1);
    const poisoned = outcomes.find((outcome) => outcome.targetRecordId === 'c2')!;
    expect(poisoned.error).toContain('RangeError');
    // The other records still wrote their mirror value.
    expect(client.get('company', 'c1')!.mirror).toEqual({ ok: 1 });
    expect(client.get('company', 'c3')!.mirror).toEqual({ ok: 3 });
    // The heartbeat still ran afterwards with the accumulated outcomes.
    expect(client.get('formulaDefinition', 'f1')!.lastEvaluatedAt).toBeDefined();
  });
});
