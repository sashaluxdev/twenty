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

  it('degrades mid-scan: page 1 prefetches correct values, page 2 rejected falls back per-record', async () => {
    seedOpportunities(client, 4);

    // Page 1 runs widened and prefetches records 1-2 with correct values. Only
    // AFTER that first page is served do we drop `amount` from the live schema,
    // so page 2's widened selection is rejected mid-scan. This is the only shape
    // where a stale prefetch flag could write WRONG values instead of erroring —
    // the flag must clear so records 3-4 take the id-only per-record path.
    const originalQuery = client.query.bind(client);
    let servedPages = 0;
    client.query = async (selection: Record<string, unknown>) => {
      const result = await originalQuery(selection);
      if (selection.opportunities !== undefined) {
        servedPages += 1;
        if (servedPages === 1) {
          client.rejectFieldOnServer('opportunity', 'amount');
        }
      }
      return result;
    };

    const outcomes = await recomputeAllRecords(client, FORMULA, { pageSize: 2 });

    const byId = new Map(outcomes.map((outcome) => [outcome.targetRecordId, outcome]));

    // Records 1-2: prefetched from the widened page 1, correct computed values,
    // no error outcomes, and the writes landed.
    expect(byId.get('opp-001')?.error).toBeNull();
    expect(byId.get('opp-002')?.error).toBeNull();
    expect(byId.get('opp-001')?.value).toBe(2);
    expect(byId.get('opp-002')?.value).toBe(3);
    expect(client.get('opportunity', 'opp-001')?.score).toBe(2);
    expect(client.get('opportunity', 'opp-002')?.score).toBe(3);

    // Records 3-4: page 2 was rejected mid-scan, so each falls back to its own
    // id-only per-record fetch, which surfaces the dropped field one at a time.
    expect(byId.get('opp-003')?.error).not.toBeNull();
    expect(byId.get('opp-004')?.error).not.toBeNull();

    // Per-record reads happened ONLY for the fallback page (records 3-4), never
    // for the prefetched records 1-2.
    expect(singularReads(client)).toHaveLength(2);
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

  it('writes a whole page through batched mutations instead of one per record', async () => {
    seedOpportunities(client, 5);
    // All five compute distinct values, so grouping cannot collapse them; the
    // page still flushes as 5 grouped mutations, not 5 singular ones.
    await recomputeAllRecords(client, FORMULA, { pageSize: 5 });

    const singularWrites = client.mutationSelections.filter(
      (selection) => selection.updateOpportunity !== undefined,
    );
    expect(singularWrites).toHaveLength(0);
    expect(client.get('opportunity', 'opp-005')?.score).toBe(6);
  });

  it('collapses a page of identical values into a single mutation', async () => {
    client.setFieldKinds('opportunity', { amount: 'NUMBER', score: 'NUMBER' });
    client.seed(
      'opportunity',
      Array.from({ length: 5 }, (_unused, index) => ({
        id: `flat-${index + 1}`,
        amount: 10,
        score: null,
      })),
    );

    await recomputeAllRecords(client, FORMULA, { pageSize: 10 });

    const batchWrites = client.mutationSelections.filter(
      (selection) => selection.updateOpportunities !== undefined,
    );
    expect(batchWrites).toHaveLength(1);
  });
});
