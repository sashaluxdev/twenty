import {
  definePageLayoutTab,
  PageLayoutTabLayoutMode,
  STANDARD_PAGE_LAYOUT,
} from 'twenty-sdk/define';
import { FORMULA_EDITOR_UNIVERSAL_IDENTIFIER } from 'src/front-components/formula-editor';

// Appends a "Formulas" tab to the Opportunity's EXISTING standard record page
// (rather than defining a competing full layout, which the platform does not
// adopt for a standard object). This is the primary "edit the formula, not the
// value" surface; the FormulaDefinition index view is the documented fallback.
export default definePageLayoutTab({
  universalIdentifier: '6d77ed4a-01bf-487d-907f-f613386ddd31',
  pageLayoutUniversalIdentifier:
    STANDARD_PAGE_LAYOUT.opportunityRecordPage.universalIdentifier,
  title: 'Formulas',
  position: 1000,
  icon: 'IconMathFunction',
  layoutMode: PageLayoutTabLayoutMode.CANVAS,
  widgets: [
    {
      universalIdentifier: '13246fd7-bd55-4d4e-b09e-2fe453bc3a84',
      title: 'Formula fields',
      type: 'FRONT_COMPONENT',
      configuration: {
        configurationType: 'FRONT_COMPONENT',
        frontComponentUniversalIdentifier: FORMULA_EDITOR_UNIVERSAL_IDENTIFIER,
      },
    },
  ],
});
