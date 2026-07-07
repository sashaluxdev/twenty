import { defineNavigationMenuItem } from 'twenty-sdk/define';
import { NavigationMenuItemType } from 'twenty-shared/types';
import { VARIATION_CONFIG_VIEW_UNIVERSAL_IDENTIFIER } from 'src/views/variation-config.view';

// Puts the VariationConfig index view in the left sidebar (every view needs a
// navigation menu item, per the SDK pitfalls list).
export default defineNavigationMenuItem({
  universalIdentifier: 'be297c91-f59f-4a7b-9c36-95054f9a5d82',
  name: 'variation-configs',
  icon: 'IconGitFork',
  color: 'purple',
  position: 1,
  type: NavigationMenuItemType.VIEW,
  viewUniversalIdentifier: VARIATION_CONFIG_VIEW_UNIVERSAL_IDENTIFIER,
});
