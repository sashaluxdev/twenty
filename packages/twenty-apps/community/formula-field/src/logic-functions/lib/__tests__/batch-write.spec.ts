import { beforeEach, describe, expect, it } from 'vitest';

import { flushBatchedWrites } from 'src/logic-functions/lib/batch-write';
import { FakeClient } from 'src/logic-functions/lib/__tests__/fake-client';

describe('flushBatchedWrites', () => {
  let client: FakeClient;

  beforeEach(() => {
    client = new FakeClient();
    client.setFieldKinds('opportunity', { score: 'NUMBER' });
    client.seed(
      'opportunity',
      Array.from({ length: 5 }, (_unused, index) => ({
        id: `opp-${index + 1}`,
        score: null,
      })),
    );
  });

  it('issues one mutation per distinct payload, not one per record', async () => {
    const failures = await flushBatchedWrites(client, 'opportunity', [
      { recordId: 'opp-1', data: { score: 1 } },
      { recordId: 'opp-2', data: { score: 1 } },
      { recordId: 'opp-3', data: { score: 1 } },
      { recordId: 'opp-4', data: { score: 2 } },
      { recordId: 'opp-5', data: { score: 2 } },
    ]);

    expect(failures).toEqual([]);
    expect(client.mutations).toBe(2);
    expect(client.get('opportunity', 'opp-3')?.score).toBe(1);
    expect(client.get('opportunity', 'opp-5')?.score).toBe(2);
  });

  it('chunks a group larger than the mutation cap', async () => {
    client.seed(
      'opportunity',
      Array.from({ length: 250 }, (_unused, index) => ({
        id: `bulk-${String(index).padStart(3, '0')}`,
        score: null,
      })),
    );
    const writes = Array.from({ length: 250 }, (_unused, index) => ({
      recordId: `bulk-${String(index).padStart(3, '0')}`,
      data: { score: 7 },
    }));

    await flushBatchedWrites(client, 'opportunity', writes);

    // 250 records / 100 per chunk = 3 mutations.
    expect(client.mutations).toBe(3);
    expect(client.get('opportunity', 'bulk-249')?.score).toBe(7);
  });

  it('falls back to per-record writes when a batch mutation fails', async () => {
    client.failMutationsFor('updateOpportunities', new Error('batch rejected'));

    const failures = await flushBatchedWrites(client, 'opportunity', [
      { recordId: 'opp-1', data: { score: 1 } },
      { recordId: 'opp-2', data: { score: 1 } },
    ]);

    // Batch failed, both records still written individually.
    expect(failures).toEqual([]);
    expect(client.get('opportunity', 'opp-1')?.score).toBe(1);
    expect(client.get('opportunity', 'opp-2')?.score).toBe(1);
  });

  it('reports only the records whose individual write also fails', async () => {
    client.failMutationsFor('updateOpportunities', new Error('batch rejected'));
    client.failMutationsFor('updateOpportunity', new Error('single rejected'));

    const failures = await flushBatchedWrites(client, 'opportunity', [
      { recordId: 'opp-1', data: { score: 1 } },
    ]);

    expect(failures).toHaveLength(1);
    expect(failures[0].recordId).toBe('opp-1');
    expect(failures[0].error).toContain('single rejected');
  });

  it('does nothing when there is nothing to write', async () => {
    const failures = await flushBatchedWrites(client, 'opportunity', []);

    expect(failures).toEqual([]);
    expect(client.mutations).toBe(0);
  });
});
