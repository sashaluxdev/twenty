import { defineNavigationMenuItem } from 'twenty-sdk/define';
import { NavigationMenuItemType } from 'twenty-shared/types';
import { FORMULA_DEFINITION_VIEW_UNIVERSAL_IDENTIFIER } from 'src/views/formula-definition.view';

// Puts the FormulaDefinition index view in the left sidebar (every view needs a
// navigation menu item, per the SDK pitfalls list).
export default defineNavigationMenuItem({
  universalIdentifier: '9a4ba2e3-3192-4882-a6cb-c67367b64edb',
  name: 'formula-definitions',
  icon: 'IconMathFunction',
  color: 'purple',
  position: 0,
  type: NavigationMenuItemType.VIEW,
  viewUniversalIdentifier: FORMULA_DEFINITION_VIEW_UNIVERSAL_IDENTIFIER,
});
