import { defineObject, FieldType } from 'twenty-sdk/define';

// VariationConfig — one row per object with variations enabled. Any record of
// that object with a non-null `<relationFieldName>Id` pointer IS a variation of
// the record it points to; a null pointer means "primary" (or a plain record on
// an object with no config). This is the ENTIRE data model for record variations
// (design 2026-07-07): the relation field this config provisions is
// simultaneously the data model, the per-record sync scope, and the per-record
// source pointer. See docs/superpowers/specs/2026-07-07-record-variations-design.md.

export const VARIATION_CONFIG_OBJECT_UNIVERSAL_IDENTIFIER =
  '205a2c5a-d8e6-49b3-bd16-00527de8d845';

export const VARIATION_CONFIG_FIELDS = {
  name: 'd0dc73bf-b2e9-432c-a768-a9deda6419e1',
  targetObject: '0c57eba9-edb0-454c-ac51-2a08428dcd98',
  relationFieldName: '29200c51-b83e-491a-9dcf-d51c14dcf72e',
  createdRelationField: '7f409dcd-454e-40b7-9dcc-267913069418',
  enabled: '7d32abb9-b6d3-46d8-b475-b628a8c3d0b6',
  lastSyncedAt: '19e1bc28-f526-4925-afc0-c68a78f85677',
  lastError: '71869f54-7640-44be-b9b4-d400b557eae3',
  status: 'b8d8936b-b0e8-43f0-8f5e-71dd803b453c',
  statusReason: 'dcd0e241-534f-414f-952a-c8484ef0c39f',
} as const;

export default defineObject({
  universalIdentifier: VARIATION_CONFIG_OBJECT_UNIVERSAL_IDENTIFIER,
  nameSingular: 'variationConfig',
  namePlural: 'variationConfigs',
  labelSingular: 'Variation config',
  labelPlural: 'Variation configs',
  description:
    'Enables record variations on an object: a primaryRecord relation plus ' +
    'automatic field sync from primary to variation.',
  icon: 'IconGitFork',
  labelIdentifierFieldMetadataUniversalIdentifier: VARIATION_CONFIG_FIELDS.name,
  fields: [
    {
      universalIdentifier: VARIATION_CONFIG_FIELDS.name,
      type: FieldType.TEXT,
      name: 'name',
      label: 'Name',
      description:
        'Deterministic key = target object nameSingular (uniqueness anchor: ' +
        'one config per object).',
      icon: 'IconTag',
    },
    {
      universalIdentifier: VARIATION_CONFIG_FIELDS.targetObject,
      type: FieldType.TEXT,
      name: 'targetObject',
      label: 'Target object',
      description: 'nameSingular of the object variations are enabled on.',
      icon: 'IconBox',
    },
    {
      universalIdentifier: VARIATION_CONFIG_FIELDS.relationFieldName,
      type: FieldType.TEXT,
      name: 'relationFieldName',
      label: 'Relation field name',
      description:
        'Name of the self-referencing MANY_TO_ONE relation field this config ' +
        'created ("primaryRecord" by default). Stored explicitly, never ' +
        're-derived.',
      icon: 'IconLink',
    },
    {
      universalIdentifier: VARIATION_CONFIG_FIELDS.createdRelationField,
      type: FieldType.BOOLEAN,
      name: 'createdRelationField',
      label: 'Created relation field',
      description:
        'True when the wizard created the relation field for this config — ' +
        'the disable/destroy lifecycle only deactivates a field it created.',
      icon: 'IconWand',
      defaultValue: false,
      isUIEditable: false,
    },
    {
      universalIdentifier: VARIATION_CONFIG_FIELDS.enabled,
      type: FieldType.BOOLEAN,
      name: 'enabled',
      label: 'Enabled',
      description: 'When off, variation sync does not run for this object.',
      icon: 'IconToggleRight',
      defaultValue: true,
    },
    {
      universalIdentifier: VARIATION_CONFIG_FIELDS.lastSyncedAt,
      type: FieldType.DATE_TIME,
      name: 'lastSyncedAt',
      label: 'Last synced at',
      description: 'Timestamp of the last hourly sweep pass over this object.',
      icon: 'IconClock',
      isUIEditable: false,
    },
    {
      universalIdentifier: VARIATION_CONFIG_FIELDS.lastError,
      type: FieldType.TEXT,
      name: 'lastError',
      label: 'Last error',
      description: 'Last sweep error, empty when healthy.',
      icon: 'IconAlertTriangle',
      isUIEditable: false,
    },
    {
      universalIdentifier: VARIATION_CONFIG_FIELDS.status,
      type: FieldType.TEXT,
      name: 'status',
      label: 'Status',
      description: 'Operational status (system-managed), same posture as FormulaDefinition.',
      icon: 'IconHeartbeat',
      isUIEditable: false,
    },
    {
      universalIdentifier: VARIATION_CONFIG_FIELDS.statusReason,
      type: FieldType.TEXT,
      name: 'statusReason',
      label: 'Status reason',
      description:
        'Diagnostic detail, e.g. how many variations were skipped this sweep ' +
        'because their primary itself turned out to be a variation ' +
        '(single-level guard).',
      icon: 'IconInfoCircle',
      isUIEditable: false,
    },
  ],
});
