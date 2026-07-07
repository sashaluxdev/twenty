import { MetadataApiClient } from 'twenty-client-sdk/metadata';

// Shared metadata loader: every object with its FULL field list. Centralizes two
// paging-correctness fixes (finding m3) that were duplicated (and both wrong) in
// loadFieldKinds, loadFieldLiveness and loadObjectFieldIndex:
//   1. The `objects` connection is paginated with a cursor loop — a workspace
//      with more than one page of objects/relations was silently truncated.
//   2. Fields come from the NON-paginated `fieldsList` accessor instead of the
//      `fields` connection capped at `first: 1000`. That cap was the DANGEROUS
//      truncation: a field dropped past 1000 reads as "missing", which flips a
//      healthy formula to a FALSE OFFLINE and stops its recompute.

export type MetadataFieldInfo = {
  id: string;
  name: string;
  type: string;
  isActive: boolean;
  // System-owned fields (id, createdAt, position, search vector, etc.) are
  // never syncable — they are platform-managed, not user data.
  isSystem: boolean;
  // Optional (not required): metadata-objects.ts is a shared loader, and
  // making this required would force every `__setFakeObjectsWithFieldsForTests`
  // fixture across the suite to set it. `!field.isUnique` downstream treats
  // undefined the same as false, so optional is safe.
  isUnique?: boolean;
};

export type MetadataObjectInfo = {
  id: string;
  nameSingular: string;
  // The object's label-identifier field id (nullable on the DTO). Variations
  // must stay distinguishable from their primary, so this field is excluded
  // from the syncable set (design 2026-07-07).
  labelIdentifierFieldMetadataId: string | null;
  fields: MetadataFieldInfo[];
};

const OBJECTS_PAGE_SIZE = 200;

// Memoize the metadata pull. computeSyncableFields (and loadFieldKinds, the
// status checks) call this on EVERY record-update event for a configured
// object — a full paginated metadata sweep each time. Staleness up to 60s is
// acceptable and deliberate: a field created mid-session is picked up within a
// minute, the same posture as the dynamic client's field-kinds cache.
const OBJECTS_TTL_MS = 60_000;

// finding m4: this cache is process-global and one worker process serves MANY
// workspaces. Keying it by workspace stops workspace A's metadata from being
// served to workspace B within the TTL (which would build wrong sub-selections
// -> silent null reads). The workspace subdomain / app-token workspaceId claim
// is the cheapest identifier the logic-function runtime exposes; the
// front-component sandbox (one workspace per process, no process.env) falls
// back to a constant, which is safe there. Single source of truth: the dynamic
// client's field-kinds cache imports this same key from here.
export const workspaceCacheKey = (): string => {
  const env = (
    globalThis as {
      process?: { env?: Record<string, string | undefined> };
    }
  ).process?.env;
  if (env?.TWENTY_WORKSPACE_SUBDOMAIN) {
    return env.TWENTY_WORKSPACE_SUBDOMAIN;
  }
  const token = env?.TWENTY_APP_ACCESS_TOKEN;
  if (token && typeof Buffer !== 'undefined') {
    try {
      const payload = JSON.parse(
        Buffer.from(token.split('.')[1] ?? '', 'base64').toString('utf8'),
      );
      if (typeof payload?.workspaceId === 'string') {
        return payload.workspaceId;
      }
    } catch {
      // Malformed token -> fall through to the shared key.
    }
  }
  return 'global';
};

type ObjectsCacheEntry = {
  objects: MetadataObjectInfo[];
  loadedAt: number;
};
const objectsCacheByWorkspace = new Map<string, ObjectsCacheEntry>();

let fakeObjectsForTests: MetadataObjectInfo[] | null = null;

// Test-only escape hatch: loadAllObjectsWithFields talks to the real
// MetadataApiClient directly (it is not parameterized by FormulaClient, unlike
// every other repository function in this app), so unit tests need a way to
// stub its result. Production code never calls this. Also clears the real cache
// (cheap safety) so different tests' seeded data can never cross-pollinate
// through a stale cache entry.
export const __setFakeObjectsWithFieldsForTests = (
  objects: MetadataObjectInfo[] | null,
): void => {
  fakeObjectsForTests = objects;
  objectsCacheByWorkspace.clear();
};

// Test-only: clears the real metadata cache directly.
export const __clearMetadataCacheForTests = (): void => {
  objectsCacheByWorkspace.clear();
};

export const loadAllObjectsWithFields = async (): Promise<
  MetadataObjectInfo[]
> => {
  // The test seam MUST come first, before any cache check, so tests are never
  // served cached real data.
  if (fakeObjectsForTests !== null) {
    return fakeObjectsForTests;
  }

  const cacheKey = workspaceCacheKey();
  const cached = objectsCacheByWorkspace.get(cacheKey);
  if (cached && Date.now() - cached.loadedAt < OBJECTS_TTL_MS) {
    return cached.objects;
  }

  const client = new MetadataApiClient();
  const results: MetadataObjectInfo[] = [];
  let after: string | undefined;

  for (;;) {
    const response = await client.query({
      objects: {
        __args: {
          filter: {},
          paging: { first: OBJECTS_PAGE_SIZE, ...(after ? { after } : {}) },
        },
        edges: {
          cursor: true,
          node: {
            id: true,
            nameSingular: true,
            labelIdentifierFieldMetadataId: true,
            // fieldsList is the full, non-paginated field list — no first:1000
            // truncation, so a large object never yields a false OFFLINE.
            fieldsList: {
              id: true,
              name: true,
              type: true,
              isActive: true,
              isSystem: true,
              isUnique: true,
            },
          },
        },
        pageInfo: { hasNextPage: true, endCursor: true },
      },
    });

    for (const edge of response?.objects?.edges ?? []) {
      const node = edge?.node;
      if (!node?.nameSingular || !node?.id) {
        continue;
      }
      const fields: MetadataFieldInfo[] = [];
      for (const field of node.fieldsList ?? []) {
        if (field?.id && field?.name && field?.type) {
          fields.push({
            id: field.id,
            name: field.name,
            type: field.type,
            isActive: field.isActive !== false,
            isSystem: field.isSystem === true,
            isUnique: field.isUnique === true,
          });
        }
      }
      results.push({
        id: node.id,
        nameSingular: node.nameSingular,
        labelIdentifierFieldMetadataId: node.labelIdentifierFieldMetadataId ?? null,
        fields,
      });
    }

    const pageInfo = response?.objects?.pageInfo;
    if (!pageInfo?.hasNextPage || !pageInfo?.endCursor) {
      break;
    }
    after = pageInfo.endCursor;
  }

  // Only cache a fully successful load. A throw from client.query above
  // propagates before we get here, so an errored pull is never cached (same
  // posture as loadFieldKinds).
  objectsCacheByWorkspace.set(cacheKey, { objects: results, loadedAt: Date.now() });
  return results;
};
