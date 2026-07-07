import { afterEach, describe, expect, it } from 'vitest';

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
