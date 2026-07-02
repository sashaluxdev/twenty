import {
  defineField,
  FieldType,
  STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS,
} from 'twenty-sdk/define';

// The VALUE FIELD (see ADR 0001). This real NUMBER field is what the UI shows
// and every API read/export/copy returns. The recompute engine writes the
// formula result here.
//
// It is intentionally EDITABLE (feature #2): a human editing this value directly
// is detected as a manual override — the formula then leaves that record alone
// until the override is reset. (isUIEditable is column-level, so we can't lock
// per-record; editability is the price of direct-edit overrides.)
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
    'Computed by a formula. Edit directly to set a manual override for a record.',
  icon: 'IconMathFunction',
  isUIEditable: true,
});
