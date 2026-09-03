import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { convergeAllMarkers } from 'src/logic-functions/lib/marker-sweep';
import { FakeClient } from 'src/logic-functions/lib/__tests__/fake-client';
import { __setFakeObjectsWithFieldsForTests } from 'src/logic-functions/lib/metadata-objects';

const markerField = {
  id: 'fld-marker',
  name: 'fxOverrides',
  type: 'TEXT',
  isActive: true,
  isSystem: false,
};

const opportunityWithMarker = {
  id: 'obj-opportunity',
  nameSingular: 'opportunity',
  labelIdentifierFieldMetadataId: null,
  fields: [
    markerField,
    { id: 'fld-score', name: 'dealScore', type: 'NUMBER', isActive: true, isSystem: false },
  ],
};

const opportunityWithoutMarker = {
  ...opportunityWithMarker,
  fields: opportunityWithMarker.fields.slice(1),
};

const companyWithoutMarker = {
  id: 'obj-company',
  nameSingular: 'company',
  labelIdentifierFieldMetadataId: null,
  fields: [
    { id: 'fld-tier', name: 'tier', type: 'NUMBER', isActive: true, isSystem: false },
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

const lockedCompanyDefinition = {
  id: 'f2',
  name: 'Tier',
  targetObject: 'company',
  targetField: 'tier',
  targetFieldType: 'NUMBER',
  expression: '1',
  enabled: true,
  allowOverride: false,
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

// Metadata seam for the cleanup arm: findFields' objects query plus the
// updateOneField / deleteOneField mutations it then issues.
const metadataStub = () => {
  const mutation = vi.fn().mockResolvedValue({ updateOneField: { id: 'fld-marker' } });
  const query = vi.fn().mockResolvedValue({
    objects: {
      edges: [
        {
          node: {
            id: 'obj-opportunity',
            nameSingular: 'opportunity',
            fields: {
              edges: [{ node: { id: 'fld-marker', name: 'fxOverrides', isActive: true } }],
            },
          },
        },
      ],
    },
  });
  return { query, mutation };
};

const neverEnsure = vi.fn(async () => 'exists' as const);

// 2026-09-03T01:00:00Z — UTC hour 1, so the rotation offset over two objects is
// 1 and the pass starts at the SECOND object of the sorted list.
const HOUR_ONE = Date.UTC(2026, 8, 3, 1, 0, 0);
const HOUR_ZERO = Date.UTC(2026, 8, 3, 0, 0, 0);

// Clock that advances by `stepMs` on every read, so a test can let the budget
// expire at a chosen point in the pass. The sweep reads it once for the rotation
// offset, once before each object, and once per dirty-marker page that has a
// successor — nowhere else.
const steppingClock = (startMs: number, stepMs: number): (() => number) => {
  let current = startMs - stepMs;
  return () => (current += stepMs);
};

const companyWithMarker = {
  ...companyWithoutMarker,
  fields: [markerField, ...companyWithoutMarker.fields],
};

const tierDefinition = {
  ...lockedCompanyDefinition,
  allowOverride: true,
};

// Mirrors the existing suites' reset of the metadata-objects test seam so this
// file's fixtures never leak past it.
afterEach(() => __setFakeObjectsWithFieldsForTests(null));

describe('convergeAllMarkers', () => {
  let client: FakeClient;
  beforeEach(() => {
    client = new FakeClient();
    neverEnsure.mockClear();
  });

  it('converges pin-arm candidates and dirty markers in one object pass', async () => {
    __setFakeObjectsWithFieldsForTests([opportunityWithMarker]);
    client.seed('formulaDefinition', [scoreDefinition]);
    client.seed('formulaOverride', [
      activePin,
      {
        ...activePin,
        id: 'p2',
        name: 'opportunity.dealScore#o2',
        recordId: 'o2',
        active: false,
      },
    ]);
    client.seed('opportunity', [
      // Active pin, marker never written.
      { id: 'o1', fxOverrides: null },
      // Pin deactivated, marker still names the field.
      { id: 'o2', fxOverrides: 'Deal Score' },
      // Tampered marker, no pin row at all — only the dirty arm reaches it.
      { id: 'o3', fxOverrides: 'junk' },
    ]);

    const result = await convergeAllMarkers(client, [scoreDefinition], {
      deadlineAt: Date.now() + 30_000,
      ensure: neverEnsure,
    });

    expect(result.written).toBe(3);
    expect(result.truncated).toBe(false);
    expect(client.writes).toContain('opportunity:o1:fxOverrides="Deal Score"');
    expect(client.writes).toContain('opportunity:o2:fxOverrides=""');
    expect(client.writes).toContain('opportunity:o3:fxOverrides=""');
    expect(client.get('opportunity', 'o1')?.fxOverrides).toBe('Deal Score');
    expect(client.get('opportunity', 'o2')?.fxOverrides).toBe('');
    expect(client.get('opportunity', 'o3')?.fxOverrides).toBe('');
  });

  it('dirty-marker arm runs even when the object has zero enabled definitions', async () => {
    __setFakeObjectsWithFieldsForTests([opportunityWithMarker]);
    // A disabled definition still lives, so the cleanup arm must keep the field.
    client.seed('formulaDefinition', [{ ...scoreDefinition, enabled: false }]);
    client.seed('opportunity', [{ id: 'o1', fxOverrides: 'Ghost' }]);

    const result = await convergeAllMarkers(client, [], {
      deadlineAt: Date.now() + 30_000,
      ensure: neverEnsure,
    });

    expect(result.written).toBe(1);
    expect(result.fieldsDeleted).toBe(0);
    expect(client.writes).toEqual(['opportunity:o1:fxOverrides=""']);
  });

  it('retries ensure for an object with an override-allowed definition but no marker field', async () => {
    __setFakeObjectsWithFieldsForTests([opportunityWithoutMarker, companyWithoutMarker]);
    const ensure = vi.fn(async () => 'created' as const);

    const result = await convergeAllMarkers(
      client,
      [scoreDefinition, lockedCompanyDefinition],
      { deadlineAt: Date.now() + 30_000, ensure },
    );

    expect(ensure).toHaveBeenCalledTimes(1);
    expect(ensure).toHaveBeenCalledWith('opportunity');
    expect(result.ensured).toBe(1);
    // Neither object is marker-bearing: no pins, no records, no writes.
    expect(client.queries).toBe(0);
    expect(client.mutations).toBe(0);
  });

  it('deletes the marker field only when the object has zero definitions in any state', async () => {
    __setFakeObjectsWithFieldsForTests([opportunityWithMarker]);
    client.seed('opportunity', [{ id: 'o1', fxOverrides: null }]);
    // Case A: nothing live, one trashed definition -> the field stays.
    client.seed('formulaDefinition', [
      { ...scoreDefinition, deletedAt: '2026-09-01T00:00:00.000Z' },
    ]);
    const keptStub = metadataStub();

    const kept = await convergeAllMarkers(client, [], {
      deadlineAt: Date.now() + 30_000,
      ensure: neverEnsure,
      metadataClient: keptStub,
    });

    expect(kept.fieldsDeleted).toBe(0);
    expect(keptStub.mutation).not.toHaveBeenCalled();

    // Case B: no definitions at all -> deactivate, then delete.
    const emptyClient = new FakeClient();
    emptyClient.seed('opportunity', [{ id: 'o1', fxOverrides: null }]);
    const deletedStub = metadataStub();

    const deleted = await convergeAllMarkers(emptyClient, [], {
      deadlineAt: Date.now() + 30_000,
      ensure: neverEnsure,
      metadataClient: deletedStub,
    });

    expect(deleted.fieldsDeleted).toBe(1);
    expect(deletedStub.mutation).toHaveBeenCalledTimes(2);
    expect(deletedStub.mutation.mock.calls[0][0]).toEqual({
      updateOneField: {
        __args: { input: { id: 'fld-marker', update: { isActive: false } } },
        id: true,
      },
    });
    expect(deletedStub.mutation.mock.calls[1][0]).toEqual({
      deleteOneField: { __args: { input: { id: 'fld-marker' } }, id: true },
    });
  });

  it('a fully converged workspace does zero record mutations', async () => {
    __setFakeObjectsWithFieldsForTests([opportunityWithMarker]);
    client.seed('formulaDefinition', [scoreDefinition]);
    client.seed('formulaOverride', [
      activePin,
      {
        ...activePin,
        id: 'p2',
        name: 'opportunity.dealScore#o2',
        recordId: 'o2',
        active: false,
      },
    ]);
    client.seed('opportunity', [
      { id: 'o1', fxOverrides: 'Deal Score' },
      { id: 'o2', fxOverrides: null },
    ]);

    const result = await convergeAllMarkers(client, [scoreDefinition], {
      deadlineAt: Date.now() + 30_000,
      ensure: neverEnsure,
    });

    expect(result.written).toBe(0);
    expect(client.mutations).toBe(0);
    expect(client.writes).toHaveLength(0);
    // Cost model: one object-scoped pin query + one NOT_NULL marker scan. o2's
    // blank marker is known from the scan's completeness, so it costs no read.
    expect(client.queries).toBe(2);
  });

  it('rotates the starting object with the hour of day', async () => {
    __setFakeObjectsWithFieldsForTests([opportunityWithMarker, companyWithMarker]);
    const definitions = [scoreDefinition, tierDefinition];
    const recordQueryOrder = (fake: FakeClient): string[] =>
      fake.querySelections
        .map((selection) => Object.keys(selection)[0])
        .filter((key) => key === 'opportunities' || key === 'companies');

    client.seed('opportunity', [{ id: 'o1', fxOverrides: null }]);
    client.seed('company', [{ id: 'c1', fxOverrides: null }]);
    await convergeAllMarkers(client, definitions, {
      deadlineAt: HOUR_ONE + 30_000,
      ensure: neverEnsure,
      now: () => HOUR_ONE,
    });
    // Sorted list is ['company', 'opportunity']; offset 1 % 2 starts at the second.
    expect(recordQueryOrder(client)).toEqual(['opportunities', 'companies']);

    const evenHourClient = new FakeClient();
    evenHourClient.seed('opportunity', [{ id: 'o1', fxOverrides: null }]);
    evenHourClient.seed('company', [{ id: 'c1', fxOverrides: null }]);
    await convergeAllMarkers(evenHourClient, definitions, {
      deadlineAt: HOUR_ZERO + 30_000,
      ensure: neverEnsure,
      now: () => HOUR_ZERO,
    });
    expect(recordQueryOrder(evenHourClient)).toEqual(['companies', 'opportunities']);
  });

  it('stops between objects when the deadline expires mid-pass', async () => {
    __setFakeObjectsWithFieldsForTests([opportunityWithMarker, companyWithMarker]);
    client.seed('formulaDefinition', [scoreDefinition, tierDefinition]);
    client.seed('opportunity', [{ id: 'o1', fxOverrides: 'junk' }]);
    client.seed('company', [{ id: 'c1', fxOverrides: 'junk' }]);

    // Hour 0 -> offset 0 -> 'company' first. Reads: rotation (t0), company's
    // deadline check (t0+10s, under), opportunity's (t0+20s, over).
    const result = await convergeAllMarkers(client, [scoreDefinition, tierDefinition], {
      deadlineAt: HOUR_ZERO + 15_000,
      ensure: neverEnsure,
      now: steppingClock(HOUR_ZERO, 10_000),
    });

    expect(result.objects).toBe(1);
    expect(result.truncated).toBe(true);
    expect(client.writes).toEqual(['company:c1:fxOverrides=""']);
    expect(client.get('opportunity', 'o1')?.fxOverrides).toBe('junk');
  });

  it('stops paginating the dirty-marker scan when the deadline expires mid-object', async () => {
    __setFakeObjectsWithFieldsForTests([opportunityWithMarker]);
    // 201 dirty records -> two pages at the 200-record page size.
    client.seed(
      'opportunity',
      Array.from({ length: 201 }, (unused, index) => ({
        id: `o${String(index).padStart(3, '0')}`,
        fxOverrides: 'junk',
      })),
    );

    // A pin candidate that page 1 never reached: its marker value is unknown
    // after a truncated scan, so it must be deferred, not fetched.
    client.seed('formulaOverride', [
      { ...activePin, id: 'p9', name: 'opportunity.dealScore#o200', recordId: 'o200' },
    ]);

    // Reads: rotation (t0), the object's deadline check (t0+10s, under), then
    // after page 1 (t0+20s, over) -> the second page is never fetched.
    const result = await convergeAllMarkers(client, [scoreDefinition], {
      deadlineAt: HOUR_ZERO + 15_000,
      ensure: neverEnsure,
      now: steppingClock(HOUR_ZERO, 10_000),
    });

    expect(result.truncated).toBe(true);
    // One scan page and no batched read: a second entry would be either.
    const markerScans = client.querySelections.filter(
      (selection) => Object.keys(selection)[0] === 'opportunities',
    );
    expect(markerScans).toHaveLength(1);
    // The page already paid for is still converged, so the dirty set shrinks.
    expect(result.written).toBe(200);
    expect(client.writes).toHaveLength(200);
    expect(client.get('opportunity', 'o200')?.fxOverrides).toBe('junk');
  });

  it('respects the deadline: stops between objects and reports truncated', async () => {
    __setFakeObjectsWithFieldsForTests([
      opportunityWithMarker,
      { ...companyWithoutMarker, fields: [markerField, ...companyWithoutMarker.fields] },
    ]);
    client.seed('formulaDefinition', [scoreDefinition]);
    client.seed('opportunity', [{ id: 'o1', fxOverrides: 'junk' }]);
    client.seed('company', [{ id: 'c1', fxOverrides: 'junk' }]);

    const result = await convergeAllMarkers(client, [scoreDefinition], {
      deadlineAt: Date.now() - 1,
      ensure: neverEnsure,
    });

    expect(result.truncated).toBe(true);
    expect(result.objects).toBe(0);
    expect(result.written).toBe(0);
    expect(client.writes).toHaveLength(0);
    expect(client.queries).toBe(0);
  });
});
