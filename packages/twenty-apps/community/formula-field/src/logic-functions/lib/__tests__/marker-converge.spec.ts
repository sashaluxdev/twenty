import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  convergeMarkersForColumn,
  convergeMarkersForRecords,
} from 'src/logic-functions/lib/marker-converge';
import { FakeClient } from 'src/logic-functions/lib/__tests__/fake-client';
import { __setFakeObjectsWithFieldsForTests } from 'src/logic-functions/lib/metadata-objects';

const opportunityWithMarker = {
  id: 'obj-opportunity',
  nameSingular: 'opportunity',
  labelIdentifierFieldMetadataId: null,
  fields: [
    { id: 'fld-marker', name: 'fxOverrides', type: 'TEXT', isActive: true, isSystem: false },
    { id: 'fld-score', name: 'dealScore', type: 'NUMBER', isActive: true, isSystem: false },
  ],
};

const scoreDefinition = {
  id: 'f1',
  name: 'Deal Score',
  targetObject: 'opportunity',
  targetField: 'dealScore',
  targetFieldType: 'NUMBER',
  expression: 'a + 1',
  enabled: true,
  allowOverride: true,
  order: 1,
};

const activePin = {
  id: 'p1',
  name: 'opportunity.dealScore#o1',
  targetObject: 'opportunity',
  targetField: 'dealScore',
  recordId: 'o1',
  overrideValue: 42,
  overrideValueText: null,
  active: true,
};

// Mirrors the existing suites' reset of the metadata-objects test seam so this
// file's fixtures never leak past it.
afterEach(() => __setFakeObjectsWithFieldsForTests(null));

describe('convergeMarkersForRecords', () => {
  let client: FakeClient;
  beforeEach(() => {
    client = new FakeClient();
    __setFakeObjectsWithFieldsForTests([opportunityWithMarker]);
  });

  it('writes the expected marker when it differs', async () => {
    client.seed('opportunity', [{ id: 'o1', fxOverrides: null }]);
    const result = await convergeMarkersForRecords({
      client,
      objectName: 'opportunity',
      recordIds: ['o1'],
      definitions: [scoreDefinition],
      pinRows: [activePin],
    });
    expect(result.written).toBe(1);
    expect(client.writes).toContain('opportunity:o1:fxOverrides="Deal Score"');
  });

  it('is a no-op when converged, including blank-vs-null (F3 guard)', async () => {
    client.seed('opportunity', [{ id: 'o1', fxOverrides: null }]);
    const result = await convergeMarkersForRecords({
      client,
      objectName: 'opportunity',
      recordIds: ['o1'],
      definitions: [scoreDefinition],
      pinRows: [{ ...activePin, active: false }],
    });
    expect(result.written).toBe(0);
    expect(client.writes).toHaveLength(0);
  });

  it('converges a stale marker back to blank when the pin is inactive', async () => {
    client.seed('opportunity', [{ id: 'o1', fxOverrides: 'Deal Score' }]);
    const result = await convergeMarkersForRecords({
      client,
      objectName: 'opportunity',
      recordIds: ['o1'],
      definitions: [scoreDefinition],
      pinRows: [{ ...activePin, active: false }],
    });
    expect(result.written).toBe(1);
    expect(client.writes).toContain('opportunity:o1:fxOverrides=""');
  });
});

describe('convergeMarkersForColumn', () => {
  it('skips everything when the object has no marker field', async () => {
    __setFakeObjectsWithFieldsForTests([
      { ...opportunityWithMarker, fields: opportunityWithMarker.fields.slice(1) },
    ]);
    const client = new FakeClient();
    client.seed('formulaOverride', [activePin]);
    const result = await convergeMarkersForColumn(client, 'opportunity', 'dealScore');
    expect(result).toEqual({ written: 0, records: 0 });
    expect(client.writes).toHaveLength(0);
  });

  it('converges every record that ever had a pin on the column', async () => {
    __setFakeObjectsWithFieldsForTests([opportunityWithMarker]);
    const client = new FakeClient();
    client.seed('formulaDefinition', [scoreDefinition]);
    client.seed('formulaOverride', [
      activePin,
      { ...activePin, id: 'p2', name: 'opportunity.dealScore#o2', recordId: 'o2', active: false },
    ]);
    client.seed('opportunity', [
      { id: 'o1', fxOverrides: null },
      { id: 'o2', fxOverrides: 'Deal Score' },
    ]);
    const result = await convergeMarkersForColumn(client, 'opportunity', 'dealScore');
    expect(result.records).toBe(2);
    expect(client.writes).toContain('opportunity:o1:fxOverrides="Deal Score"');
    expect(client.writes).toContain('opportunity:o2:fxOverrides=""');
  });
});
