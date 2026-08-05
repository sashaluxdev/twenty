import { describe, expect, it } from 'vitest';

import { deriveObjectFields } from 'src/front-components/lib/formula-field-input';
import { type MetadataObjectInfo } from 'src/logic-functions/lib/metadata-objects';

// deriveObjectFields is the pure mapping the old useObjectFields hook body did
// inline: from the shared catalog it produces the suggestible `fields` for the
// autocomplete dropdown plus `kindsByName` over EVERY field of the object,
// unfiltered — the pre-save kind check needs non-suggestible kinds AND
// system/inactive kinds, matching the server's kinds provider exactly.

const opportunity: MetadataObjectInfo = {
  id: 'obj-opportunity',
  nameSingular: 'opportunity',
  labelIdentifierFieldMetadataId: null,
  fields: [
    {
      id: 'f-amount',
      name: 'amount',
      type: 'NUMBER',
      isActive: true,
      isSystem: false,
      label: 'Amount',
    },
    {
      id: 'f-stage',
      name: 'stage',
      type: 'SELECT',
      isActive: true,
      isSystem: false,
      label: 'Deal Stage',
      options: [
        { value: 'NEW', label: 'New', color: 'blue' },
        { value: 'WON', label: 'Won', color: 'green' },
      ],
    },
    // MULTI_SELECT is a real active kind that must appear in kindsByName (so the
    // pre-save check can reject a string comparison against it) but is NOT
    // suggestible, so it must never appear in `fields`.
    {
      id: 'f-tags',
      name: 'tags',
      type: 'MULTI_SELECT',
      isActive: true,
      isSystem: false,
      label: 'Tags',
    },
    // isSystem — never suggested, but present in kindsByName because the server
    // types it for real and would reject a bad reference at save.
    {
      id: 'f-createdby',
      name: 'createdBy',
      type: 'TEXT',
      isActive: true,
      isSystem: true,
      label: 'Created By',
    },
    {
      id: 'f-createdat',
      name: 'createdAt',
      type: 'DATE_TIME',
      isActive: true,
      isSystem: true,
      label: 'Creation date',
    },
    // inactive — likewise excluded from suggestions, present in kindsByName.
    {
      id: 'f-legacy',
      name: 'legacy',
      type: 'TEXT',
      isActive: false,
      isSystem: false,
      label: 'Legacy',
    },
  ],
};

describe('deriveObjectFields', () => {
  it('returns an empty result for an undefined target object', () => {
    const result = deriveObjectFields([opportunity], undefined);
    expect(result.fields).toEqual([]);
    expect(result.kindsByName.size).toBe(0);
  });

  it('returns an empty result when the target object is not in the catalog', () => {
    const result = deriveObjectFields([opportunity], 'unknownObject');
    expect(result.fields).toEqual([]);
    expect(result.kindsByName.size).toBe(0);
  });

  it('includes only active, non-system, suggestible fields in `fields`', () => {
    const { fields } = deriveObjectFields([opportunity], 'opportunity');
    expect(fields.map((field) => field.name)).toEqual(['amount', 'stage']);
  });

  it('builds kindsByName over every field, including non-suggestible kinds', () => {
    const { kindsByName } = deriveObjectFields([opportunity], 'opportunity');
    // MULTI_SELECT is present so the pre-save kind check can reject it.
    expect(kindsByName.get('tags')).toBe('MULTI_SELECT');
    expect(kindsByName.get('amount')).toBe('NUMBER');
    expect(kindsByName.get('stage')).toBe('SELECT');
  });

  it('includes system and inactive fields in kindsByName, matching the server kinds provider', () => {
    // The server's loadFieldKinds does not filter; if the editor filtered here
    // it would infer `unknown` (skip-never-reject) for these references and
    // silently accept an expression the server rejects at save.
    const { kindsByName } = deriveObjectFields([opportunity], 'opportunity');
    expect(kindsByName.get('createdBy')).toBe('TEXT');
    expect(kindsByName.get('createdAt')).toBe('DATE_TIME');
    expect(kindsByName.get('legacy')).toBe('TEXT');
  });

  it('maps SELECT options to {value,label} pairs, label falling back to value', () => {
    const { fields } = deriveObjectFields([opportunity], 'opportunity');
    const stage = fields.find((field) => field.name === 'stage');
    expect(stage?.options).toEqual([
      { value: 'NEW', label: 'New' },
      { value: 'WON', label: 'Won' },
    ]);
  });

  it('uses the field label, sorted by label', () => {
    const { fields } = deriveObjectFields([opportunity], 'opportunity');
    // "Amount" < "Deal Stage" — sorted by label.
    expect(fields.map((field) => field.label)).toEqual(['Amount', 'Deal Stage']);
  });

  it('degrades gracefully when older fixtures carry no label or options', () => {
    const legacyObject: MetadataObjectInfo = {
      id: 'obj-company',
      nameSingular: 'company',
      labelIdentifierFieldMetadataId: null,
      fields: [
        {
          id: 'f-revenue',
          name: 'annualRecurringRevenue',
          type: 'NUMBER',
          isActive: true,
          isSystem: false,
        },
      ],
    };
    const { fields } = deriveObjectFields([legacyObject], 'company');
    expect(fields).toEqual([
      {
        name: 'annualRecurringRevenue',
        label: 'annualRecurringRevenue',
        type: 'NUMBER',
      },
    ]);
  });
});
