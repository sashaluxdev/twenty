import { describe, expect, it } from 'vitest';

import { deriveObjectFields } from 'src/front-components/lib/formula-field-input';
import { type MetadataObjectInfo } from 'src/logic-functions/lib/metadata-objects';

// deriveObjectFields is the pure mapping the old useObjectFields hook body did
// inline: from the shared catalog it produces the suggestible `fields` for the
// autocomplete dropdown plus `kindsByName` over EVERY active field (unfiltered by
// suggestibility — the pre-save kind check needs non-suggestible kinds too).

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
    // isSystem — excluded from both fields and kindsByName.
    {
      id: 'f-createdby',
      name: 'createdBy',
      type: 'TEXT',
      isActive: true,
      isSystem: true,
      label: 'Created By',
    },
    // inactive — excluded from both.
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

  it('builds kindsByName over every active non-system field, including non-suggestible kinds', () => {
    const { kindsByName } = deriveObjectFields([opportunity], 'opportunity');
    // MULTI_SELECT is present so the pre-save kind check can reject it.
    expect(kindsByName.get('tags')).toBe('MULTI_SELECT');
    expect(kindsByName.get('amount')).toBe('NUMBER');
    expect(kindsByName.get('stage')).toBe('SELECT');
    // System and inactive fields are excluded.
    expect(kindsByName.has('createdBy')).toBe(false);
    expect(kindsByName.has('legacy')).toBe(false);
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
