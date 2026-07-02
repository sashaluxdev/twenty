import {
  defineField,
  FieldType,
  STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS,
} from 'twenty-sdk/define';

// A second value field used to demo CROSS-OBJECT formulas (e.g. an opportunity
// score that reads a company record's `employees` field). Same chimeric
// contract as formulaScore.
export const OPPORTUNITY_CROSS_SCORE_FIELD_UNIVERSAL_IDENTIFIER =
  '93f97b55-65d2-4c18-af02-a78c781b7030';

export default defineField({
  universalIdentifier: OPPORTUNITY_CROSS_SCORE_FIELD_UNIVERSAL_IDENTIFIER,
  objectUniversalIdentifier:
    STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.opportunity.universalIdentifier,
  type: FieldType.NUMBER,
  name: 'formulaCrossScore',
  label: 'Formula cross score',
  description: 'Computed value field for a cross-object formula.',
  icon: 'IconMathXy',
  isUIEditable: false,
});
