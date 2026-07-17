// A record id's owning object never changes for the record's lifetime, so
// positive resolutions are safe to cache for the whole session — this is what
// lets a re-mounted widget skip the N-parallel probe queries on every tab
// open (Twenty unmounts inactive tabs, so per-mount refs reset each time).
// Negative results are NOT cached: "no object claims this id" can become true
// a moment later (e.g. a just-enabled config), so misses must keep probing.
const MAX_ENTRIES = 1000;
const hostByRecordId = new Map<string, string>();

export const getCachedHostObject = (recordId: string): string | null =>
  hostByRecordId.get(recordId) ?? null;

export const cacheHostObject = (
  recordId: string,
  objectName: string,
): void => {
  // Crude bound: a session visiting >1000 records just restarts the cache.
  if (hostByRecordId.size >= MAX_ENTRIES) {
    hostByRecordId.clear();
  }
  hostByRecordId.set(recordId, objectName);
};

export const __clearHostResolutionCacheForTests = (): void => {
  hostByRecordId.clear();
};
