import { beforeEach, describe, expect, it } from 'vitest';

import { FakeClient } from 'src/logic-functions/lib/__tests__/fake-client';
import { overrideKey } from 'src/logic-functions/lib/override-repository';
import { type VariationConfigRecord } from 'src/logic-functions/lib/variation-types';
import {
  buildVariationLabelData,
  loadDivergedFields,
  loadVariationList,
  nextVariationLabel,
  resolveHiddenReason,
  resolveWidgetRole,
  resyncDivergedField,
} from 'src/front-components/lib/variation-widget-data';

const COMPANY_OBJECT = {
  id: 'obj-company',
  nameSingular: 'company',
  labelIdentifierFieldMetadataId: 'field-name',
  fields: [
    { id: 'field-name', name: 'name', type: 'TEXT', isActive: true, isSystem: false },
    { id: 'field-employees', name: 'employees', type: 'NUMBER', isActive: true, isSystem: false },
    { id: 'field-industry', name: 'industry', type: 'TEXT', isActive: true, isSystem: false },
    { id: 'field-city', name: 'city', type: 'TEXT', isActive: true, isSystem: false },
    { id: 'field-primary', name: 'primaryRecord', type: 'RELATION', isActive: true, isSystem: false },
  ],
};

const CONFIG: VariationConfigRecord = {
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

// A person object whose label identifier is a FULL_NAME composite, to exercise
// the composite label sub-selection riding the batched ids query.
const PERSON_OBJECT = {
  id: 'obj-person',
  nameSingular: 'person',
  labelIdentifierFieldMetadataId: 'field-fullname',
  fields: [
    { id: 'field-fullname', name: 'name', type: 'FULL_NAME', isActive: true, isSystem: false },
    { id: 'field-primary', name: 'primaryRecord', type: 'RELATION', isActive: true, isSystem: false },
  ],
};

const PERSON_CONFIG: VariationConfigRecord = {
  ...CONFIG,
  id: 'vc-person',
  name: 'person',
  targetObject: 'person',
};

// An object with no resolvable label identifier -> labels are all null.
const NO_LABEL_OBJECT = {
  id: 'obj-company',
  nameSingular: 'company',
  labelIdentifierFieldMetadataId: null,
  fields: [
    { id: 'field-employees', name: 'employees', type: 'NUMBER', isActive: true, isSystem: false },
    { id: 'field-primary', name: 'primaryRecord', type: 'RELATION', isActive: true, isSystem: false },
  ],
};

const seedConfig = (client: FakeClient, overrides: Partial<VariationConfigRecord> = {}) => {
  client.seed('variationConfig', [{ ...CONFIG, ...overrides }]);
};

describe('variation-widget-data', () => {
  let client: FakeClient;

  beforeEach(() => {
    client = new FakeClient();
    client.setObjectsWithFields([COMPANY_OBJECT]);
  });

  describe('resolveWidgetRole', () => {
    it('is hidden when the object has no variation config', async () => {
      client.seed('company', [{ id: 'p1', name: 'Acme', primaryRecordId: null }]);

      const role = await resolveWidgetRole(client, 'company', 'p1');

      expect(role).toEqual({ kind: 'hidden' });
    });

    it('is hidden when the config is disabled', async () => {
      seedConfig(client, { enabled: false });
      client.seed('company', [{ id: 'p1', name: 'Acme', primaryRecordId: null }]);

      const role = await resolveWidgetRole(client, 'company', 'p1');

      expect(role).toEqual({ kind: 'hidden' });
    });

    it('is a primary when the record has a null pointer', async () => {
      seedConfig(client);
      client.seed('company', [{ id: 'p1', name: 'Acme', primaryRecordId: null }]);

      const role = await resolveWidgetRole(client, 'company', 'p1');

      expect(role.kind).toBe('primary');
      if (role.kind === 'primary') {
        expect(role.config.id).toBe('vc1');
      }
    });

    it('is a live variation with a derived primary label', async () => {
      seedConfig(client);
      client.seed('company', [
        { id: 'p1', name: 'Acme', primaryRecordId: null },
        { id: 'v1', name: 'Acme (variation)', primaryRecordId: 'p1' },
      ]);

      const role = await resolveWidgetRole(client, 'company', 'v1');

      expect(role).toMatchObject({
        kind: 'variation',
        primaryRecordId: 'p1',
        frozen: false,
        primaryLabel: 'Acme',
      });
    });

    it('is a frozen variation (still labelled) when the primary is trashed', async () => {
      seedConfig(client);
      client.seed('company', [
        { id: 'p1', name: 'Acme', primaryRecordId: null, deletedAt: '2026-01-01T00:00:00.000Z' },
        { id: 'v1', name: 'Acme (variation)', primaryRecordId: 'p1' },
      ]);

      const role = await resolveWidgetRole(client, 'company', 'v1');

      expect(role).toMatchObject({
        kind: 'variation',
        primaryRecordId: 'p1',
        frozen: true,
        primaryLabel: 'Acme',
      });
    });

    it('is a frozen variation with a null label when the primary is destroyed', async () => {
      seedConfig(client);
      client.seed('company', [
        { id: 'v1', name: 'Acme (variation)', primaryRecordId: 'gone' },
      ]);

      const role = await resolveWidgetRole(client, 'company', 'v1');

      expect(role).toMatchObject({
        kind: 'variation',
        primaryRecordId: 'gone',
        frozen: true,
        primaryLabel: null,
      });
    });
  });

  describe('resolveHiddenReason', () => {
    it("is 'disabled-config' when a disabled config claims the record's object", async () => {
      seedConfig(client, { enabled: false });
      client.seed('company', [{ id: 'p1', name: 'Acme', primaryRecordId: null }]);

      const reason = await resolveHiddenReason(client, 'p1');

      expect(reason).toBe('disabled-config');
    });

    it("is 'no-config' when no variation config exists at all", async () => {
      client.seed('company', [{ id: 'p1', name: 'Acme', primaryRecordId: null }]);

      const reason = await resolveHiddenReason(client, 'p1');

      expect(reason).toBe('no-config');
    });

    it("is 'no-config' when the only config is enabled (not disabled)", async () => {
      seedConfig(client);
      client.seed('company', [{ id: 'p1', name: 'Acme', primaryRecordId: null }]);

      const reason = await resolveHiddenReason(client, 'p1');

      expect(reason).toBe('no-config');
    });

    it("is 'no-config' when a disabled config exists but does not claim this record", async () => {
      seedConfig(client, { enabled: false });

      const reason = await resolveHiddenReason(client, 'not-a-company-record');

      expect(reason).toBe('no-config');
    });
  });

  describe('resolveWidgetRole error propagation', () => {
    // A GraphQL error the client surfaces as a thrown object carrying errors[];
    // BAD_USER_INPUT is not in withRetry's RETRYABLE_CODES, so it rethrows at
    // once rather than looping.
    const NON_RETRYABLE_ERROR = {
      errors: [{ extensions: { code: 'BAD_USER_INPUT' } }],
      message: 'boom',
    };

    it('propagates a read error instead of silently returning hidden', async () => {
      seedConfig(client);
      client.seed('company', [{ id: 'p1', name: 'Acme', primaryRecordId: null }]);
      client.failQueriesFor('variationConfigs', NON_RETRYABLE_ERROR);

      await expect(resolveWidgetRole(client, 'company', 'p1')).rejects.toBe(
        NON_RETRYABLE_ERROR,
      );
    });

    it('resolves normally when the config and reads succeed', async () => {
      seedConfig(client);
      client.seed('company', [{ id: 'p1', name: 'Acme', primaryRecordId: null }]);

      const role = await resolveWidgetRole(client, 'company', 'p1');

      expect(role.kind).toBe('primary');
    });
  });

  describe('loadVariationList', () => {
    it('counts diverged fields (active ∩ syncable) with a single overrides query', async () => {
      client.seed('company', [
        { id: 'p1', name: 'Acme', primaryRecordId: null },
        { id: 'v1', name: 'Acme (variation)', primaryRecordId: 'p1' },
        { id: 'v2', name: 'Acme (variation 2)', primaryRecordId: 'p1' },
      ]);
      client.seed('formulaOverride', [
        // Two active overrides on syncable fields -> counted.
        { id: 'o1', name: overrideKey('company', 'employees', 'v1'), targetObject: 'company', targetField: 'employees', recordId: 'v1', overrideValue: 1, overrideValueText: null, active: true },
        { id: 'o2', name: overrideKey('company', 'industry', 'v1'), targetObject: 'company', targetField: 'industry', recordId: 'v1', overrideValue: null, overrideValueText: '"Old"', active: true },
        // Active override on a NON-syncable field (label identifier) -> excluded.
        { id: 'o3', name: overrideKey('company', 'name', 'v1'), targetObject: 'company', targetField: 'name', recordId: 'v1', overrideValue: null, overrideValueText: '"x"', active: true },
        // Inactive override on a syncable field -> excluded.
        { id: 'o4', name: overrideKey('company', 'city', 'v1'), targetObject: 'company', targetField: 'city', recordId: 'v1', overrideValue: null, overrideValueText: '"LA"', active: false },
      ]);

      const list = await loadVariationList(client, CONFIG, 'p1');

      expect(list).toEqual([
        { id: 'v1', label: 'Acme (variation)', divergedCount: 2 },
        { id: 'v2', label: 'Acme (variation 2)', divergedCount: 0 },
      ]);

      const overrideQueries = client.querySelections.filter(
        (selection) => Object.keys(selection)[0] === 'formulaOverrides',
      );
      expect(overrideQueries).toHaveLength(1);
    });

    it('issues exactly ONE records query for ids+labels across all variations', async () => {
      client.seed('company', [
        { id: 'p1', name: 'Acme', primaryRecordId: null },
        { id: 'v1', name: 'Acme (variation)', primaryRecordId: 'p1' },
        { id: 'v2', name: 'Acme (variation 2)', primaryRecordId: 'p1' },
        { id: 'v3', name: 'Acme (variation 3)', primaryRecordId: 'p1' },
      ]);

      await loadVariationList(client, CONFIG, 'p1');

      const recordQueries = client.querySelections.filter((selection) => {
        const key = Object.keys(selection)[0];
        return key === 'company' || key === 'companies';
      });
      expect(recordQueries).toHaveLength(1);
    });

    it('extracts TEXT labels and selects the label scalar in the ids query', async () => {
      client.seed('company', [
        { id: 'p1', name: 'Acme', primaryRecordId: null },
        { id: 'v1', name: 'Acme (variation)', primaryRecordId: 'p1' },
      ]);

      const list = await loadVariationList(client, CONFIG, 'p1');
      expect(list).toEqual([
        { id: 'v1', label: 'Acme (variation)', divergedCount: 0 },
      ]);

      const recordsQuery = client.querySelections.find(
        (selection) => Object.keys(selection)[0] === 'companies',
      );
      expect(recordsQuery.companies.edges.node).toMatchObject({
        id: true,
        name: true,
      });
    });

    it('extracts FULL_NAME labels with the composite sub-selection in the ids query', async () => {
      client.setObjectsWithFields([PERSON_OBJECT]);
      client.seed('person', [
        { id: 'v1', name: { firstName: 'Jane', lastName: 'Doe' }, primaryRecordId: 'p1' },
      ]);

      const list = await loadVariationList(client, PERSON_CONFIG, 'p1');
      expect(list).toEqual([{ id: 'v1', label: 'Jane Doe', divergedCount: 0 }]);

      const recordsQuery = client.querySelections.find(
        (selection) => Object.keys(selection)[0] === 'people',
      );
      expect(recordsQuery.people.edges.node.name).toEqual({
        firstName: true,
        lastName: true,
      });
    });

    it('returns null labels and an ids-only query when no label field resolves', async () => {
      client.setObjectsWithFields([NO_LABEL_OBJECT]);
      client.seed('company', [
        { id: 'v1', name: 'ignored', primaryRecordId: 'p1' },
        { id: 'v2', name: 'ignored 2', primaryRecordId: 'p1' },
      ]);

      const list = await loadVariationList(client, CONFIG, 'p1');
      expect(list).toEqual([
        { id: 'v1', label: null, divergedCount: 0 },
        { id: 'v2', label: null, divergedCount: 0 },
      ]);

      const recordsQuery = client.querySelections.find(
        (selection) => Object.keys(selection)[0] === 'companies',
      );
      expect(Object.keys(recordsQuery.companies.edges.node)).toEqual(['id']);
    });
  });

  describe('loadDivergedFields', () => {
    it('returns the active-override ∩ syncable fields with their kinds', async () => {
      client.seed('formulaOverride', [
        { id: 'o1', name: overrideKey('company', 'employees', 'v1'), targetObject: 'company', targetField: 'employees', recordId: 'v1', overrideValue: 1, overrideValueText: null, active: true },
        { id: 'o2', name: overrideKey('company', 'industry', 'v1'), targetObject: 'company', targetField: 'industry', recordId: 'v1', overrideValue: null, overrideValueText: '"Old"', active: true },
        { id: 'o3', name: overrideKey('company', 'name', 'v1'), targetObject: 'company', targetField: 'name', recordId: 'v1', overrideValue: null, overrideValueText: '"x"', active: true },
      ]);

      const fields = await loadDivergedFields(client, CONFIG, 'v1');

      expect(fields).toEqual([
        { name: 'employees', kind: 'NUMBER' },
        { name: 'industry', kind: 'TEXT' },
      ]);
    });
  });

  describe('nextVariationLabel', () => {
    it('returns the plain base for the first variation', () => {
      expect(nextVariationLabel('Acme', [])).toBe('Acme (variation)');
    });

    it('numbers the second variation', () => {
      expect(nextVariationLabel('Acme', ['Acme (variation)'])).toBe('Acme (variation 2)');
    });

    it('is gap-tolerant: continues past the max taken number', () => {
      expect(
        nextVariationLabel('Acme', ['Acme (variation)', 'Acme (variation 5)']),
      ).toBe('Acme (variation 6)');
    });

    it('escapes regex-hostile primary labels', () => {
      expect(
        nextVariationLabel('Acme (test)', ['Acme (test) (variation)']),
      ).toBe('Acme (test) (variation 2)');
    });
  });

  describe('buildVariationLabelData', () => {
    it('writes a numbered TEXT label', () => {
      const data = buildVariationLabelData(
        { name: 'name', kind: 'TEXT' },
        { name: 'Acme' },
        ['Acme (variation)'],
      );

      expect(data).toEqual({ name: 'Acme (variation 2)' });
    });

    it('numbers the FULL_NAME lastName and copies the firstName', () => {
      const data = buildVariationLabelData(
        { name: 'fullName', kind: 'FULL_NAME' },
        { fullName: { firstName: 'Jane', lastName: 'Doe' } },
        ['Doe (variation)'],
      );

      expect(data).toEqual({
        fullName: { firstName: 'Jane', lastName: 'Doe (variation 2)' },
      });
    });

    it('writes no label for an unknown label-field kind', () => {
      const data = buildVariationLabelData(
        { name: 'weird', kind: 'ADDRESS' },
        { weird: {} },
        [],
      );

      expect(data).toEqual({});
    });

    it('writes no label when there is no label field', () => {
      expect(buildVariationLabelData(null, {}, [])).toEqual({});
    });
  });

  describe('resyncDivergedField', () => {
    it('deactivates the override then copies the primary value', async () => {
      client.seed('company', [
        { id: 'p1', name: 'Acme', employees: 50, primaryRecordId: null },
        { id: 'v1', name: 'Acme (variation)', employees: 10, primaryRecordId: 'p1' },
      ]);
      client.seed('formulaOverride', [
        { id: 'o1', name: overrideKey('company', 'employees', 'v1'), targetObject: 'company', targetField: 'employees', recordId: 'v1', overrideValue: 10, overrideValueText: null, active: true },
      ]);

      const outcome = await resyncDivergedField(client, CONFIG, 'v1', {
        name: 'employees',
        kind: 'NUMBER',
      });

      expect(outcome).toMatchObject({ changed: true, changedFields: ['employees'] });
      expect(client.get('company', 'v1')!.employees).toBe(50);
      const override = client.get('formulaOverride', 'o1')!;
      expect(override.active).toBe(false);
    });

    it('leaves the override untouched and writes nothing when the primary is frozen', async () => {
      client.seed('company', [
        { id: 'v1', name: 'Acme (variation)', employees: 10, primaryRecordId: 'gone' },
      ]);
      client.seed('formulaOverride', [
        { id: 'o1', name: overrideKey('company', 'employees', 'v1'), targetObject: 'company', targetField: 'employees', recordId: 'v1', overrideValue: 10, overrideValueText: null, active: true },
      ]);

      const outcome = await resyncDivergedField(client, CONFIG, 'v1', {
        name: 'employees',
        kind: 'NUMBER',
      });

      expect(outcome).toEqual({ frozen: true });
      expect(client.get('formulaOverride', 'o1')!.active).toBe(true);
      expect(client.mutations).toBe(0);
    });
  });
});
