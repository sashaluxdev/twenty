import { definePageLayout, PageLayoutTabLayoutMode } from 'twenty-sdk/define';
import { VARIATION_CONFIG_EDITOR_UNIVERSAL_IDENTIFIER } from 'src/front-components/variation-config-editor';
import { VARIATION_CONFIG_OBJECT_UNIVERSAL_IDENTIFIER } from 'src/objects/variation-config.object';

// Record page for the app's own VariationConfig object. Custom objects use the
// page-layout renderer, so the setup/config front component surfaces here
// (unlike standard-object record pages in this build — see ADR 0007). A fresh
// config (no target object / relation field yet) shows the guided opt-in
// wizard; a wired config shows the enable/disable + status panel. The
// VariationConfig index view is the list/admin fallback.
export default definePageLayout({
  universalIdentifier: '5e79852a-de12-4343-a5a9-cd389f09aa71',
  name: 'Variation config record page',
  type: 'RECORD_PAGE',
  objectUniversalIdentifier: VARIATION_CONFIG_OBJECT_UNIVERSAL_IDENTIFIER,
  tabs: [
    {
      universalIdentifier: 'e9f31df6-a854-4170-a424-268d016b3ca6',
      title: 'Setup',
      position: 10,
      icon: 'IconGitFork',
      layoutMode: PageLayoutTabLayoutMode.CANVAS,
      widgets: [
        {
          universalIdentifier: '7ee4b6be-40c5-4d9c-b345-35af2ba36945',
          title: 'Variation config',
          type: 'FRONT_COMPONENT',
          configuration: {
            configurationType: 'FRONT_COMPONENT',
            frontComponentUniversalIdentifier:
              VARIATION_CONFIG_EDITOR_UNIVERSAL_IDENTIFIER,
          },
        },
      ],
    },
  ],
});
