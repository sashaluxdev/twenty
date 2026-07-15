import { defineObject, FieldType } from 'twenty-sdk/define';

// FormulaDefinition — one record per formula instance. It describes a computed
// value field on a target object: which object, which NUMBER value field, the
// expression to evaluate, the parsed dependency index (persisted so recompute
// triggers avoid re-parsing), and the last-evaluation bookkeeping surfaced to
// the user (timestamp, value, error). See ADR 0001.

export const FORMULA_DEFINITION_OBJECT_UNIVERSAL_IDENTIFIER =
  '45d24f6f-6224-414e-a6f3-fbceb1259741';

export const FORMULA_DEFINITION_FIELDS = {
  name: '704bbdc2-f6c1-44e2-bc38-62bf5611bf8a',
  targetObject: 'c6cd6e1c-e06c-4b7e-9337-03b139fe1358',
  targetField: '9576bd19-db1b-428f-adf9-7b1dbc78e613',
  targetFieldType: '3a7d41e8-d055-4573-85f9-a38d5f23c258',
  currencyCode: '73e22ce5-7b4e-48d4-9f96-00ca3973af35',
  createdField: '9cc13837-c40a-4987-947e-a6635e94aa12',
  outputFormat: '89f978e2-b08a-4778-98d6-fbfe52efd162',
  targetFieldSettings: 'b1e7c2a4-9f3d-4c86-8a71-2d5e0f6b4c19',
  expression: 'd7750c25-b265-48aa-92a7-a649855449d7',
  description: '7c2a1f5e-4b8d-4e2a-9f63-0d81c5b7ae24',
  dependencies: 'a39455b0-c789-441a-8fea-1d6c87277446',
  enabled: '64790652-18a3-47d9-a1ac-8883d0830a7a',
  lastEvaluatedAt: '2ec77311-1738-44f0-8179-ba8f11557282',
  lastValue: 'c84ad4eb-709b-4897-aec4-bfcfb9177ff4',
  lastValueText: 'c24bd9f9-9d3e-4fb1-b799-d501bec3f4af',
  lastError: 'b4d168a8-bb76-4c32-b431-be862934dcbd',
  status: 'e3e1fcbf-c19d-4d24-a7cd-b7b1c7ad3c70',
  statusReason: '0e500f2b-30c2-489a-aee6-0d717e1e0418',
  order: '4f4cabaa-9983-4967-91f7-ef2367aa8b3c',
} as const;

