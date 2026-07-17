import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  __clearEnabledFormulasCacheForTests,
  invalidateEnabledFormulasCache,
  loadAllEnabledFormulasCached,
} from 'src/logic-functions/lib/formula-repository';
import { type FormulaClient } from 'src/logic-functions/lib/types';

const pageResponse = {
  formulaDefinitions: {
    edges: [
      { node: { id: 'def-1', targetObject: 'company', targetField: 'score' } },
    ],
    pageInfo: { hasNextPage: false, endCursor: null },
  },
};

const clientWithSpy = () => {
  const query = vi.fn().mockResolvedValue(pageResponse);
  return {
    client: { query, mutation: vi.fn() } as unknown as FormulaClient,
    query,
  };
};

afterEach(() => __clearEnabledFormulasCacheForTests());

describe('loadAllEnabledFormulasCached', () => {
  it('serves the second call from cache within the TTL', async () => {
    const { client, query } = clientWithSpy();
    await loadAllEnabledFormulasCached(client);
    await loadAllEnabledFormulasCached(client);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('dedupes concurrent cold-cache callers into one fetch', async () => {
    const { client, query } = clientWithSpy();
    await Promise.all([
      loadAllEnabledFormulasCached(client),
      loadAllEnabledFormulasCached(client),
    ]);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('refetches after invalidation', async () => {
    const { client, query } = clientWithSpy();
    await loadAllEnabledFormulasCached(client);
    invalidateEnabledFormulasCache();
    await loadAllEnabledFormulasCached(client);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('does not cache a rejected pull', async () => {
    const query = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(pageResponse);
    const client = { query, mutation: vi.fn() } as unknown as FormulaClient;

    await expect(loadAllEnabledFormulasCached(client)).rejects.toThrow('boom');
    await expect(loadAllEnabledFormulasCached(client)).resolves.toHaveLength(1);
  });
});
