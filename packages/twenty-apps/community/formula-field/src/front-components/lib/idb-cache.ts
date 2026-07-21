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

// workspaceCacheKey() returns the constant 'global' in this worker (no
// process.env here) — that was a safe simplification for the in-memory
// metadata cache, which dies with the process and only ever serves one
// workspace at a time. IndexedDB is different: it's origin-scoped and
// PERSISTENT, so the real isolation boundary for this entry is the browser
// origin, not the process. The 'global' fallback is only safe under Twenty's
// origin-per-workspace deployment model (cloud workspaces are subdomain-
// scoped; local dev serves one workspace per origin). A single-origin,
// multi-workspace deployment would need a real workspace discriminator in
// this key (or a per-workspace DB name) before this cache could be trusted.
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
  // Guard against a poisoned/corrupted savedAt (e.g. future-dated): only a
  // finite number with 0 <= age < TTL counts as fresh, so a bad value falls
  // through to the network instead of being served as fresh indefinitely.
  const age = hit ? Date.now() - hit.savedAt : NaN;
  const isFresh =
    typeof hit?.savedAt === 'number' &&
    Number.isFinite(hit.savedAt) &&
    age >= 0 &&
    age < CONFIGS_TTL_MS;
  if (hit && isFresh) {
    void loadAllEnabledVariationConfigs(client)
      .then((fresh) => idbSet(key, fresh))
      .catch(() => {});
    return hit.value;
  }
  const fresh = await loadAllEnabledVariationConfigs(client);
  // Don't make the already-slowest path (cold miss/stale) also wait on the
  // disk write completing — return the configs as soon as the network
  // resolves and let the write finish in the background.
  void idbSet(key, fresh);
  return fresh;
};
