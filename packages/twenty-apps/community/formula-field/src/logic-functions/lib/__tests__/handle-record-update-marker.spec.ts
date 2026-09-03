import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleRecordUpdate } from 'src/logic-functions/lib/handle-record-update';
import { FakeClient } from 'src/logic-functions/lib/__tests__/fake-client';
import { __setFakeObjectsWithFieldsForTests } from 'src/logic-functions/lib/metadata-objects';

// One NUMBER formula on opportunity.dealScore, marker field present. The
// expression reads formulaInputA only, so an event on dealScore engages the
// override-detection funnel without engaging the recompute loop.
const seedBaseline = (client: FakeClient) => {
  client.seed('formulaDefinition', [
    {
      id: 'f1',
      name: 'Deal Score',
      targetObject: 'opportunity',
      targetField: 'dealScore',
      targetFieldType: 'NUMBER',
      expression: 'formulaInputA + 1',
      enabled: true,
      allowOverride: true,
      order: 1,
    },
  ]);
  __setFakeObjectsWithFieldsForTests([
    {
      id: 'obj-opportunity',
      nameSingular: 'opportunity',
      labelIdentifierFieldMetadataId: null,
      fields: [
        { id: 'a', name: 'fxOverrides', type: 'TEXT', isActive: true, isSystem: false },
        { id: 'b', name: 'dealScore', type: 'NUMBER', isActive: true, isSystem: false },
        { id: 'c', name: 'formulaInputA', type: 'NUMBER', isActive: true, isSystem: false },
      ],
    },
  ]);
};

