import {
  definePageLayout,
  PageLayoutTabLayoutMode,
  STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS,
} from 'twenty-sdk/define';
import { FORMULA_EDITOR_UNIVERSAL_IDENTIFIER } from 'src/front-components/formula-editor';

// Adds a "Formulas" tab to the Opportunity record page hosting the formula
// editor front component. This is the primary "edit the formula, not the value"
// surface; the FormulaDefinition index view is the fallback editor.
export default definePageLayout({
  universalIdentifier: '990e6360-bf43-462b-8ffd-53f163e21f86',
  name: 'Opportunity formulas',
  type: 'RECORD_PAGE',
  objectUniversalIdentifier:
    STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.opportunity.universalIdentifier,
  tabs: [
    {
      universalIdentifier: '6d77ed4a-01bf-487d-907f-f613386ddd31',
      title: 'Formulas',
      position: 60,
      icon: 'IconMathFunction',
      layoutMode: PageLayoutTabLayoutMode.CANVAS,
      widgets: [
        {
          universalIdentifier: '13246fd7-bd55-4d4e-b09e-2fe453bc3a84',
          title: 'Formula fields',
          type: 'FRONT_COMPONENT',
          configuration: {
            configurationType: 'FRONT_COMPONENT',
            frontComponentUniversalIdentifier:
              FORMULA_EDITOR_UNIVERSAL_IDENTIFIER,
          },
        },
      ],
    },
  ],
});
