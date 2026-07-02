import {
  defineField,
  FieldType,
  STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS,
} from 'twenty-sdk/define';

// The VALUE FIELD (see ADR 0001). This real NUMBER field is what the UI shows
// and every API read/export/copy returns. The recompute engine writes the
// formula result here. `isUIEditable: false` hides the generic UI editor so a
// human cannot overwrite the computed value from the table cell / record page —
// editing happens on the formula, via the front component.
export const OPPORTUNITY_SCORE_FIELD_UNIVERSAL_IDENTIFIER =
  '6ddbdf44-9be4-4bf4-b83a-efbcf96b3302';

export default defineField({
  universalIdentifier: OPPORTUNITY_SCORE_FIELD_UNIVERSAL_IDENTIFIER,
  objectUniversalIdentifier:
    STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.opportunity.universalIdentifier,
  type: FieldType.NUMBER,
  name: 'formulaScore',
  label: 'Formula score',
  description:
    'Computed value field. Reads return the number; edit the formula, not this.',
  icon: 'IconMathFunction',
  isUIEditable: false,
});