describe('handleRecordUpdate marker step', () => {
  let client: FakeClient;
  const markerWrites = () =>
    client.writes.filter((write) => write.includes('fxOverrides'));

  beforeEach(() => {
    client = new FakeClient();
    seedBaseline(client);
  });
  afterEach(() => __setFakeObjectsWithFieldsForTests(null));

  it('writes the marker when a human edit creates a pin', async () => {
    client.seed('opportunity', [
      { id: 'o1', formulaInputA: 1, dealScore: 99, fxOverrides: null },
    ]);

    await handleRecordUpdate({
      client,
      objectName: 'opportunity',
      recordId: 'o1',
      after: { id: 'o1', formulaInputA: 1, dealScore: 99, fxOverrides: null },
      updatedFields: ['dealScore'],
      actorWorkspaceMemberId: 'member-1',
    });

    expect(markerWrites()).toEqual(['opportunity:o1:fxOverrides="Deal Score"']);
  });

  it('does zero marker work on an app echo with an inherited actor (ADR 0006)', async () => {
    // Stored value equals the computed value -> no pin upserted -> gate skips.
    client.seed('opportunity', [
      { id: 'o1', formulaInputA: 1, dealScore: 2, fxOverrides: null },
    ]);

    await handleRecordUpdate({
      client,
      objectName: 'opportunity',
      recordId: 'o1',
      after: { id: 'o1', formulaInputA: 1, dealScore: 2, fxOverrides: null },
      updatedFields: ['dealScore'],
      actorWorkspaceMemberId: 'member-1',
    });

    expect(markerWrites()).toHaveLength(0);
    expect(
      client.querySelections.filter(
        (selection) =>
          selection.formulaOverrides?.__args?.filter?.recordId !== undefined,
      ),
    ).toHaveLength(0);
  });

  it('reverts a tampered marker (updatedFields contains the marker)', async () => {
    client.seed('opportunity', [
      { id: 'o1', formulaInputA: 1, dealScore: 2, fxOverrides: 'HAND EDITED' },
    ]);

    await handleRecordUpdate({
      client,
      objectName: 'opportunity',
      recordId: 'o1',
      after: { id: 'o1', formulaInputA: 1, dealScore: 2, fxOverrides: 'HAND EDITED' },
      updatedFields: ['fxOverrides'],
      actorWorkspaceMemberId: 'member-1',
    });

    expect(client.writes).toContain('opportunity:o1:fxOverrides=""');
  });

  it('marker-write echo terminates: second invocation converges with zero writes', async () => {
    client.seed('formulaOverride', [
      {
        id: 'p1',
        name: 'opportunity.dealScore#o1',
        targetObject: 'opportunity',
        targetField: 'dealScore',
        recordId: 'o1',
        overrideValue: 99,
        overrideValueText: null,
        active: true,
      },
    ]);
    client.seed('opportunity', [
      { id: 'o1', formulaInputA: 1, dealScore: 99, fxOverrides: 'Deal Score' },
    ]);

    await handleRecordUpdate({
      client,
      objectName: 'opportunity',
      recordId: 'o1',
      after: { id: 'o1', formulaInputA: 1, dealScore: 99, fxOverrides: 'Deal Score' },
      updatedFields: ['fxOverrides'],
      actorWorkspaceMemberId: null,
    });

    expect(markerWrites()).toHaveLength(0);
  });

  it('blank-over-blank never writes, including an after payload missing the marker key', async () => {
    client.seed('opportunity', [
      { id: 'o1', formulaInputA: 1, dealScore: 99, fxOverrides: null },
    ]);

    // Human edit creates a pin, but `after` omits fxOverrides -> the step must
    // FETCH, see blank, and (pin now active) write once — then the echo, whose
    // payload also omits the key, must fetch and converge without writing.
    await handleRecordUpdate({
      client,
      objectName: 'opportunity',
      recordId: 'o1',
      after: { id: 'o1', formulaInputA: 1, dealScore: 99 },
      updatedFields: ['dealScore'],
      actorWorkspaceMemberId: 'member-1',
    });

    expect(markerWrites()).toEqual(['opportunity:o1:fxOverrides="Deal Score"']);

    await handleRecordUpdate({
      client,
      objectName: 'opportunity',
      recordId: 'o1',
      after: { id: 'o1', formulaInputA: 1, dealScore: 99 },
      updatedFields: ['fxOverrides'],
      actorWorkspaceMemberId: null,
    });

    expect(markerWrites()).toEqual(['opportunity:o1:fxOverrides="Deal Score"']);
  });

  it('does zero marker work on an unrelated-field human edit', async () => {
    client.seed('opportunity', [
      { id: 'o1', formulaInputA: 1, dealScore: 2, notes: 'x', fxOverrides: null },
    ]);

    await handleRecordUpdate({
      client,
      objectName: 'opportunity',
      recordId: 'o1',
      after: { id: 'o1', formulaInputA: 1, dealScore: 2, notes: 'x', fxOverrides: null },
      updatedFields: ['notes'],
      actorWorkspaceMemberId: 'member-1',
    });

    expect(
      client.querySelections.filter(
        (selection) =>
          selection.formulaOverrides?.__args?.filter?.recordId !== undefined,
      ),
    ).toHaveLength(0);
    expect(markerWrites()).toHaveLength(0);
  });

  it('does zero marker work when the object has no marker field', async () => {
    // Same pin-creating edit as the first test, but the object metadata has no
    // fxOverrides field: markerFieldExistsOnObject is false, so the step must
    // return before spending even its own pin query (R5).
    __setFakeObjectsWithFieldsForTests([
      {
        id: 'obj-opportunity',
        nameSingular: 'opportunity',
        labelIdentifierFieldMetadataId: null,
        fields: [
          { id: 'b', name: 'dealScore', type: 'NUMBER', isActive: true, isSystem: false },
          { id: 'c', name: 'formulaInputA', type: 'NUMBER', isActive: true, isSystem: false },
        ],
      },
    ]);
    client.seed('opportunity', [
      { id: 'o1', formulaInputA: 1, dealScore: 99, fxOverrides: null },
    ]);

    await handleRecordUpdate({
      client,
      objectName: 'opportunity',
      recordId: 'o1',
      after: { id: 'o1', formulaInputA: 1, dealScore: 99, fxOverrides: null },
      updatedFields: ['dealScore'],
      actorWorkspaceMemberId: 'member-1',
    });

    expect(markerWrites()).toEqual([]);
    expect(
      client.querySelections.filter(
        (selection) =>
          selection.formulaOverrides?.__args?.filter?.recordId !== undefined,
      ),
    ).toHaveLength(0);
  });
});
