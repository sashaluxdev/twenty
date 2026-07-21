import { workspaceCacheKey } from 'src/logic-functions/lib/metadata-objects';
import { loadAllEnabledVariationConfigs } from 'src/logic-functions/lib/variation-config-repository';
import { type FormulaClient } from 'src/logic-functions/lib/types';
import { type VariationConfigRecord } from 'src/logic-functions/lib/variation-types';

// ADR 0024: the platform tears the worker down on every unmount, so worker-
// global caches never survive a tab reopen — but the worker is a same-origin
// dedicated Web Worker, and IndexedDB is origin-scoped and on-disk. This tiny
// KV lets the first paint of a REMOUNT serve the enabled-config scan from disk
// (stale-while-revalidate) instead of paying a ~300ms cloud leg. Everything is
// feature-detected and best-effort: no indexedDB (server logic-function
// runtime, tests, or a locked-down worker) means every call degrades to the
// plain network path.

const DB_NAME = 'formula-field-widget-cache';
const STORE_NAME = 'kv';
const CONFIGS_TTL_MS = 5 * 60 * 1000;

type StoredEntry = { value: unknown; savedAt: number };

let storeForTests: Map<string, StoredEntry> | null = null;
export const setIdbStoreForTests = (
  store: Map<string, StoredEntry> | null,
): void => {
  storeForTests = store;
};

const openDb = (): Promise<IDBDatabase | null> =>
  new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    try {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(STORE_NAME);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });

export const idbGet = async <T>(
  key: string,
): Promise<{ value: T; savedAt: number } | null> => {
  if (storeForTests) {
    return (storeForTests.get(key) as { value: T; savedAt: number }) ?? null;
  }
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const request = db
        .transaction(STORE_NAME, 'readonly')
        .objectStore(STORE_NAME)
        .get(key);
      request.onsuccess = () =>
        resolve((request.result as { value: T; savedAt: number }) ?? null);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    } finally {
      db.close();
    }
  });
};

export const idbSet = async <T>(key: string, value: T): Promise<void> => {
  if (storeForTests) {
    storeForTests.set(key, { value, savedAt: Date.now() });
    return;
  }
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      transaction
        .objectStore(STORE_NAME)
        .put({ value, savedAt: Date.now() }, key);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => resolve();
      transaction.onabort = () => resolve();
    } catch {
      resolve();
    } finally {
      db.close();
    }
  });
};

const configsCacheKey = (): string => `configs:${workspaceCacheKey()}`;

// Stale-while-revalidate: a fresh disk hit paints immediately and refreshes in
// the background (the 4s poll then reads the refreshed entry — worst case one
// poll tick of staleness, matching the existing metadata TTL posture). A miss
// or stale hit awaits the network exactly like today, and network errors
// surface to load()'s existing error path.
export const loadEnabledConfigsCached = async (
  client: FormulaClient,
): Promise<VariationConfigRecord[]> => {
  const key = configsCacheKey();
  const hit = await idbGet<VariationConfigRecord[]>(key);
  if (hit && Date.now() - hit.savedAt < CONFIGS_TTL_MS) {
    void loadAllEnabledVariationConfigs(client)
      .then((fresh) => idbSet(key, fresh))
      .catch(() => {});
    return hit.value;
  }
  const fresh = await loadAllEnabledVariationConfigs(client);
  await idbSet(key, fresh);
  return fresh;
};
