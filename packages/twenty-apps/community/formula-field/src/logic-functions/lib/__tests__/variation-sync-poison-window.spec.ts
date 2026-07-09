import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { __setMetadataCacheInvalidationListenerForTests } from 'src/logic-functions/lib/metadata-objects';
import {
  syncNewVariationRecord,
  syncOneVariation,
  syncPrimaryUpdateToVariations,
  sweepVariationConfig,
} from 'src/logic-functions/lib/variation-sync';
import { FakeClient } from 'src/logic-functions/lib/__tests__/fake-client';

// R1 poison-window remedy: the syncable set is derived from a ≤60s-stale
// metadata cache while reads/writes hit the LIVE schema. These tests simulate
// the disagreement with FakeClient.rejectFieldOnServer (the live schema no
// longer has the field) while the fake metadata still lists it (the stale
// cache), and assert the invalidate-retry-once + per-field degrade ladder.

const FIELD = {
  employees: { name: 'employees', kind: 'NUMBER' },
  city: { name: 'city', kind: 'TEXT' },
  dead: { name: 'deadField', kind: 'TEXT' },
} as const;

const objectsWith = (fieldNames: Array<{ name: string; type: string }>) => [
  {
    id: 'obj-company',
    nameSingular: 'company',
    labelIdentifierFieldMetadataId: 'field-name',
    fields: [
      { id: 'field-name', name: 'name', type: 'TEXT', isActive: true, isSystem: false },
      { id: 'field-primary', name: 'primaryRecord', type: 'RELATION', isActive: true, isSystem: false },
      ...fieldNames.map((field) => ({
        id: `field-${field.name}`,
        name: field.name,
        type: field.type,
        isActive: true,
        isSystem: false,
      })),
    ],
  },
];

// Metadata as the stale cache sees it: deadField still listed.
const STALE_OBJECTS = objectsWith([
  { name: 'employees', type: 'NUMBER' },
  { name: 'city', type: 'TEXT' },
  { name: 'deadField', type: 'TEXT' },
]);

// Metadata as the server now has it: deadField gone.
const FRESH_OBJECTS = objectsWith([
  { name: 'employees', type: 'NUMBER' },
  { name: 'city', type: 'TEXT' },
]);

