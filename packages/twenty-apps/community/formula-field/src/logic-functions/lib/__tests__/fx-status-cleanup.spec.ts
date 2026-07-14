import { beforeEach, describe, expect, it } from 'vitest';

import { FakeClient } from 'src/logic-functions/lib/__tests__/fake-client';
import { cleanupCompanionFields } from 'src/logic-functions/lib/fx-status-cleanup';
import { type ObjectFieldIndex } from 'src/logic-functions/lib/fx-status-field';

// Injected-fake style (no module mocking), mirroring
// delete-definition-completely.spec.ts. The core client is the real FakeClient —
// it already answers both the live formulaDefinitions selection (no filter,
// deletedAt defaults to null) and loadTrashedFormulas' selection (deletedAt: {
// is: NOT_NULL }) correctly, since timeline-cleanup exercises the identical
// live-query shape and formula-status exercises the identical trashed-query
// shape. loadIndex and the metadata client are hand-rolled: the deps
// parameter exists precisely so this test needs neither a real metadata
// catalog nor module mocking of MetadataApiClient.

const seedLive = (
  client: FakeClient,
  rows: Array<{ id: string; targetObject: string; targetField: string }>,
): void => {
  client.seed(
    'formulaDefinition',
    rows.map((row) => ({ ...row, enabled: true })),
  );
};

const seedTrashed = (
  client: FakeClient,
  rows: Array<{ id: string; targetObject: string; targetField: string }>,
): void => {
  client.seed(
    'formulaDefinition',
    rows.map((row) => ({
      ...row,
      enabled: true,
      deletedAt: '2026-01-01T00:00:00.000Z',
    })),
  );
};

const makeIndex = (
  byObject: Record<string, Record<string, { id: string; isActive: boolean }>>,
): Map<string, ObjectFieldIndex> => {
  const index = new Map<string, ObjectFieldIndex>();
  for (const [objectName, fields] of Object.entries(byObject)) {
    index.set(objectName, {
      objectMetadataId: `${objectName}-object-id`,
      fields: new Map(Object.entries(fields)),
    });
  }
  return index;
};

type MetadataCall = { op: 'deactivate' | 'delete'; id: string };

// Records deactivate/delete calls in order; throwOnIds makes either mutation
// touching that field id throw, for the failure-isolation test.
const makeMetadataClient = (throwOnIds: ReadonlySet<string> = new Set()) => {
  const calls: MetadataCall[] = [];
  return {
    calls,
    mutation: async (selection: any) => {
      const key = Object.keys(selection)[0];
      if (key === 'updateOneField') {
        const id = selection.updateOneField.__args.input.id;
        if (throwOnIds.has(id)) throw new Error(`boom-deactivate-${id}`);
        calls.push({ op: 'deactivate', id });
        return { updateOneField: { id } };
      }
      if (key === 'deleteOneField') {
        const id = selection.deleteOneField.__args.input.id;
        if (throwOnIds.has(id)) throw new Error(`boom-delete-${id}`);
        calls.push({ op: 'delete', id });
        return { deleteOneField: { id } };
      }
      throw new Error(`unexpected metadata mutation ${key}`);
    },
  };
};

