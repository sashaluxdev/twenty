import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type EnsureMarkerFieldResult } from 'src/logic-functions/lib/ensure-marker-field';
import {
  handleDefinitionDeleted,
  handleDefinitionDestroyed,
} from 'src/logic-functions/lib/handle-definition-lifecycle';
import { handleFormulaChange } from 'src/logic-functions/lib/handle-formula-change';
import { __setFakeObjectsWithFieldsForTests } from 'src/logic-functions/lib/metadata-objects';
import { type FormulaDefinitionRecord } from 'src/logic-functions/lib/types';
import { FakeClient } from 'src/logic-functions/lib/__tests__/fake-client';

// The Overrides marker's definition-lifecycle lanes (spec §5.1 / §5.4): the
// field is created with the object's first override-allowed definition, and a
// definition leaving the enabled set (disable, trash, destroy) must drop its
// label from every marker it appears in.
//
// No metadata SDK mock is needed: markerFieldExistsOnObject and the status
// refresh both read through the metadata-objects test seam, and none of these
// fixtures sets `createdField: true`, so the destroy lane never reaches the
// field-deactivation path that instantiates a real MetadataApiClient.

const opportunityWithMarker = {
  id: 'obj-opportunity',
  nameSingular: 'opportunity',
  labelIdentifierFieldMetadataId: null,
  fields: [
    { id: 'fld-marker', name: 'fxOverrides', type: 'TEXT', isActive: true, isSystem: false },
    { id: 'fld-score', name: 'dealScore', type: 'NUMBER', isActive: true, isSystem: false },
    { id: 'fld-input', name: 'formulaInputA', type: 'NUMBER', isActive: true, isSystem: false },
  ],
};

const scoreDefinition = (
  overrides: Partial<FormulaDefinitionRecord> = {},
): FormulaDefinitionRecord => ({
  id: 'f1',
  name: 'Deal Score',
  targetObject: 'opportunity',
  targetField: 'dealScore',
  targetFieldType: 'NUMBER',
  expression: 'formulaInputA + 1',
  enabled: true,
  allowOverride: true,
  order: 1,
  ...overrides,
});

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

afterEach(() => __setFakeObjectsWithFieldsForTests(null));

describe('handleFormulaChange marker creation lane', () => {
  let client: FakeClient;

  beforeEach(() => {
    client = new FakeClient();
    __setFakeObjectsWithFieldsForTests([opportunityWithMarker]);
    client.seed('opportunity', [
      { id: 'o1', formulaInputA: 1, dealScore: null, fxOverrides: null },
    ]);
  });

  it('ensures the marker field for an override-allowed definition on creation', async () => {
    const definition = scoreDefinition();
    client.seed('formulaDefinition', [definition]);
    const ensureMarkerField = vi.fn(async () => 'created' as const);

    const result = await handleFormulaChange({
      client,
      after: definition,
      updatedFields: undefined,
      ensureMarkerField,
    });

    expect(ensureMarkerField).toHaveBeenCalledTimes(1);
    expect(ensureMarkerField).toHaveBeenCalledWith('opportunity');
    // The handler otherwise proceeds normally: the formula validates and the
    // creation populates its column.
    expect(result.valid).toBe(true);
    expect(client.get('opportunity', 'o1')!.dealScore).toBe(2);
  });

  it('skips the ensure for a locked definition and for updates', async () => {
    const locked = scoreDefinition({ id: 'locked', allowOverride: false });
    client.seed('formulaDefinition', [locked]);
    const lockedEnsure = vi.fn(async () => 'created' as const);

    await handleFormulaChange({
      client,
      after: locked,
      updatedFields: undefined,
      ensureMarkerField: lockedEnsure,
    });

    expect(lockedEnsure).not.toHaveBeenCalled();

    const updated = scoreDefinition({ id: 'updated' });
    client.seed('formulaDefinition', [updated]);
    const updateEnsure = vi.fn(async () => 'created' as const);

    await handleFormulaChange({
      client,
      after: updated,
      updatedFields: ['expression'],
      ensureMarkerField: updateEnsure,
    });

    expect(updateEnsure).not.toHaveBeenCalled();
  });

  it('returns the same result whether the ensure succeeds, fails or throws', async () => {
    const runCreation = async (
      ensureMarkerField: () => Promise<EnsureMarkerFieldResult>,
    ): Promise<Record<string, unknown>> => {
      const freshClient = new FakeClient();
      const definition = scoreDefinition();
      freshClient.seed('formulaDefinition', [definition]);
      freshClient.seed('opportunity', [
        { id: 'o1', formulaInputA: 1, dealScore: null, fxOverrides: null },
      ]);
      return handleFormulaChange({
        client: freshClient,
        after: definition,
        updatedFields: undefined,
        ensureMarkerField,
      });
    };

    const created = await runCreation(async () => 'created');
    const failed = await runCreation(async () => 'failed');
    const threw = await runCreation(async () => {
      throw new Error('metadata unavailable');
    });

    expect(created).toEqual({
      handled: true,
      valid: true,
      recordsWritten: 1,
      recordsEvaluated: 1,
    });
    expect(failed).toEqual(created);
    expect(threw).toEqual(created);
  });
});

