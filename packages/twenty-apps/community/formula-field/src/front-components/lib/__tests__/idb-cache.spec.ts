import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  idbGet,
  idbSet,
  loadEnabledConfigsCached,
  setIdbStoreForTests,
} from 'src/front-components/lib/idb-cache';
import * as configRepository from 'src/logic-functions/lib/variation-config-repository';
import { type FormulaClient } from 'src/logic-functions/lib/types';
import { type VariationConfigRecord } from 'src/logic-functions/lib/variation-types';
import { workspaceCacheKey } from 'src/logic-functions/lib/metadata-objects';

const fakeClient = {} as FormulaClient;
const config = (id: string): VariationConfigRecord =>
  ({ id, targetObject: 'listing', enabled: true }) as VariationConfigRecord;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('idb kv (no indexedDB in this environment)', () => {
  it('should resolve null on get and not throw on set when indexedDB is unavailable', async () => {
    // vitest node env has no global indexedDB — the helpers must degrade.
    await expect(idbGet('k')).resolves.toBeNull();
    await expect(idbSet('k', { a: 1 })).resolves.toBeUndefined();
  });
});

describe('loadEnabledConfigsCached', () => {
  it('should fall through to the network scan when the cache misses', async () => {
    const scan = vi
      .spyOn(configRepository, 'loadAllEnabledVariationConfigs')
      .mockResolvedValue([config('c1')]);
    const result = await loadEnabledConfigsCached(fakeClient);
    expect(result).toEqual([config('c1')]);
    expect(scan).toHaveBeenCalledTimes(1);
  });

  it('should surface the network error on a cache miss (no swallowing)', async () => {
    vi.spyOn(configRepository, 'loadAllEnabledVariationConfigs').mockRejectedValue(
      new Error('boom'),
    );
    await expect(loadEnabledConfigsCached(fakeClient)).rejects.toThrow('boom');
  });
});

describe('loadEnabledConfigsCached with a seeded store', () => {
  afterEach(() => setIdbStoreForTests(null));

  it('should serve a fresh hit from the store and revalidate in the background', async () => {
    const store = new Map<string, { value: unknown; savedAt: number }>();
    store.set(`configs:${workspaceCacheKey()}`, {
      value: [config('cached')],
      savedAt: Date.now(),
    });
    setIdbStoreForTests(store);
    const scan = vi
      .spyOn(configRepository, 'loadAllEnabledVariationConfigs')
      .mockResolvedValue([config('fresh')]);

    const result = await loadEnabledConfigsCached(fakeClient);

    expect(result).toEqual([config('cached')]); // paints from disk, no await on network
    await new Promise((resolve) => setTimeout(resolve, 0)); // drain the background revalidate
    expect(scan).toHaveBeenCalledTimes(1);
    expect(store.get(`configs:${workspaceCacheKey()}`)?.value).toEqual([config('fresh')]);
  });

  it('should await the network when the stored entry is older than the TTL', async () => {
    const store = new Map<string, { value: unknown; savedAt: number }>();
    store.set(`configs:${workspaceCacheKey()}`, {
      value: [config('stale')],
      savedAt: Date.now() - 6 * 60 * 1000, // > 5min TTL
    });
    setIdbStoreForTests(store);
    vi.spyOn(configRepository, 'loadAllEnabledVariationConfigs').mockResolvedValue([
      config('fresh'),
    ]);

    await expect(loadEnabledConfigsCached(fakeClient)).resolves.toEqual([
      config('fresh'),
    ]);
  });
});
