import { afterEach, describe, expect, it } from 'vitest';

import { __setMetadataCacheInvalidationListenerForTests } from 'src/logic-functions/lib/metadata-objects';
import { sweepVariationConfig } from 'src/logic-functions/lib/variation-sync';
import { FakeClient } from 'src/logic-functions/lib/__tests__/fake-client';

const config = (overrides: Record<string, unknown> = {}) => ({
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
  ...overrides,
});

describe('sweepVariationConfig', () => {
  it('re-syncs every variation of the object and records a heartbeat', async () => {
    const client = new FakeClient();
    client.setObjectsWithFields([
      {
        id: 'obj-company',
        nameSingular: 'company',
        labelIdentifierFieldMetadataId: 'field-name',
        fields: [
          { id: 'field-name', name: 'name', type: 'TEXT', isActive: true, isSystem: false },
          { id: 'field-employees', name: 'employees', type: 'NUMBER', isActive: true, isSystem: false },
          { id: 'field-primary', name: 'primaryRecord', type: 'RELATION', isActive: true, isSystem: false },
        ],
      },
    ]);
    client.seed('company', [
      { id: 'p1', name: 'Acme', employees: 50, primaryRecordId: null },
      { id: 'v1', name: 'Acme (variation)', employees: 10, primaryRecordId: 'p1' },
    ]);
    client.seed('variationConfig', [config()]);

    const outcome = await sweepVariationConfig(client, config());

    expect(outcome.evaluated).toBe(1);
    expect(outcome.written).toBe(1);
    expect(client.get('company', 'v1')!.employees).toBe(50);
    expect(client.get('variationConfig', 'vc1')!.lastSyncedAt).toBeDefined();
  });

  it('freezes a variation whose primary is trashed, without aborting the sweep', async () => {
    const client = new FakeClient();
    client.setObjectsWithFields([
      {
        id: 'obj-company',
        nameSingular: 'company',
        labelIdentifierFieldMetadataId: 'field-name',
        fields: [
          { id: 'field-name', name: 'name', type: 'TEXT', isActive: true, isSystem: false },
          { id: 'field-employees', name: 'employees', type: 'NUMBER', isActive: true, isSystem: false },
          { id: 'field-primary', name: 'primaryRecord', type: 'RELATION', isActive: true, isSystem: false },
        ],
      },
    ]);
    client.seed('company', [
      { id: 'p1', name: 'Acme', employees: 50, primaryRecordId: null, deletedAt: '2026-07-07T00:00:00.000Z' },
      { id: 'v1', name: 'Acme (variation)', employees: 10, primaryRecordId: 'p1' },
      { id: 'p2', name: 'Beta', employees: 20, primaryRecordId: null },
      { id: 'v2', name: 'Beta (variation)', employees: 1, primaryRecordId: 'p2' },
    ]);
    client.seed('variationConfig', [config()]);

    const outcome = await sweepVariationConfig(client, config());

    expect(outcome.frozen).toBe(1);
    expect(outcome.written).toBe(1);
    expect(client.get('company', 'v1')!.employees).toBe(10);
    expect(client.get('company', 'v2')!.employees).toBe(20);
  });

  it('surfaces the first per-record sync error on VariationConfig.lastError', async () => {
    const client = new FakeClient();
    client.setObjectsWithFields([
      {
        id: 'obj-company',
        nameSingular: 'company',
        labelIdentifierFieldMetadataId: 'field-name',
        fields: [
          { id: 'field-name', name: 'name', type: 'TEXT', isActive: true, isSystem: false },
          { id: 'field-employees', name: 'employees', type: 'NUMBER', isActive: true, isSystem: false },
          { id: 'field-primary', name: 'primaryRecord', type: 'RELATION', isActive: true, isSystem: false },
        ],
      },
    ]);
    client.seed('company', [
      { id: 'p1', name: 'Acme', employees: 50, primaryRecordId: null },
      { id: 'v1', name: 'Acme (variation)', employees: 10, primaryRecordId: 'p1' },
    ]);
    client.seed('variationConfig', [config()]);

    // Force syncOneVariation's own re-fetch of the variation record (inside
    // syncOneVariation, not the connection scan above it) to come back empty,
    // the same "Variation record not found" outcome syncOneVariation already
    // returns as a real per-record error — the simplest way to drive one
    // through the sweep loop without faking a thrown exception.
    const realQuery = client.query.bind(client);
    client.query = (async (selection: Record<string, unknown>) => {
      const key = Object.keys(selection)[0];
      const node = selection[key] as { __args?: { filter?: { id?: { eq?: string } } } };
      const filterId = node?.__args?.filter?.id?.eq;
      if (key === 'company' && filterId === 'v1') {
        return { company: null };
      }
      return realQuery(selection);
    }) as typeof client.query;

    const outcome = await sweepVariationConfig(client, config());

    expect(outcome.errored).toBe(1);
    expect(client.get('variationConfig', 'vc1')!.lastError).toBe(
      'Variation record not found',
    );
  });

  it('skips a variation whose primary is itself a variation and records a statusReason', async () => {
    const client = new FakeClient();
    client.setObjectsWithFields([
      {
        id: 'obj-company',
        nameSingular: 'company',
        labelIdentifierFieldMetadataId: 'field-name',
        fields: [
          { id: 'field-name', name: 'name', type: 'TEXT', isActive: true, isSystem: false },
          { id: 'field-employees', name: 'employees', type: 'NUMBER', isActive: true, isSystem: false },
          { id: 'field-primary', name: 'primaryRecord', type: 'RELATION', isActive: true, isSystem: false },
        ],
      },
    ]);
    client.seed('company', [
      { id: 'root', name: 'Root', employees: 1, primaryRecordId: null },
      { id: 'p1', name: 'Acme', employees: 50, primaryRecordId: 'root' },
      { id: 'v1', name: 'Acme (variation)', employees: 10, primaryRecordId: 'p1' },
    ]);
    client.seed('variationConfig', [config()]);

    const outcome = await sweepVariationConfig(client, config());

    expect(outcome.skippedNestedPrimary).toBe(1);
    expect(client.get('company', 'v1')!.employees).toBe(10);
    expect(client.get('variationConfig', 'vc1')!.statusReason).toContain('1');
  });

  // R3: a dead/missing relation field must give the config an HONEST health
  // signal (status/statusReason) instead of an enabled config whose every
  // sync path throws raw GraphQL.
  describe('relation-field health signal (R3)', () => {
    afterEach(() => {
      __setMetadataCacheInvalidationListenerForTests(null);
    });

    const objectsWithRelationField = (isActive: boolean) => [
      {
        id: 'obj-company',
        nameSingular: 'company',
        labelIdentifierFieldMetadataId: 'field-name',
        fields: [
          { id: 'field-name', name: 'name', type: 'TEXT', isActive: true, isSystem: false },
          { id: 'field-employees', name: 'employees', type: 'NUMBER', isActive: true, isSystem: false },
          { id: 'field-primary', name: 'primaryRecord', type: 'RELATION', isActive, isSystem: false },
        ],
      },
    ];

    it('marks the config OFFLINE with a reason when the relation field is dead, without paging records', async () => {
      const client = new FakeClient();
      client.setObjectsWithFields(objectsWithRelationField(false));
      client.seed('company', [
        { id: 'p1', name: 'Acme', employees: 50, primaryRecordId: null },
        { id: 'v1', name: 'Acme (variation)', employees: 10, primaryRecordId: 'p1' },
      ]);
      client.seed('variationConfig', [config()]);

      const outcome = await sweepVariationConfig(client, config());

      expect(outcome.evaluated).toBe(0);
      expect(outcome.errored).toBe(1);
      const stored = client.get('variationConfig', 'vc1')!;
      expect(stored.status).toBe('OFFLINE');
      expect(String(stored.statusReason)).toContain('primaryRecord');
      expect(String(stored.lastError)).toContain('primaryRecord');
      // Honest, not destructive: the config stays enabled so it self-heals
      // the moment the field comes back.
      expect(stored.enabled).toBe(true);
      expect(stored.lastSyncedAt).toBeDefined();
      // No record writes happened.
      expect(client.writes.filter((write) => write.startsWith('company:'))).toEqual([]);
    });

    it('clears status/statusReason/lastError on the next healthy sweep (recovery)', async () => {
      const client = new FakeClient();
      client.setObjectsWithFields(objectsWithRelationField(true));
      client.seed('company', [
        { id: 'p1', name: 'Acme', employees: 50, primaryRecordId: null },
        { id: 'v1', name: 'Acme (variation)', employees: 50, primaryRecordId: 'p1' },
      ]);
      client.seed('variationConfig', [
        config({
          status: 'OFFLINE',
          statusReason: 'Relation field "primaryRecord" is missing',
          lastError: 'Relation field "primaryRecord" is missing',
        }),
      ]);

      await sweepVariationConfig(client, config());

      const stored = client.get('variationConfig', 'vc1')!;
      expect(stored.status).toBe('');
      expect(stored.statusReason).toBe('');
      expect(stored.lastError).toBe('');
    });

    it('does not falsely go OFFLINE off a stale cache: re-checks against fresh metadata first', async () => {
      const client = new FakeClient();
      // Stale cache: relation field missing; fresh metadata: present.
      client.setObjectsWithFields([
        {
          ...objectsWithRelationField(true)[0],
          fields: objectsWithRelationField(true)[0].fields.filter(
            (field) => field.name !== 'primaryRecord',
          ),
        },
      ]);
      __setMetadataCacheInvalidationListenerForTests(() => {
        client.setObjectsWithFields(objectsWithRelationField(true));
      });
      client.seed('company', [
        { id: 'p1', name: 'Acme', employees: 50, primaryRecordId: null },
        { id: 'v1', name: 'Acme (variation)', employees: 10, primaryRecordId: 'p1' },
      ]);
      client.seed('variationConfig', [config()]);

      const outcome = await sweepVariationConfig(client, config());

      expect(outcome.written).toBe(1);
      expect(client.get('variationConfig', 'vc1')!.status).toBe('');
      expect(client.get('company', 'v1')!.employees).toBe(50);
    });
  });

  // ADR 0022: sweepVariationConfig's bookkeeping write must be write-avoidant
  // (mirrors formula-repository's M3 contract) — a no-op sweep performs ZERO
  // config-row writes, except a once-per-24h heartbeat so the editor's
  // "last synced" timestamp cannot go permanently stale.
  describe('bookkeeping write-avoidance (ADR 0022)', () => {
    const freshLastSyncedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago
    const staleLastSyncedAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(); // 25h ago

    // Filters the fake client's captured mutations by top-level key, so a test
    // can assert HOW MANY times a given mutation ran without depending on the
    // field-level `writes` log (one mutation call writes several fields).
    const mutationsOf = (client: FakeClient, key: string) =>
      client.mutationSelections.filter(
        (selection) => Object.keys(selection)[0] === key,
      );

    const seedHealthyCompany = (client: FakeClient) => {
      client.setObjectsWithFields([
        {
          id: 'obj-company',
          nameSingular: 'company',
          labelIdentifierFieldMetadataId: 'field-name',
          fields: [
            { id: 'field-name', name: 'name', type: 'TEXT', isActive: true, isSystem: false },
            { id: 'field-employees', name: 'employees', type: 'NUMBER', isActive: true, isSystem: false },
            { id: 'field-primary', name: 'primaryRecord', type: 'RELATION', isActive: true, isSystem: false },
          ],
        },
      ]);
      client.seed('company', [
        { id: 'p1', name: 'Acme', employees: 50, primaryRecordId: null },
        { id: 'v1', name: 'Acme (variation)', employees: 10, primaryRecordId: 'p1' },
      ]);
    };

    it('skips the bookkeeping write when nothing changed and lastSyncedAt is fresh', async () => {
      const client = new FakeClient();
      seedHealthyCompany(client);
      const cfg = config({
        lastError: '',
        status: '',
        statusReason: '',
        lastSyncedAt: freshLastSyncedAt,
      });
      client.seed('variationConfig', [cfg]);

      await sweepVariationConfig(client, cfg);

      expect(mutationsOf(client, 'updateVariationConfig')).toHaveLength(0);
    });

    it('writes when lastError changes', async () => {
      const client = new FakeClient();
      seedHealthyCompany(client);
      const cfg = config({
        lastError: '',
        status: '',
        statusReason: '',
        lastSyncedAt: freshLastSyncedAt,
      });
      client.seed('variationConfig', [cfg]);

      // Force syncOneVariation's own re-fetch of the variation record to come
      // back empty, driving a real per-record error (same technique as the
      // "surfaces the first per-record sync error" test above).
      const realQuery = client.query.bind(client);
      client.query = (async (selection: Record<string, unknown>) => {
        const key = Object.keys(selection)[0];
        const node = selection[key] as { __args?: { filter?: { id?: { eq?: string } } } };
        const filterId = node?.__args?.filter?.id?.eq;
        if (key === 'company' && filterId === 'v1') {
          return { company: null };
        }
        return realQuery(selection);
      }) as typeof client.query;

      await sweepVariationConfig(client, cfg);

      const writes = mutationsOf(client, 'updateVariationConfig');
      expect(writes).toHaveLength(1);
    });

    it('writes a daily heartbeat when lastSyncedAt is older than 24h', async () => {
      const client = new FakeClient();
      seedHealthyCompany(client);
      const cfg = config({
        lastError: '',
        status: '',
        statusReason: '',
        lastSyncedAt: staleLastSyncedAt,
      });
      client.seed('variationConfig', [cfg]);

      await sweepVariationConfig(client, cfg);

      expect(mutationsOf(client, 'updateVariationConfig')).toHaveLength(1);
    });

    it('treats an unparsable lastSyncedAt as heartbeat-due (writes)', async () => {
      const client = new FakeClient();
      seedHealthyCompany(client);
      const cfg = config({
        lastError: '',
        status: '',
        statusReason: '',
        lastSyncedAt: null,
      });
      client.seed('variationConfig', [cfg]);

      await sweepVariationConfig(client, cfg);

      expect(mutationsOf(client, 'updateVariationConfig')).toHaveLength(1);
    });
  });
});
