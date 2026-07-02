import { definePageLayout, PageLayoutTabLayoutMode } from 'twenty-sdk/define';
import { FORMULA_DEFINITION_EDITOR_UNIVERSAL_IDENTIFIER } from 'src/front-components/formula-definition-editor';
import { FORMULA_DEFINITION_OBJECT_UNIVERSAL_IDENTIFIER } from 'src/objects/formula-definition.object';

// Record page for the app's own FormulaDefinition object. Custom objects use the
// page-layout renderer, so the editor front component surfaces here (unlike
// standard-object record pages in this build — see ADR 0007). This is
// the working in-UI formula editor; the FormulaDefinition index view is the
// list/admin fallback.
export default definePageLayout({
  universalIdentifier: '49e79d47-9174-48d4-9f91-94f83e4154e2',
  name: 'Formula definition record page',
  type: 'RECORD_PAGE',
  objectUniversalIdentifier: FORMULA_DEFINITION_OBJECT_UNIVERSAL_IDENTIFIER,
  tabs: [
    {
      universalIdentifier: '34098363-39d4-4cdc-98c5-6ae75260cc03',
      title: 'Editor',
      position: 10,
      icon: 'IconMathFunction',
      layoutMode: PageLayoutTabLayoutMode.CANVAS,
      widgets: [
        {
          universalIdentifier: 'ac4d683d-1111-4728-9ab0-7d52938dd111',
          title: 'Formula editor',
          type: 'FRONT_COMPONENT',
          configuration: {
            configurationType: 'FRONT_COMPONENT',
            frontComponentUniversalIdentifier:
              FORMULA_DEFINITION_EDITOR_UNIVERSAL_IDENTIFIER,
          },
        },
      ],
    },
  ],
});
