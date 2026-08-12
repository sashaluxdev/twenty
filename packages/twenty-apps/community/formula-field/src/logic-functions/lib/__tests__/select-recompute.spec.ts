import { afterEach, describe, expect, it, vi } from 'vitest';

import { FakeClient } from 'src/logic-functions/lib/__tests__/fake-client';
import {
  __setFakeObjectsWithFieldsForTests,
  targetFieldOptions,
} from 'src/logic-functions/lib/metadata-objects';
import {
  recomputeAllRecords,
  recomputeForRecord,
} from 'src/logic-functions/lib/recompute';
import { type FormulaDefinitionRecord } from 'src/logic-functions/lib/types';

// Pass-through spy so the once-per-pass hoist is observable (same seam pattern
// as recompute.spec.ts's parse counter).
vi.mock('src/logic-functions/lib/metadata-objects', async (importActual) => {
  const actual =
    await importActual<typeof import('src/logic-functions/lib/metadata-objects')>();
  return { ...actual, targetFieldOptions: vi.fn(actual.targetFieldOptions) };
});

const seedMetadata = (values: string[]) => {
  __setFakeObjectsWithFieldsForTests([
    {
      id: 'obj-opportunity',
      nameSingular: 'opportunity',
      labelIdentifierFieldMetadataId: null,
      fields: [
        {
          id: 'field-stage',
          name: 'formulaStage',
          type: 'SELECT',
          isActive: true,
          isSystem: false,
          options: values.map((value, index) => ({
            id: `opt-${index}`,
            value,
            label: value,
            color: 'green',
            position: index,
          })),
        },
      ],
    },
  ]);
};

const selectFormula = (
  expression: string,
  extra: Partial<FormulaDefinitionRecord> = {},
): FormulaDefinitionRecord => ({
  id: 'fs1',
  targetObject: 'opportunity',
  targetField: 'formulaStage',
  targetFieldType: 'SELECT',
  outputFormat: 'select',
  expression,
  enabled: true,
  ...extra,
});

const seedRecords = (
  client: FakeClient,
  records: Array<Record<string, unknown>>,
) => {
  client.setFieldKinds('opportunity', {
    amount: 'NUMBER',
    stage: 'SELECT',
    formulaStage: 'SELECT',
  });
  client.seed('opportunity', records);
};

afterEach(() => {
  __setFakeObjectsWithFieldsForTests(null);
  vi.clearAllMocks();
});

