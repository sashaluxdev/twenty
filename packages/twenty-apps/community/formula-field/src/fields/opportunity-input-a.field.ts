import {
  defineField,
  FieldType,
  STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS,
} from 'twenty-sdk/define';

// Demo input field #1 on the standard Opportunity object. A plain, editable
// NUMBER the demo formula reads.
export default defineField({
  universalIdentifier: '19ab8ae2-14a5-47ee-96ca-99b72534de4d',
  objectUniversalIdentifier:
    STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.opportunity.universalIdentifier,
  type: FieldType.NUMBER,
  name: 'formulaInputA',
  label: 'Formula input A',
  description: 'Demo numeric input consumed by a formula.',
  icon: 'IconNumber1',
});
