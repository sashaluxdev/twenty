import { defineView, ViewKey } from 'twenty-sdk/define';
import {
  FORMULA_DEFINITION_FIELDS,
  FORMULA_DEFINITION_OBJECT_UNIVERSAL_IDENTIFIER,
} from 'src/objects/formula-definition.object';

// Index view for FormulaDefinition — the fallback editor / admin surface for
// formulas (see ADR 0001). Shows the target object/field, the expression, the
// enabled flag, and the last value/error so failures are visible without
// digging.
export const FORMULA_DEFINITION_VIEW_UNIVERSAL_IDENTIFIER =
  '49fb9151-9a10-4fbc-9795-add4cb71fc16';

export default defineView({
  universalIdentifier: FORMULA_DEFINITION_VIEW_UNIVERSAL_IDENTIFIER,
  name: 'Formulas',
  objectUniversalIdentifier: FORMULA_DEFINITION_OBJECT_UNIVERSAL_IDENTIFIER,
  icon: 'IconMathFunction',
  key: ViewKey.INDEX,
  position: 0,
  fields: [
    {
      universalIdentifier: 'd72fa5c4-cdef-42f4-a21b-df24d89ce558',
      fieldMetadataUniversalIdentifier: FORMULA_DEFINITION_FIELDS.name,
      position: 0,
      isVisible: true,
      size: 180,
    },
    {
      universalIdentifier: 'e2eaae31-b4df-45e8-959a-b8b19c11f9f4',
      fieldMetadataUniversalIdentifier: FORMULA_DEFINITION_FIELDS.targetObject,
      position: 1,
      isVisible: true,
      size: 140,
    },
    {
      universalIdentifier: '5aeb1321-928d-4f60-acc7-fe7322c424ba',
      fieldMetadataUniversalIdentifier: FORMULA_DEFINITION_FIELDS.targetField,
      position: 2,
      isVisible: true,
      size: 140,
    },
    {
      universalIdentifier: '4a11ae4a-ebc7-4989-b520-af95ac4b78b4',
      fieldMetadataUniversalIdentifier: FORMULA_DEFINITION_FIELDS.expression,
      position: 3,
      isVisible: true,
      size: 240,
    },
    {
      universalIdentifier: 'c864a248-b52c-4c53-9d95-dcea6567fd1c',
      fieldMetadataUniversalIdentifier: FORMULA_DEFINITION_FIELDS.enabled,
      position: 4,
      isVisible: true,
      size: 90,
    },
    {
      universalIdentifier: '73d74c6f-b1ac-4fa6-895c-2513c72ccf0b',
      fieldMetadataUniversalIdentifier: FORMULA_DEFINITION_FIELDS.lastValue,
      position: 5,
      isVisible: true,
      size: 110,
    },
    {
      universalIdentifier: '9410f5de-385f-4902-8d4b-afa4ce4850ba',
      fieldMetadataUniversalIdentifier: FORMULA_DEFINITION_FIELDS.lastError,
      position: 6,
      isVisible: true,
      size: 200,
    },
  ],
});
