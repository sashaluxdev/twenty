import { beforeEach, describe, expect, it } from 'vitest';

import { recomputeAllRecords } from 'src/logic-functions/lib/recompute';
import { type FormulaDefinitionRecord } from 'src/logic-functions/lib/types';
import { FakeClient } from 'src/logic-functions/lib/__tests__/fake-client';

const FORMULA: FormulaDefinitionRecord = {
  id: 'formula-1',
  targetObject: 'opportunity',
  targetField: 'score',
  targetFieldType: 'NUMBER',
  outputFormat: 'integer',
  expression: 'amount + 1',
  enabled: true,
};

const seedOpportunities = (client: FakeClient, count: number): void => {
  client.setFieldKinds('opportunity', { amount: 'NUMBER', score: 'NUMBER' });
  client.seed(
    'opportunity',
    Array.from({ length: count }, (_unused, index) => ({
      id: `opp-${String(index + 1).padStart(3, '0')}`,
      amount: index + 1,
      score: null,
    })),
  );
};

const singularReads = (client: FakeClient): unknown[] =>
  client.querySelections.filter(
    (selection) => selection.opportunity !== undefined,
  );

const pageReads = (client: FakeClient): unknown[] =>
  client.querySelections.filter(
    (selection) => selection.opportunities !== undefined,
  );

describe('recomputeAllRecords page prefetch', () => {
  let client: FakeClient;

  beforeEach(() => {
    client = new FakeClient();
  });

  it('issues no per-record read when the page carries the dependency and target fields', async () => {
    seedOpportunities(client, 5);

    const outcomes = await recomputeAllRecords(client, FORMULA, { pageSize: 2 });

    expect(outcomes).toHaveLength(5);
    expect(outcomes.every((outcome) => outcome.error === null)).toBe(true);
    // 3 pages (2 + 2 + 1), zero singular record reads.
    expect(pageReads(client)).toHaveLength(3);
    expect(singularReads(client)).toHaveLength(0);
  });

  it('still writes the correct values through the prefetched path', async () => {
    seedOpportunities(client, 3);

    await recomputeAllRecords(client, FORMULA, { pageSize: 2 });

    expect(client.get('opportunity', 'opp-001')?.score).toBe(2);
    expect(client.get('opportunity', 'opp-002')?.score).toBe(3);
    expect(client.get('opportunity', 'opp-003')?.score).toBe(4);
  });

  it('preserves scan order in the returned outcomes', async () => {
    seedOpportunities(client, 5);

    const outcomes = await recomputeAllRecords(client, FORMULA, { pageSize: 2 });

    expect(outcomes.map((outcome) => outcome.targetRecordId)).toEqual([
      'opp-001',
      'opp-002',
      'opp-003',
      'opp-004',
      'opp-005',
    ]);
  });

  it('falls back to an id-only scan when the widened page query is rejected', async () => {
    seedOpportunities(client, 3);
    // The live schema dropped `amount`: the widened page selection throws, but
    // the pass must survive and degrade to per-record reads.
    client.rejectFieldOnServer('opportunity', 'amount');

    const outcomes = await recomputeAllRecords(client, FORMULA, { pageSize: 2 });

    expect(outcomes).toHaveLength(3);
    // Every record produced an outcome; each error is isolated to its record.
    expect(outcomes.map((outcome) => outcome.targetRecordId)).toEqual([
      'opp-001',
      'opp-002',
      'opp-003',
    ]);
    expect(outcomes.every((outcome) => outcome.error !== null)).toBe(true);
    // It retried each page id-only rather than aborting.
    expect(pageReads(client).length).toBeGreaterThanOrEqual(3);
    // Per-record isolation is genuinely restored: the fallback scan hands no
    // prefetch to recomputeForRecord, so each record does its own read and each
    // read fails on its own (rather than one page failure killing the pass).
    expect(singularReads(client)).toHaveLength(3);
  });

  it('falls back to an id-only scan when the scan-selection metadata read throws', async () => {
    seedOpportunities(client, 3);
    // Building the widened selection needs field kinds. That read used to
    // happen per record (one error outcome); hoisting it must not turn a
    // metadata failure into an aborted pass.
    client.fieldKinds = async (): Promise<Map<string, string>> => {
      throw new Error('metadata unavailable');
    };

    const outcomes = await recomputeAllRecords(client, FORMULA, { pageSize: 2 });

    expect(outcomes.map((outcome) => outcome.targetRecordId)).toEqual([
      'opp-001',
      'opp-002',
      'opp-003',
    ]);
    expect(outcomes.every((outcome) => outcome.error !== null)).toBe(true);
  });

  it('scans id-only without per-record regression when the expression does not parse', async () => {
    seedOpportunities(client, 2);

    const outcomes = await recomputeAllRecords(
      client,
      { ...FORMULA, expression: '((' },
      { pageSize: 10 },
    );

    expect(outcomes).toHaveLength(2);
    expect(outcomes.every((outcome) => outcome.error !== null)).toBe(true);
  });
});