describe('variation sync poison window (R1)', () => {
  let client: FakeClient;

  beforeEach(() => {
    client = new FakeClient();
    client.setObjectsWithFields(STALE_OBJECTS);
    client.rejectFieldOnServer('company', 'deadField');
    client.seed('company', [
      { id: 'p1', name: 'Acme', employees: 99, city: 'Berlin', deadField: 'x', primaryRecordId: null },
      { id: 'v1', name: 'Acme (variation)', employees: 1, city: 'Old', deadField: 'y', primaryRecordId: 'p1' },
    ]);
  });

  afterEach(() => {
    __setMetadataCacheInvalidationListenerForTests(null);
  });

  // Models the real transient case: the failure invalidates the cache and the
  // next metadata load reflects reality (deadField no longer listed).
  const swapToFreshMetadataOnInvalidation = () => {
    __setMetadataCacheInvalidationListenerForTests(() => {
      client.setObjectsWithFields(FRESH_OBJECTS);
    });
  };

  describe('syncOneVariation', () => {
    it('retries once with refreshed metadata and syncs the surviving fields', async () => {
      swapToFreshMetadataOnInvalidation();

      const outcome = await syncOneVariation(
        client,
        'company',
        { id: 'p1', employees: 99, city: 'Berlin', deadField: 'x' },
        'v1',
        [FIELD.employees, FIELD.city, FIELD.dead],
        'primaryRecord',
      );

      expect(outcome.error).toBeNull();
      expect(outcome.changed).toBe(true);
      expect(outcome.changedFields).toEqual(['employees', 'city']);
      expect(client.get('company', 'v1')!.employees).toBe(99);
      expect(client.get('company', 'v1')!.city).toBe('Berlin');
      // The dead field is never written.
      expect(client.get('company', 'v1')!.deadField).toBe('y');
    });

    it('degrades to per-field sync when the bad field survives the fresh-metadata retry', async () => {
      // No listener: refreshed metadata STILL lists deadField (metadata and
      // live schema permanently disagree) — the pathological case.
      const outcome = await syncOneVariation(
        client,
        'company',
        { id: 'p1', employees: 99, city: 'Berlin', deadField: 'x' },
        'v1',
        [FIELD.employees, FIELD.dead, FIELD.city],
        'primaryRecord',
      );

      expect(outcome.changed).toBe(true);
      expect(outcome.changedFields).toEqual(['employees', 'city']);
      expect(outcome.error).toContain('deadField');
      expect(client.get('company', 'v1')!.employees).toBe(99);
      expect(client.get('company', 'v1')!.city).toBe('Berlin');
      expect(client.get('company', 'v1')!.deadField).toBe('y');
    });

    it('is bounded: batch, one refreshed batch retry, then one read per field — never a loop', async () => {
      await syncOneVariation(
        client,
        'company',
        { id: 'p1', employees: 99, city: 'Berlin', deadField: 'x' },
        'v1',
        [FIELD.employees, FIELD.dead, FIELD.city],
        'primaryRecord',
      );

      const variationReads = client.querySelections.filter((selection) => {
        const node = selection?.company;
        return node?.__args?.filter?.id?.eq === 'v1';
      });
      // 1 failed batch + 1 failed refreshed batch + 3 per-field reads.
      expect(variationReads).toHaveLength(5);
    });

    it('returns a clean no-op when every considered field left the syncable set', async () => {
      __setMetadataCacheInvalidationListenerForTests(() => {
        client.setObjectsWithFields(objectsWith([{ name: 'employees', type: 'NUMBER' }]));
      });

      const outcome = await syncOneVariation(
        client,
        'company',
        { id: 'p1', deadField: 'x' },
        'v1',
        [FIELD.dead],
        'primaryRecord',
      );

      expect(outcome).toEqual({
        variationRecordId: 'v1',
        changed: false,
        changedFields: [],
        error: null,
      });
      expect(client.writes).toHaveLength(0);
    });
  });

  describe('syncPrimaryUpdateToVariations', () => {
    it('survives a poisoned primary fetch: invalidates, retries with fresh metadata, fans out the survivors', async () => {
      swapToFreshMetadataOnInvalidation();

      const outcomes = await syncPrimaryUpdateToVariations({
        client,
        targetObject: 'company',
        primaryRecordId: 'p1',
        updatedFields: ['deadField', 'employees'],
        relationFieldName: 'primaryRecord',
      });

      expect(outcomes).toHaveLength(1);
      expect(outcomes[0].error).toBeNull();
      expect(outcomes[0].changedFields).toEqual(['employees']);
      expect(client.get('company', 'v1')!.employees).toBe(99);
      expect(client.get('company', 'v1')!.deadField).toBe('y');
    });

    it('returns empty with zero writes when the only changed field is dead', async () => {
      swapToFreshMetadataOnInvalidation();

      const outcomes = await syncPrimaryUpdateToVariations({
        client,
        targetObject: 'company',
        primaryRecordId: 'p1',
        updatedFields: ['deadField'],
        relationFieldName: 'primaryRecord',
      });

      expect(outcomes).toEqual([]);
      expect(client.writes).toHaveLength(0);
    });
  });

  describe('syncNewVariationRecord', () => {
    it('initial sync during the poison window still syncs the surviving fields', async () => {
      swapToFreshMetadataOnInvalidation();

      const outcome = await syncNewVariationRecord({
        client,
        targetObject: 'company',
        variationRecordId: 'v1',
        primaryRecordId: 'p1',
        relationFieldName: 'primaryRecord',
      });

      expect(outcome.error).toBeNull();
      expect(client.get('company', 'v1')!.employees).toBe(99);
      expect(client.get('company', 'v1')!.city).toBe('Berlin');
      expect(client.get('company', 'v1')!.deadField).toBe('y');
    });
  });

  describe('sweepVariationConfig', () => {
    const config = {
      id: 'vc1',
      name: 'company',
      targetObject: 'company',
      relationFieldName: 'primaryRecord',
      createdRelationField: true,
      enabled: true,
      lastSyncedAt: null,
      lastError: '',
      status: '',
      statusReason: '',
    };

    it('degrades per-field on a permanently-bad field, syncs the rest, and surfaces the field on lastError', async () => {
      client.seed('company', [
        { id: 'v2', name: 'Acme (variation 2)', employees: 2, city: 'Older', deadField: 'z', primaryRecordId: 'p1' },
      ]);
      client.seed('variationConfig', [config]);

      const outcome = await sweepVariationConfig(client, config);

      expect(outcome.written).toBe(2);
      expect(client.get('company', 'v1')!.employees).toBe(99);
      expect(client.get('company', 'v2')!.employees).toBe(99);
      expect(client.get('company', 'v1')!.deadField).toBe('y');
      expect(client.get('company', 'v2')!.deadField).toBe('z');
      expect(String(client.get('variationConfig', 'vc1')!.lastError)).toContain(
        'deadField',
      );
    });

    it('narrows the syncable set after the first degrade instead of paying the ladder per record', async () => {
      client.seed('company', [
        { id: 'v2', name: 'Acme (variation 2)', employees: 2, city: 'Older', deadField: 'z', primaryRecordId: 'p1' },
      ]);
      client.seed('variationConfig', [config]);

      await sweepVariationConfig(client, config);

      // Primary reads are connection reads filtered by id eq p1. The first
      // record pays the ladder (full batch + refreshed batch + base + 3
      // per-field probes = 6); the second uses the narrowed set (1).
      const primaryFetches = client.querySelections.filter((selection) => {
        const args = selection?.companies?.__args;
        return args?.filter?.id?.eq === 'p1';
      });
      expect(primaryFetches).toHaveLength(7);
    });
  });
});
