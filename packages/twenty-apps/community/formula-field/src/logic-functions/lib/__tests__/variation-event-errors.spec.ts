import { beforeEach, describe, expect, it } from 'vitest';

import {
  handleVariationRecordUpdated,
  sweepVariationConfig,
} from 'src/logic-functions/lib/variation-sync';
import { FakeClient } from 'src/logic-functions/lib/__tests__/fake-client';

// R3: the sweep used to be the ONLY path persisting sync errors to
// config.lastError — a live-edit fan-out that failed was completely silent
// until the next hourly sweep. These tests pin the event path's error
// surfacing: bounded, write-avoidant (no write storm), best-effort.

const CONFIG = {
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

describe('handleVariationRecordUpdated error surfacing (R3)', () => {
  let client: FakeClient;

  beforeEach(() => {
    client = new FakeClient();
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
    client.seed('variationConfig', [{ ...CONFIG }]);
  });

  const lastErrorWrites = () =>
    client.writes.filter((write) => write.startsWith('variationConfig:vc1:lastError'));

  it('persists a per-variation sync error to config.lastError exactly once across repeats', async () => {
    // The overrides read fails for every variation -> syncOneVariation
    // reports it as a per-variation outcome error (not a throw).
    client.failQueriesFor('formulaOverrides', new Error('overrides read failed'));

    const first = await handleVariationRecordUpdated({
      client,
      objectName: 'company',
      recordId: 'p1',
      after: { employees: 50 },
      updatedFields: ['employees'],
      actorWorkspaceMemberId: 'wm-1',
    });

    expect(first.role).toBe('primary');
    expect(first.outcomes[0].error).toContain('overrides read failed');
    expect(String(client.get('variationConfig', 'vc1')!.lastError)).toContain(
      'overrides read failed',
    );
    expect(lastErrorWrites()).toHaveLength(1);

    // Same failure again: lastError already says this -> no second write.
    await handleVariationRecordUpdated({
      client,
      objectName: 'company',
      recordId: 'p1',
      after: { employees: 50 },
      updatedFields: ['employees'],
      actorWorkspaceMemberId: 'wm-1',
    });

    expect(lastErrorWrites()).toHaveLength(1);
  });

  it('catches a thrown failure (dead relation pointer), records it, and does not hard-error the invocation', async () => {
    // The live schema no longer has the pointer scalar: the fresh role-deciding
    // pointer read throws (scenario #5's event path).
    client.rejectFieldOnServer('company', 'primaryRecordId');

    const result = await handleVariationRecordUpdated({
      client,
      objectName: 'company',
      recordId: 'p1',
      after: { employees: 50 },
      updatedFields: ['employees'],
      actorWorkspaceMemberId: 'wm-1',
    });

    expect(result.role).toBe('none');
    expect(result.outcomes).toEqual([]);
    expect(result.error).toContain('primaryRecordId');
    expect(String(client.get('variationConfig', 'vc1')!.lastError)).toContain(
      'primaryRecordId',
    );
    expect(lastErrorWrites()).toHaveLength(1);

    // Repeat: still exactly one bookkeeping write.
    await handleVariationRecordUpdated({
      client,
      objectName: 'company',
      recordId: 'p1',
      after: { employees: 50 },
      updatedFields: ['employees'],
      actorWorkspaceMemberId: 'wm-1',
    });
    expect(lastErrorWrites()).toHaveLength(1);
  });

  it('swallows a failure of the bookkeeping write itself', async () => {
    client.rejectFieldOnServer('company', 'primaryRecordId');
    client.failMutationsFor('updateVariationConfig', new Error('bookkeeping down'));

    const result = await handleVariationRecordUpdated({
      client,
      objectName: 'company',
      recordId: 'p1',
      after: { employees: 50 },
      updatedFields: ['employees'],
      actorWorkspaceMemberId: 'wm-1',
    });

    // The original failure is still reported; the bookkeeping failure is not
    // allowed to replace or amplify it.
    expect(result.error).toContain('primaryRecordId');
    expect(client.get('variationConfig', 'vc1')!.lastError).toBe('');
  });

  it('a later clean sweep clears the event-path error (existing convention)', async () => {
    client.failQueriesFor('formulaOverrides', new Error('overrides read failed'));
    await handleVariationRecordUpdated({
      client,
      objectName: 'company',
      recordId: 'p1',
      after: { employees: 50 },
      updatedFields: ['employees'],
      actorWorkspaceMemberId: 'wm-1',
    });
    expect(String(client.get('variationConfig', 'vc1')!.lastError)).toContain(
      'overrides read failed',
    );

    // Overrides read recovers; the hourly sweep converges and clears.
    client.clearQueryFailuresFor('formulaOverrides');
    await sweepVariationConfig(client, { ...CONFIG });

    expect(client.get('variationConfig', 'vc1')!.lastError).toBe('');
    expect(client.get('company', 'v1')!.employees).toBe(50);
  });

  it('does not write any bookkeeping on a clean fan-out', async () => {
    await handleVariationRecordUpdated({
      client,
      objectName: 'company',
      recordId: 'p1',
      after: { employees: 50 },
      updatedFields: ['employees'],
      actorWorkspaceMemberId: 'wm-1',
    });

    expect(lastErrorWrites()).toEqual([]);
    expect(client.get('company', 'v1')!.employees).toBe(50);
  });
});
