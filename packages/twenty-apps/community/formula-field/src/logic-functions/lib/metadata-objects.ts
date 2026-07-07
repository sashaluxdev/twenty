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

let fakeObjectsForTests: MetadataObjectInfo[] | null = null;

// Test-only escape hatch: loadAllObjectsWithFields talks to the real
// MetadataApiClient directly (it is not parameterized by FormulaClient, unlike
// every other repository function in this app), so unit tests need a way to
// stub its result. Production code never calls this.
export const __setFakeObjectsWithFieldsForTests = (
  objects: MetadataObjectInfo[] | null,
): void => {
  fakeObjectsForTests = objects;
};

export const loadAllObjectsWithFields = async (): Promise<
  MetadataObjectInfo[]
> => {
  if (fakeObjectsForTests !== null) {
    return fakeObjectsForTests;
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

  return results;
};
