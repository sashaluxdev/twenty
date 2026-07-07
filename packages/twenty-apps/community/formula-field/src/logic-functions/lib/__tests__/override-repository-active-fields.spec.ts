import { describe, expect, it } from 'vitest';

import { loadActiveOverrideFieldsForRecord } from 'src/logic-functions/lib/override-repository';
import { FakeClient } from 'src/logic-functions/lib/__tests__/fake-client';

describe('loadActiveOverrideFieldsForRecord', () => {
  it('returns only the ACTIVE override field names for the given record', async () => {
    const client = new FakeClient();
    client.seed('formulaOverride', [
      {
        id: 'ov1',
        name: 'company.domainName#c1',
        targetObject: 'company',
        targetField: 'domainName',
        recordId: 'c1',
        overrideValue: null,
        overrideValueText: '{}',
        active: true,
      },
      {
        id: 'ov2',
        name: 'company.employees#c1',
        targetObject: 'company',
        targetField: 'employees',
        recordId: 'c1',
        overrideValue: 12,
        overrideValueText: null,
        active: false,
      },
      {
        id: 'ov3',
        name: 'company.domainName#c2',
        targetObject: 'company',
        targetField: 'domainName',
        recordId: 'c2',
        overrideValue: null,
        overrideValueText: '{}',
        active: true,
      },
    ]);

    const fields = await loadActiveOverrideFieldsForRecord(client, 'company', 'c1');

    expect(fields).toEqual(new Set(['domainName']));
  });

  it('returns an empty set when there are no overrides for the record', async () => {
    const client = new FakeClient();

    const fields = await loadActiveOverrideFieldsForRecord(client, 'company', 'c1');

    expect(fields).toEqual(new Set());
  });
});
