import { beforeEach, describe, expect, it } from 'vitest';
import {
  loadOverridesForObject,
  upsertOverride,
} from 'src/logic-functions/lib/override-repository';
import { FakeClient } from 'src/logic-functions/lib/__tests__/fake-client';

describe('upsertOverride result signal', () => {
  let client: FakeClient;
  beforeEach(() => {
    client = new FakeClient();
  });

  it("returns 'created' for a new pin", async () => {
    const result = await upsertOverride(client, 'opportunity', 'dealScore', 'o1', {
      numeric: 42,
    });
    expect(result).toBe('created');
  });

  it("returns 'updated' when the pinned value changes", async () => {
    client.seed('formulaOverride', [
      {
        id: 'pin1',
        name: 'opportunity.dealScore#o1',
        targetObject: 'opportunity',
        targetField: 'dealScore',
        recordId: 'o1',
        overrideValue: 1,
        overrideValueText: null,
        active: true,
      },
    ]);
    const result = await upsertOverride(client, 'opportunity', 'dealScore', 'o1', {
      numeric: 2,
    });
    expect(result).toBe('updated');
  });

  it("returns 'noop' (and mutates nothing) when the pin is already correct", async () => {
    client.seed('formulaOverride', [
      {
        id: 'pin1',
        name: 'opportunity.dealScore#o1',
        targetObject: 'opportunity',
        targetField: 'dealScore',
        recordId: 'o1',
        overrideValue: 42,
        overrideValueText: null,
        active: true,
      },
    ]);
    const before = client.mutations;
    const result = await upsertOverride(client, 'opportunity', 'dealScore', 'o1', {
      numeric: 42,
    });
    expect(result).toBe('noop');
    expect(client.mutations).toBe(before);
  });
});

describe('loadOverridesForObject', () => {
  it('returns active AND inactive rows for the object, none for others', async () => {
    const client = new FakeClient();
    client.seed('formulaOverride', [
      {
        id: 'p1',
        name: 'opportunity.dealScore#o1',
        targetObject: 'opportunity',
        targetField: 'dealScore',
        recordId: 'o1',
        overrideValue: 1,
        overrideValueText: null,
        active: true,
      },
      {
        id: 'p2',
        name: 'opportunity.tier#o2',
        targetObject: 'opportunity',
        targetField: 'tier',
        recordId: 'o2',
        overrideValue: null,
        overrideValueText: '"GOLD"',
        active: false,
      },
      {
        id: 'p3',
        name: 'company.score#c1',
        targetObject: 'company',
        targetField: 'score',
        recordId: 'c1',
        overrideValue: 3,
        overrideValueText: null,
        active: true,
      },
    ]);
    const rows = await loadOverridesForObject(client, 'opportunity');
    expect(rows.map((row) => row.id).sort()).toEqual(['p1', 'p2']);
  });
});
