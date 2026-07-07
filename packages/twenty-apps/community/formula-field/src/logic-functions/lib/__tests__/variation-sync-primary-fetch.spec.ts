import { beforeEach, describe, expect, it } from 'vitest';

import { serializeArgumentValue } from 'src/logic-functions/lib/dynamic-client';
import { fetchPrimaryRecordInclTrashed } from 'src/logic-functions/lib/variation-sync';
import { FakeClient } from 'src/logic-functions/lib/__tests__/fake-client';

describe('fetchPrimaryRecordInclTrashed', () => {
  let client: FakeClient;

  beforeEach(() => {
    client = new FakeClient();
  });

  it('returns a live primary as not frozen', async () => {
    client.seed('company', [
      { id: 'p1', name: 'Acme', employees: 42, primaryRecordId: null },
    ]);

    const result = await fetchPrimaryRecordInclTrashed(
      client,
      'company',
      'p1',
      ['name', 'employees'],
      {},
      'primaryRecord',
    );

    expect(result.frozen).toBe(false);
    expect(result.record?.id).toBe('p1');
  });

  it('returns a trashed primary as frozen', async () => {
    client.seed('company', [
      {
        id: 'p1',
        name: 'Acme',
        employees: 42,
        primaryRecordId: null,
        deletedAt: '2026-07-07T00:00:00.000Z',
      },
    ]);

    const result = await fetchPrimaryRecordInclTrashed(
      client,
      'company',
      'p1',
      ['name', 'employees'],
      {},
      'primaryRecord',
    );

    expect(result.frozen).toBe(true);
    expect(result.record?.id).toBe('p1');
  });

  it('returns null/frozen when the primary was destroyed', async () => {
    // The object exists in the store but the target id is absent (hard-deleted).
    client.seed('company', [
      { id: 'other', name: 'Other', primaryRecordId: null },
    ]);

    const result = await fetchPrimaryRecordInclTrashed(
      client,
      'company',
      'missing',
      ['name'],
      {},
      'primaryRecord',
    );

    expect(result.record).toBeNull();
    expect(result.frozen).toBe(true);
  });

  it('emits the server-valid deletedAt OR filter (durable serialization guard)', async () => {
    client.seed('company', [
      { id: 'p1', name: 'Acme', employees: 42, primaryRecordId: null },
    ]);

    await fetchPrimaryRecordInclTrashed(
      client,
      'company',
      'p1',
      ['name'],
      {},
      'primaryRecord',
    );

    const filter = client.querySelections[0]?.companies?.__args?.filter;
    expect(serializeArgumentValue(filter)).toBe(
      '{ id: { eq: "p1" }, or: [{ deletedAt: { is: NULL } }, ' +
        '{ deletedAt: { is: NOT_NULL } }] }',
    );
  });

  it('rejects an empty-operator deletedAt filter, mirroring the server', async () => {
    // Pins the mock-vs-server fidelity gap closed: the live-found `deletedAt: {}`
    // form must throw here instead of silently passing as it did before.
    client.seed('company', [
      { id: 'p1', name: 'Acme', primaryRecordId: null },
    ]);

    await expect(
      client.query({
        companies: {
          __args: { first: 1, filter: { id: { eq: 'p1' }, deletedAt: {} } },
          edges: { node: { id: true } },
        },
      }),
    ).rejects.toThrow(/must have exactly one operator/);
  });
});