describe('cleanupCompanionFields', () => {
  let client: FakeClient;

  beforeEach(() => {
    client = new FakeClient();
  });

  it('deactivates then hard-deletes an active companion and counts it', async () => {
    seedLive(client, [
      { id: 'def-1', targetObject: 'company', targetField: 'companyScore' },
    ]);
    const metadataClient = makeMetadataClient();
    const loadIndex = async () =>
      makeIndex({
        company: {
          companyScore: { id: 'field-value', isActive: true },
          companyScoreFxStatus: { id: 'field-companion', isActive: true },
        },
      });

    const result = await cleanupCompanionFields(client, {
      loadIndex,
      metadataClient,
    });

    expect(metadataClient.calls).toEqual([
      { op: 'deactivate', id: 'field-companion' },
      { op: 'delete', id: 'field-companion' },
    ]);
    expect(result).toEqual({
      companions: 1,
      deactivated: 1,
      deleted: 1,
      failed: 0,
    });
  });

  it('deletes an already-inactive companion without a deactivate call', async () => {
    seedLive(client, [
      { id: 'def-1', targetObject: 'company', targetField: 'companyScore' },
    ]);
    const metadataClient = makeMetadataClient();
    const loadIndex = async () =>
      makeIndex({
        company: {
          companyScoreFxStatus: { id: 'field-companion', isActive: false },
        },
      });

    const result = await cleanupCompanionFields(client, {
      loadIndex,
      metadataClient,
    });

    expect(metadataClient.calls).toEqual([
      { op: 'delete', id: 'field-companion' },
    ]);
    expect(result).toEqual({
      companions: 1,
      deactivated: 0,
      deleted: 1,
      failed: 0,
    });
  });

  it('is a no-op when the companion field no longer exists', async () => {
    seedLive(client, [
      { id: 'def-1', targetObject: 'company', targetField: 'companyScore' },
    ]);
    const metadataClient = makeMetadataClient();
    const loadIndex = async () =>
      makeIndex({
        company: {
          companyScore: { id: 'field-value', isActive: true },
        },
      });

    const result = await cleanupCompanionFields(client, {
      loadIndex,
      metadataClient,
    });

    expect(metadataClient.calls).toEqual([]);
    expect(result).toEqual({
      companions: 0,
      deactivated: 0,
      deleted: 0,
      failed: 0,
    });
  });

  it('cleans companions of TRASHED definitions too', async () => {
    seedTrashed(client, [
      { id: 'def-1', targetObject: 'company', targetField: 'companyScore' },
    ]);
    const metadataClient = makeMetadataClient();
    const loadIndex = async () =>
      makeIndex({
        company: {
          companyScoreFxStatus: { id: 'field-companion', isActive: true },
        },
      });

    const result = await cleanupCompanionFields(client, {
      loadIndex,
      metadataClient,
    });

    expect(metadataClient.calls).toEqual([
      { op: 'deactivate', id: 'field-companion' },
      { op: 'delete', id: 'field-companion' },
    ]);
    expect(result).toEqual({
      companions: 1,
      deactivated: 1,
      deleted: 1,
      failed: 0,
    });
  });

  it('never touches fields other than <targetField>FxStatus', async () => {
    seedLive(client, [
      { id: 'def-1', targetObject: 'company', targetField: 'companyScore' },
    ]);
    const metadataClient = makeMetadataClient();
    const loadIndex = async () =>
      makeIndex({
        company: {
          companyScore: { id: 'field-value', isActive: true },
          companyScoreFxStatus: { id: 'field-companion', isActive: true },
          // No definition targets userNotes -> must never be touched.
          userNotesFxStatus: { id: 'field-unrelated', isActive: true },
        },
      });

    const result = await cleanupCompanionFields(client, {
      loadIndex,
      metadataClient,
    });

    expect(metadataClient.calls).toEqual([
      { op: 'deactivate', id: 'field-companion' },
      { op: 'delete', id: 'field-companion' },
    ]);
    expect(metadataClient.calls.some((call) => call.id === 'field-value')).toBe(
      false,
    );
    expect(
      metadataClient.calls.some((call) => call.id === 'field-unrelated'),
    ).toBe(false);
    expect(result.companions).toBe(1);
  });

  it('isolates a per-field failure and keeps processing', async () => {
    seedLive(client, [
      { id: 'def-1', targetObject: 'company', targetField: 'companyScore' },
      { id: 'def-2', targetObject: 'opportunity', targetField: 'oppScore' },
    ]);
    // Both fields start inactive so the failure hits deleteOneField directly
    // (matches the brief: "deleteOneField throws for the first").
    const metadataClient = makeMetadataClient(new Set(['field-1']));
    const loadIndex = async () =>
      makeIndex({
        company: {
          companyScoreFxStatus: { id: 'field-1', isActive: false },
        },
        opportunity: {
          oppScoreFxStatus: { id: 'field-2', isActive: false },
        },
      });

    const result = await cleanupCompanionFields(client, {
      loadIndex,
      metadataClient,
    });

    expect(metadataClient.calls).toEqual([{ op: 'delete', id: 'field-2' }]);
    expect(result).toEqual({
      companions: 2,
      deactivated: 0,
      deleted: 1,
      failed: 1,
    });
  });

  it('makes no metadata calls when there are no definitions', async () => {
    const metadataClient = makeMetadataClient();
    let loadIndexCalls = 0;
    const loadIndex = async () => {
      loadIndexCalls += 1;
      return makeIndex({});
    };

    const result = await cleanupCompanionFields(client, {
      loadIndex,
      metadataClient,
    });

    expect(metadataClient.calls).toEqual([]);
    // Nothing to reconcile -> the (potentially expensive) index load is
    // skipped entirely, not just its results discarded.
    expect(loadIndexCalls).toBe(0);
    expect(result).toEqual({
      companions: 0,
      deactivated: 0,
      deleted: 0,
      failed: 0,
    });
  });
});
