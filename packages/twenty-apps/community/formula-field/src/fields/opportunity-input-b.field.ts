import {
  defineField,
  FieldType,
  STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS,
} from 'twenty-sdk/define';

// Demo input field #2 on the standard Opportunity object.
export default defineField({
  universalIdentifier: '47823b9c-3cea-4f30-834a-acf86819b50f',
  objectUniversalIdentifier:
    STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.opportunity.universalIdentifier,
  type: FieldType.NUMBER,
  name: 'formulaInputB',
  label: 'Formula input B',
  description: 'Demo numeric input consumed by a formula.',
  icon: 'IconNumber2',
});