describe('handleFormulaChange marker disable lane', () => {
  let client: FakeClient;
  const markerWrites = () =>
    client.writes.filter((write) => write.includes('fxOverrides'));

  beforeEach(() => {
    client = new FakeClient();
    __setFakeObjectsWithFieldsForTests([opportunityWithMarker]);
    // Post-write state: the definition row is already disabled when the update
    // event fires, so it has left the enabled set.
    client.seed('formulaDefinition', [scoreDefinition({ enabled: false })]);
    client.seed('formulaOverride', [activePin]);
    client.seed('opportunity', [
      { id: 'o1', formulaInputA: 1, dealScore: 42, fxOverrides: 'Deal Score' },
    ]);
  });

  it('converges markers before the disabled-bookkeeping return', async () => {
    const result = await handleFormulaChange({
      client,
      after: scoreDefinition({ enabled: false }),
      updatedFields: ['enabled'],
    });

    expect(client.writes).toContain('opportunity:o1:fxOverrides=""');
    expect(result).toEqual({ handled: false, reason: 'disabled-bookkeeping' });
  });

  it('does zero marker work for a pure bookkeeping write on a disabled definition', async () => {
    const result = await handleFormulaChange({
      client,
      after: scoreDefinition({ enabled: false, lastError: 'boom' }),
      updatedFields: ['lastError'],
    });

    expect(result).toEqual({ handled: false, reason: 'bookkeeping-only' });
    expect(markerWrites()).toHaveLength(0);
    expect(
      client.querySelections.filter(
        (selection) => 'formulaOverrides' in selection,
      ),
    ).toHaveLength(0);
  });
});

describe('handleDefinitionDeleted marker lane (trash)', () => {
  it('converges markers without deleting pins', async () => {
    const client = new FakeClient();
    __setFakeObjectsWithFieldsForTests([opportunityWithMarker]);
    // The soft delete has already landed when the event fires, so the row is
    // out of the enabled set for everyone who reads it.
    const trashed = scoreDefinition({ deletedAt: '2026-09-03T00:00:00.000Z' });
    client.seed('formulaDefinition', [trashed]);
    client.seed('formulaOverride', [activePin]);
    client.seed('opportunity', [{ id: 'o1', fxOverrides: 'Deal Score' }]);

    await handleDefinitionDeleted(client, trashed);

    expect(client.writes).toContain('opportunity:o1:fxOverrides=""');
    // Trash keeps the pins: a restore must bring the overrides back with it.
    expect(client.get('formulaOverride', 'p1')!.active).toBe(true);
    expect(
      client.mutationSelections.filter(
        (selection) => 'deleteFormulaOverride' in selection,
      ),
    ).toHaveLength(0);
  });
});

