import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __clearMetadataCacheForTests,
  __setFakeObjectsWithFieldsForTests,
  loadAllObjectsWithFields,
  type MetadataObjectInfo,
} from 'src/logic-functions/lib/metadata-objects';

const objectFixture = (nameSingular: string): MetadataObjectInfo => ({
  id: `obj-${nameSingular}`,
  nameSingular,
  labelIdentifierFieldMetadataId: null,
  fields: [
    { id: 'f1', name: 'name', type: 'TEXT', isActive: true, isSystem: false },
  ],
});

// The real 60s workspace-keyed cache is process-global and can only be exercised
// against a live MetadataApiClient, so it is covered by inspection + parity with
// dynamic-client's field-kinds cache. What IS unit-testable — and load-bearing —
// is that the test seam always wins over the cache, so seeded data never
// cross-pollinates between tests through a stale cache entry.
describe('loadAllObjectsWithFields (cache seam ordering)', () => {
  afterEach(() => {
    __setFakeObjectsWithFieldsForTests(null);
  });

  it('serves the fake seam and lets a later seam override an earlier one (cache never shadows the seam)', async () => {
    __setFakeObjectsWithFieldsForTests([objectFixture('company')]);
    const first = await loadAllObjectsWithFields();
    expect(first.map((object) => object.nameSingular)).toEqual(['company']);

    __setFakeObjectsWithFieldsForTests([objectFixture('opportunity')]);
    const second = await loadAllObjectsWithFields();
    expect(second.map((object) => object.nameSingular)).toEqual(['opportunity']);
  });

  it('exposes a cache-clearing seam that is safe to call with no cache present', () => {
    expect(() => __clearMetadataCacheForTests()).not.toThrow();
  });
});

// The in-flight dedup and the field selection can only be observed against the
// real MetadataApiClient path (the fake-objects seam short-circuits before both),
// so here we module-mock the client — the same mechanism fx-status-field.spec and
// handle-definition-lifecycle.spec use — and drive its query handler directly.
const metadataMock = vi.hoisted(() => ({
  queryCallCount: 0,
  capturedSelections: [] as Array<Record<string, unknown>>,
  handler: null as ((selection: Record<string, unknown>) => Promise<unknown>) | null,
}));

vi.mock('twenty-client-sdk/metadata', () => ({
  // Non-arrow so the source's `new MetadataApiClient()` constructs it.
  MetadataApiClient: vi.fn(function () {
    return {
      query: async (selection: Record<string, unknown>) => {
        metadataMock.queryCallCount += 1;
        metadataMock.capturedSelections.push(selection);
        if (metadataMock.handler) {
          return metadataMock.handler(selection);
        }
        return {
          objects: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } },
        };
      },
    };
  }),
}));

// One fully-shaped objects page carrying a single object with one field, so the
// loader's parse loop produces an observable result.
const onePageWith = (nameSingular: string): unknown => ({
  objects: {
    edges: [
      {
        cursor: 'c1',
        node: {
          id: `obj-${nameSingular}`,
          nameSingular,
          labelIdentifierFieldMetadataId: null,
          fieldsList: [
            {
              id: 'f1',
              name: 'amount',
              type: 'NUMBER',
              isActive: true,
              isSystem: false,
              isUnique: false,
              label: 'Amount',
              options: null,
              settings: null,
            },
          ],
        },
      },
    ],
    pageInfo: { hasNextPage: false, endCursor: null },
  },
});

describe('loadAllObjectsWithFields (in-flight dedup + field selection)', () => {
  beforeEach(() => {
    metadataMock.queryCallCount = 0;
    metadataMock.capturedSelections = [];
    metadataMock.handler = null;
    __setFakeObjectsWithFieldsForTests(null);
    __clearMetadataCacheForTests();
  });

  afterEach(() => {
    __setFakeObjectsWithFieldsForTests(null);
    __clearMetadataCacheForTests();
  });

  it('coalesces concurrent cold-cache callers into a single catalog fetch', async () => {
    let releaseQuery: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseQuery = resolve;
    });
    metadataMock.handler = async () => {
      await gate;
      return onePageWith('company');
    };

    const first = loadAllObjectsWithFields();
    const second = loadAllObjectsWithFields();
    releaseQuery();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(metadataMock.queryCallCount).toBe(1);
    expect(firstResult).toBe(secondResult);
    expect(firstResult.map((object) => object.nameSingular)).toEqual(['company']);
  });

  it('never caches a rejected pull and clears the in-flight slot so the next call retries', async () => {
    metadataMock.handler = async () => {
      throw new Error('metadata unreachable');
    };
    await expect(loadAllObjectsWithFields()).rejects.toThrow('metadata unreachable');
    expect(metadataMock.queryCallCount).toBe(1);

    // Slot cleared + nothing cached: a subsequent call fires a fresh query.
    metadataMock.handler = async () => onePageWith('opportunity');
    const result = await loadAllObjectsWithFields();
    expect(metadataMock.queryCallCount).toBe(2);
    expect(result.map((object) => object.nameSingular)).toEqual(['opportunity']);
  });

  it('selects label and options inside fieldsList so the front autocomplete has them', async () => {
    metadataMock.handler = async () => onePageWith('company');
    await loadAllObjectsWithFields();

    const selection = metadataMock.capturedSelections[0] as {
      objects: { edges: { node: { fieldsList: Record<string, unknown> } } };
    };
    const fieldsListSelection = selection.objects.edges.node.fieldsList;
    expect(fieldsListSelection.label).toBe(true);
    expect(fieldsListSelection.options).toBe(true);
  });

  it('maps label and options through onto each field', async () => {
    metadataMock.handler = async () => ({
      objects: {
        edges: [
          {
            cursor: 'c1',
            node: {
              id: 'obj-opportunity',
              nameSingular: 'opportunity',
              labelIdentifierFieldMetadataId: null,
              fieldsList: [
                {
                  id: 'f-stage',
                  name: 'stage',
                  type: 'SELECT',
                  isActive: true,
                  isSystem: false,
                  isUnique: false,
                  label: 'Stage',
                  options: [{ value: 'NEW', label: 'New' }],
                  settings: null,
                },
              ],
            },
          },
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    });

    const [object] = await loadAllObjectsWithFields();
    expect(object.fields[0].label).toBe('Stage');
    expect(object.fields[0].options).toEqual([{ value: 'NEW', label: 'New' }]);
  });
});