describe('SELECT sweep (ADR 0029)', () => {
  it('writes the computed option value on the engine lane', async () => {
    seedMetadata(['HOT', 'COLD']);
    const client = new FakeClient();
    seedRecords(client, [
      { id: 'o1', amount: 200, formulaStage: null },
      { id: 'o2', amount: 5, formulaStage: null },
    ]);

    await recomputeAllRecords(
      client,
      selectFormula('IF(amount > 100, "HOT", "COLD")'),
    );

    expect(client.get('opportunity', 'o1')!.formulaStage).toBe('HOT');
    expect(client.get('opportunity', 'o2')!.formulaStage).toBe('COLD');
  });

  it('resolves the option set once per pass, not per record', async () => {
    seedMetadata(['HOT', 'COLD']);
    const client = new FakeClient();
    seedRecords(client, [
      { id: 'o1', amount: 200, formulaStage: null },
      { id: 'o2', amount: 5, formulaStage: null },
      { id: 'o3', amount: 50, formulaStage: null },
    ]);

    await recomputeAllRecords(
      client,
      selectFormula('IF(amount > 100, "HOT", "COLD")'),
    );

    expect(vi.mocked(targetFieldOptions)).toHaveBeenCalledTimes(1);
  });

  it('option drift freezes the whole definition: zero scans, zero writes', async () => {
    seedMetadata(['HOT']); // COLD was deleted natively
    const client = new FakeClient();
    seedRecords(client, [{ id: 'o1', amount: 200, formulaStage: 'HOT' }]);

    const outcomes = await recomputeAllRecords(
      client,
      selectFormula('IF(amount > 100, "HOT", "COLD")'),
    );

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].targetRecordId).toBe('');
    expect(outcomes[0].error).toMatch(/can produce "COLD"/);
    expect(client.querySelections).toHaveLength(0);
    expect(client.writes).toHaveLength(0);
  });

  it('tier 2: an open-set non-member errors per record and keeps the last value', async () => {
    seedMetadata(['HOT', 'COLD']);
    const client = new FakeClient();
    seedRecords(client, [{ id: 'o1', stage: 'WARM', formulaStage: 'HOT' }]);

    const outcomes = await recomputeAllRecords(client, selectFormula('stage'));

    expect(outcomes[0].error).toBe(
      'NOT_AN_OPTION: "WARM" is not an option of formulaStage',
    );
    expect(outcomes[0].changed).toBe(false);
    expect(client.get('opportunity', 'o1')!.formulaStage).toBe('HOT');
    expect(client.writes).toHaveLength(0);
  });

  it('blank computed text clears the field; an already-null target converges without a write', async () => {
    seedMetadata(['HOT']);
    const client = new FakeClient();
    seedRecords(client, [
      { id: 'o1', amount: 5, formulaStage: 'HOT' },
      { id: 'o2', amount: 5, formulaStage: null },
    ]);

    await recomputeAllRecords(client, selectFormula('IF(amount > 100, "HOT", "")'));

    expect(client.get('opportunity', 'o1')!.formulaStage).toBeNull();
    expect(client.writes).toHaveLength(1);
  });

  it('a non-member never poisons the page batch (mixed page, one write)', async () => {
    seedMetadata(['HOT', 'COLD']);
    const client = new FakeClient();
    seedRecords(client, [
      { id: 'o1', stage: 'HOT', formulaStage: null },
      { id: 'o2', stage: 'WARM', formulaStage: null },
    ]);

    const outcomes = await recomputeAllRecords(client, selectFormula('stage'));

    // o1 writes through; o2's NOT_AN_OPTION never reaches the batch, so
    // flushBatchedWrites never falls back to its per-record retry path.
    expect(client.get('opportunity', 'o1')!.formulaStage).toBe('HOT');
    expect(client.get('opportunity', 'o2')!.formulaStage).toBeNull();
    expect(client.writes).toHaveLength(1);
    const errored = outcomes.find((outcome) => outcome.targetRecordId === 'o2');
    expect(errored?.error).toMatch(/NOT_AN_OPTION/);
  });

  it('a deployed SELECT mirror (bare ref, outputFormat "mirror") converges on the engine lane', async () => {
    seedMetadata(['HOT']);
    const client = new FakeClient();
    seedRecords(client, [{ id: 'o1', stage: 'HOT', formulaStage: 'HOT' }]);

    const outcomes = await recomputeAllRecords(
      client,
      selectFormula('stage', { outputFormat: 'mirror' }),
    );

    expect(outcomes[0].changed).toBe(false);
    expect(client.writes).toHaveLength(0);
  });
});

describe('recomputeForRecord SELECT fallback (ADR 0029)', () => {
  it('a direct call without threaded options still gates — it resolves its own', async () => {
    seedMetadata(['HOT']);
    const client = new FakeClient();
    seedRecords(client, [{ id: 'o1', amount: 200, formulaStage: null }]);

    const outcome = await recomputeForRecord({
      client,
      formula: selectFormula('IF(amount > 100, "HOT", "COLD")'),
      targetRecordId: 'o1',
    });

    expect(outcome.error).toMatch(/can produce "COLD"/);
    expect(outcome.changed).toBe(false);
    expect(client.writes).toHaveLength(0);
  });

  it('unresolvable options skip the gates and write through', async () => {
    __setFakeObjectsWithFieldsForTests([]); // degraded metadata: no objects
    const client = new FakeClient();
    seedRecords(client, [{ id: 'o1', amount: 200, formulaStage: null }]);

    const outcome = await recomputeForRecord({
      client,
      formula: selectFormula('IF(amount > 100, "HOT", "COLD")'),
      targetRecordId: 'o1',
    });

    expect(outcome.error).toBeNull();
    expect(client.get('opportunity', 'o1')!.formulaStage).toBe('HOT');
  });
});
