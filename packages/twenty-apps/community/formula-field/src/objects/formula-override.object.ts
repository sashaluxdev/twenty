import { defineObject, FieldType } from 'twenty-sdk/define';

// FormulaOverride — a per-record manual override of a computed value (feature #2).
// Formulas are column-level, but an override applies to ONE record, so it can't
// live on FormulaDefinition; it lives here, one row per (targetObject, recordId,
// targetField). This is a TECHNICAL object: no navigation item and no index view,
// so it stays invisible to end users (their business objects are untouched). The
// recompute engine skips any record that has an override row, and the Formulas
// widget reads it to show the override state / pill.

export const FORMULA_OVERRIDE_OBJECT_UNIVERSAL_IDENTIFIER =
  '05f96d3d-713e-42be-965c-9100db3e2180';

export const FORMULA_OVERRIDE_FIELDS = {
  name: '56be35ed-6825-479e-93be-d93aae2a773e',
  targetObject: '0fd0aa24-8a0b-4e7b-958f-e2f0350ef197',
  recordId: '3a698909-1d0a-4e27-ad60-aa4e439f3171',
  targetField: '04418455-8477-406a-ba43-b85d75cd8d3f',
  overrideValue: '49ad7e7d-14c1-4d68-ad02-047e2f7abac0',
  active: 'f50b09d7-a643-4e2b-a93f-68b7bbaae1b6',
} as const;

export default defineObject({
  universalIdentifier: FORMULA_OVERRIDE_OBJECT_UNIVERSAL_IDENTIFIER,
  nameSingular: 'formulaOverride',
  namePlural: 'formulaOverrides',
  labelSingular: 'Formula override',
  labelPlural: 'Formula overrides',
  description:
    'Technical: per-record manual override of a computed formula value.',
  icon: 'IconLock',
  labelIdentifierFieldMetadataUniversalIdentifier: FORMULA_OVERRIDE_FIELDS.name,
  fields: [
    {
      universalIdentifier: FORMULA_OVERRIDE_FIELDS.name,
      type: FieldType.TEXT,
      name: 'name',
      label: 'Name',
      description: 'Internal key: <targetObject>.<targetField>#<recordId>.',
      icon: 'IconKey',
    },
    {
      universalIdentifier: FORMULA_OVERRIDE_FIELDS.targetObject,
      type: FieldType.TEXT,
      name: 'targetObject',
      label: 'Target object',
      description: 'nameSingular of the overridden record’s object.',
      icon: 'IconBox',
    },
    {
      universalIdentifier: FORMULA_OVERRIDE_FIELDS.recordId,
      type: FieldType.TEXT,
      name: 'recordId',
      label: 'Record id',
      description: 'Id of the specific record whose value is overridden.',
      icon: 'IconId',
    },
    {
      universalIdentifier: FORMULA_OVERRIDE_FIELDS.targetField,
      type: FieldType.TEXT,
      name: 'targetField',
      label: 'Target field',
      description: 'The value field being overridden.',
      icon: 'IconMathSymbols',
    },
    {
      universalIdentifier: FORMULA_OVERRIDE_FIELDS.overrideValue,
      type: FieldType.NUMBER,
      name: 'overrideValue',
      label: 'Override value',
      description: 'The manual value pinned by the user.',
      icon: 'IconPencil',
    },
    {
      universalIdentifier: FORMULA_OVERRIDE_FIELDS.active,
      type: FieldType.BOOLEAN,
      name: 'active',
      label: 'Active',
      description:
        'When true the override pins the record; when false the formula runs, ' +
        'but the last override value is retained so it can be restored.',
      icon: 'IconToggleRight',
      defaultValue: true,
    },
  ],
});
