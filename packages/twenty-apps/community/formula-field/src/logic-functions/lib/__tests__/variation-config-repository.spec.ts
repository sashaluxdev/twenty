import { beforeEach, describe, expect, it } from 'vitest';

import {
  findVariationConfigByTargetObject,
  loadAllEnabledVariationConfigs,
  updateVariationConfigBookkeeping,
} from 'src/logic-functions/lib/variation-config-repository';
import { FakeClient } from 'src/logic-functions/lib/__tests__/fake-client';

describe('variation-config-repository', () => {
  let client: FakeClient;

  beforeEach(() => {
    client = new FakeClient();
    client.seed('variationConfig', [
      {
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
      },
      {
        id: 'vc2',
        name: 'opportunity',
        targetObject: 'opportunity',
        relationFieldName: 'primaryRecord',
        createdRelationField: true,
        enabled: false,
        lastSyncedAt: null,
        lastError: '',
        status: '',
        statusReason: '',
      },
    ]);
  });

  it('loadAllEnabledVariationConfigs returns only enabled configs', async () => {
    const configs = await loadAllEnabledVariationConfigs(client);

    expect(configs.map((config) => config.targetObject)).toEqual(['company']);
  });

  it('findVariationConfigByTargetObject finds a config by its target object', async () => {
    const config = await findVariationConfigByTargetObject(client, 'opportunity');

    expect(config?.id).toBe('vc2');
  });

  it('findVariationConfigByTargetObject returns null when no config exists', async () => {
    const config = await findVariationConfigByTargetObject(client, 'person');

    expect(config).toBeNull();
  });

  it('updateVariationConfigBookkeeping writes the given fields', async () => {
    await updateVariationConfigBookkeeping(client, 'vc1', {
      lastSyncedAt: '2026-07-07T00:00:00.000Z',
      lastError: '',
      statusReason: '2 variation(s) skipped',
    });

    const record = client.get('variationConfig', 'vc1')!;
    expect(record.lastSyncedAt).toBe('2026-07-07T00:00:00.000Z');
    expect(record.statusReason).toBe('2 variation(s) skipped');
  });
});
