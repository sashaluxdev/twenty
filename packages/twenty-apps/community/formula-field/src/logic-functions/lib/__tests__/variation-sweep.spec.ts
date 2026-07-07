import { describe, expect, it } from 'vitest';

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
});
