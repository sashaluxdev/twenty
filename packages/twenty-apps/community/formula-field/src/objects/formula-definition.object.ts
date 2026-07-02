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
  expression: 'd7750c25-b265-48aa-92a7-a649855449d7',
  dependencies: 'a39455b0-c789-441a-8fea-1d6c87277446',
  enabled: '64790652-18a3-47d9-a1ac-8883d0830a7a',
  lastEvaluatedAt: '2ec77311-1738-44f0-8179-ba8f11557282',
  lastValue: 'c84ad4eb-709b-4897-aec4-bfcfb9177ff4',
  lastError: 'b4d168a8-bb76-4c32-b431-be862934dcbd',
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
      universalIdentifier: FORMULA_DEFINITION_FIELDS.expression,
      type: FieldType.TEXT,
      name: 'expression',
      label: 'Expression',
      description: 'Arithmetic formula, e.g. "inputA + inputB * 2".',
      icon: 'IconMathFunction',
    },
    {
      universalIdentifier: FORMULA_DEFINITION_FIELDS.dependencies,
      type: FieldType.RAW_JSON,
      name: 'dependencies',
      label: 'Dependencies',
      description:
        'Parsed dependency index (auto-computed on save). Do not edit by hand.',
      icon: 'IconListTree',
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
    },
    {
      universalIdentifier: FORMULA_DEFINITION_FIELDS.lastValue,
      type: FieldType.NUMBER,
      name: 'lastValue',
      label: 'Last value',
      description: 'Most recently computed value (diagnostic).',
      icon: 'IconNumber',
    },
    {
      universalIdentifier: FORMULA_DEFINITION_FIELDS.lastError,
      type: FieldType.TEXT,
      name: 'lastError',
      label: 'Last error',
      description: 'Last evaluation/validation error, empty when healthy.',
      icon: 'IconAlertTriangle',
    },
  ],
});