describe('handleDefinitionDestroyed marker lane', () => {
  afterEach(() => __setFakeObjectsWithFieldsForTests(null));

  it('paginates past the 200-row pin page and blanks the markers it cleared', async () => {
    const client = new FakeClient();
    __setFakeObjectsWithFieldsForTests([opportunityWithMarker]);
    const pins: Array<typeof activePin> = [];
    const records: Array<{ id: string; fxOverrides: string }> = [];
    for (let index = 0; index < 250; index += 1) {
      const suffix = String(index).padStart(3, '0');
      pins.push({
        ...activePin,
        id: `p${suffix}`,
        name: `opportunity.dealScore#o${suffix}`,
        recordId: `o${suffix}`,
      });
      records.push({ id: `o${suffix}`, fxOverrides: 'Deal Score' });
    }
    client.seed('formulaOverride', pins);
    client.seed('opportunity', records);

    const result = await handleDefinitionDestroyed(client, scoreDefinition());

    expect(result.overridesDeleted).toBe(250);
    expect(
      client.mutationSelections.filter(
        (selection) => 'deleteFormulaOverride' in selection,
      ),
    ).toHaveLength(250);
    expect(client.get('formulaOverride', 'p249')).toBeUndefined();
    // FakeClient's read-side `id: { in: [...] }` filter matches every record,
    // so the marker re-read only ever returns the first page — assert on
    // representatives inside it rather than on all 250 (ruling R4).
    expect(client.writes).toContain('opportunity:o000:fxOverrides=""');
    expect(client.writes).toContain('opportunity:o099:fxOverrides=""');
  });

  it('converges exactly the records it unpinned', async () => {
    const client = new FakeClient();
    __setFakeObjectsWithFieldsForTests([opportunityWithMarker]);
    client.seed('formulaOverride', [
      activePin,
      { ...activePin, id: 'p2', name: 'opportunity.dealScore#o2', recordId: 'o2' },
      { ...activePin, id: 'p3', name: 'opportunity.dealScore#o3', recordId: 'o3', active: false },
    ]);
    client.seed('opportunity', [
      // `a1` sorts first, so it is inside the marker re-read's page: it stays
      // untouched because it never had a pin on the destroyed column, not
      // because the fake failed to return it.
      { id: 'a1', fxOverrides: 'Deal Score' },
      { id: 'o1', fxOverrides: 'Deal Score' },
      { id: 'o2', fxOverrides: 'Deal Score' },
      { id: 'o3', fxOverrides: 'Deal Score' },
    ]);

    await handleDefinitionDestroyed(client, scoreDefinition());

    expect(client.writes).toContain('opportunity:o1:fxOverrides=""');
    expect(client.writes).toContain('opportunity:o2:fxOverrides=""');
    expect(client.writes).toContain('opportunity:o3:fxOverrides=""');
    expect(
      client.writes.filter((write) => write.includes('fxOverrides')),
    ).toHaveLength(3);
    expect(client.get('opportunity', 'a1')!.fxOverrides).toBe('Deal Score');
  });

  it('spares a shared column: a second definition still targets it', async () => {
    const client = new FakeClient();
    __setFakeObjectsWithFieldsForTests([opportunityWithMarker]);
    // Only the survivor is seeded — the destroyed definition's row is already
    // gone when the event fires.
    client.seed('formulaDefinition', [scoreDefinition({ id: 'survivor' })]);
    client.seed('formulaOverride', [activePin]);
    client.seed('opportunity', [{ id: 'o1', fxOverrides: null }]);

    const result = await handleDefinitionDestroyed(
      client,
      scoreDefinition({ id: 'destroyed', name: 'Deal Score (old)' }),
    );

    expect(result.overridesDeleted).toBe(0);
    expect(
      client.mutationSelections.filter(
        (selection) => 'deleteFormulaOverride' in selection,
      ),
    ).toHaveLength(0);
    // The survivor still owns the pin, so the marker still lists its column.
    expect(client.get('formulaOverride', 'p1')!.active).toBe(true);
    expect(client.get('opportunity', 'o1')!.fxOverrides).toBe('Deal Score');
  });
});
