import { VARIATION_WIDGET_UNIVERSAL_IDENTIFIER } from 'src/front-components/lib/front-component-ids';
import { defineFrontComponent } from 'twenty-sdk/define';

import { MutedText, WidgetRoot } from 'src/front-components/lib/ui';

// Stub: Plan 3 replaces this component's internals; the universal identifier
// and registration are permanent.
const VariationWidget = () => (
  <WidgetRoot>
    <MutedText>
      Variations are enabled for this object. The management widget arrives
      with the next app update.
    </MutedText>
  </WidgetRoot>
);

export { VARIATION_WIDGET_UNIVERSAL_IDENTIFIER } from 'src/front-components/lib/front-component-ids';

export default defineFrontComponent({
  universalIdentifier: VARIATION_WIDGET_UNIVERSAL_IDENTIFIER,
  name: 'variation-widget',
  description: 'Create and manage variations of this record.',
  component: VariationWidget,
});