export default defineObject({
  universalIdentifier: FORMULA_DEFINITION_OBJECT_UNIVERSAL_IDENTIFIER,
  nameSingular: 'formulaDefinition',
  namePlural: 'formulaDefinitions',
  labelSingular: 'Formula definition',
  labelPlural: 'Formula definitions',
  description:
    'A computed formula field: target object + value field + expression.',
  icon: 'IconMathFunction',
  labelIdentifierFieldMetadataUniversalIdentifier:
    FORMULA_DEFINITION_FIELDS.name,
  fields: [
    {
      universalIdentifier: FORMULA_DEFINITION_FIELDS.name,
      type: FieldType.TEXT,
      name: 'name',
      label: 'Name',
      description: 'Human-friendly name for this formula.',
      icon: 'IconTag',
    },
    {
      universalIdentifier: FORMULA_DEFINITION_FIELDS.targetObject,
      type: FieldType.TEXT,
      name: 'targetObject',
      label: 'Target object',
      description: 'nameSingular of the object this formula computes on.',
      icon: 'IconBox',
    },
    {
      universalIdentifier: FORMULA_DEFINITION_FIELDS.targetField,
      type: FieldType.TEXT,
      name: 'targetField',
      label: 'Target field',
      description: 'Name of the NUMBER value field to write the result into.',
      icon: 'IconMathSymbols',
    },
    {
      universalIdentifier: FORMULA_DEFINITION_FIELDS.targetFieldType,
      type: FieldType.TEXT,
      name: 'targetFieldType',
      label: 'Target field type',
      description:
        'Field type of the value field: NUMBER (default), CURRENCY, DATE or ' +
        'DATE_TIME. Currency values are read and written as amountMicros; ' +
        'DATE/DATE_TIME use the Excel serial-date model (epoch-days).',
      icon: 'IconCurrencyDollar',
    },
    {
      universalIdentifier: FORMULA_DEFINITION_FIELDS.currencyCode,
      type: FieldType.TEXT,
      name: 'currencyCode',
      label: 'Currency code',
      description:
        'For CURRENCY value fields: the code written when a record has none ' +
        '(picked in the wizard; JPY when unset).',
      icon: 'IconCurrencyYen',
    },
    {
      universalIdentifier: FORMULA_DEFINITION_FIELDS.expression,
      type: FieldType.TEXT,
      name: 'expression',
      label: 'Expression',
      description: 'Arithmetic formula, e.g. "inputA + inputB * 2".',
      icon: 'IconMathFunction',
    },
    {
      universalIdentifier: FORMULA_DEFINITION_FIELDS.description,
      type: FieldType.TEXT,
      name: 'description',
      label: 'Description',
      description:
        'What this formula does, in human terms. Shown as a hover tooltip ' +
        'next to the formula in the Formulas tab.',
      icon: 'IconInfoCircle',
    },
    {
      universalIdentifier: FORMULA_DEFINITION_FIELDS.dependencies,
      type: FieldType.RAW_JSON,
      name: 'dependencies',
      label: 'Dependencies',
      description:
        'Parsed dependency index (auto-computed on save). Do not edit by hand.',
      icon: 'IconListTree',
      isUIEditable: false,
    },
    {
      universalIdentifier: FORMULA_DEFINITION_FIELDS.enabled,
      type: FieldType.BOOLEAN,
      name: 'enabled',
      label: 'Enabled',
      description: 'When off, the formula is not evaluated.',
      icon: 'IconToggleRight',
      defaultValue: true,
    },
    {
      universalIdentifier: FORMULA_DEFINITION_FIELDS.lastEvaluatedAt,
      type: FieldType.DATE_TIME,
      name: 'lastEvaluatedAt',
      label: 'Last evaluated at',
      description: 'Timestamp of the last successful evaluation.',
      icon: 'IconClock',
      isUIEditable: false,
    },
    {
      universalIdentifier: FORMULA_DEFINITION_FIELDS.lastValue,
      type: FieldType.NUMBER,
      name: 'lastValue',
      label: 'Last value',
      description: 'Most recently computed value (diagnostic).',
      icon: 'IconNumber',
      isUIEditable: false,
    },
    {
      universalIdentifier: FORMULA_DEFINITION_FIELDS.lastValueText,
      type: FieldType.TEXT,
      name: 'lastValueText',
      label: 'Last value text',
      description:
        'Most recently mirrored raw value (JSON-stringified, truncated to 500 ' +
        'chars) for non-engine mirror targets — lastValue is NUMBER-typed and ' +
        'stays null for mirrors. Diagnostic only; never read back for ' +
        'computation. System-managed.',
      icon: 'IconAbc',
      isUIEditable: false,
    },
    {
      universalIdentifier: FORMULA_DEFINITION_FIELDS.lastError,
      type: FieldType.TEXT,
      name: 'lastError',
      label: 'Last error',
      description: 'Last evaluation/validation error, empty when healthy.',
      icon: 'IconAlertTriangle',
      isUIEditable: false,
    },
    {
      universalIdentifier: FORMULA_DEFINITION_FIELDS.outputFormat,
      type: FieldType.TEXT,
      name: 'outputFormat',
      label: 'Output format',
      description:
        'Wizard-picked output format (integer / decimal / percent / ' +
        'currency / date / datetime). Doubles as saved draft progress: the ' +
        'wizard persists ' +
        'selections as they are made and resumes from them.',
      icon: 'IconForms',
    },
    {
      universalIdentifier: FORMULA_DEFINITION_FIELDS.targetFieldSettings,
      type: FieldType.TEXT,
      name: 'targetFieldSettings',
      label: 'Target field settings',
      description:
        'JSON-serialized display settings for the value field (decimals, ' +
        'number/currency format, date display) plus currency code. Persisted ' +
        'so the wizard resumes and the definition editor can restore/edit the ' +
        'exact chosen options. System-managed.',
      icon: 'IconAdjustments',
    },
    {
      universalIdentifier: FORMULA_DEFINITION_FIELDS.createdField,
      type: FieldType.BOOLEAN,
      name: 'createdField',
      label: 'Created field',
      description:
        'True when the wizard created the value field (and its FX Status ' +
        'companion) for this definition — the delete/restore lifecycle only ' +
        'deactivates/reactivates fields it created. Fields created via ' +
        'createOneField are stamped with the workspace custom application, ' +
        'not this app, so explicit provenance is required.',
      icon: 'IconWand',
      defaultValue: false,
      isUIEditable: false,
    },
    {
      universalIdentifier: FORMULA_DEFINITION_FIELDS.status,
      type: FieldType.TEXT,
      name: 'status',
      label: 'Status',
      description:
        'Operational status (system-managed): empty/OK = healthy, OFFLINE = ' +
        'an input field is deactivated or missing, UPSTREAM = a formula ' +
        'earlier in the dependency chain is broken.',
      icon: 'IconHeartbeat',
      isUIEditable: false,
    },
    {
      universalIdentifier: FORMULA_DEFINITION_FIELDS.statusReason,
      type: FieldType.TEXT,
      name: 'statusReason',
      label: 'Status reason',
      description:
        'What broke: the missing input (OFFLINE) or where in the chain the ' +
        'break is (UPSTREAM). System-managed.',
      icon: 'IconInfoCircle',
      isUIEditable: false,
    },
    {
      universalIdentifier: FORMULA_DEFINITION_FIELDS.order,
      type: FieldType.NUMBER,
      name: 'order',
      label: 'Order',
      description: 'Display position in the record-page Formula tab (managed by drag-to-reorder).',
      icon: 'IconArrowsSort',
      isUIEditable: false,
    },
  ],
});
