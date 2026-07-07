import { MetadataApiClient } from 'twenty-client-sdk/metadata';

import { VARIATION_WIDGET_UNIVERSAL_IDENTIFIER } from 'src/front-components/lib/front-component-ids';

// Ensures the target object's record page has a "Variations" tab hosting the
// (object-agnostic) variation widget. Deploy-time page-layout tabs only
// cover Opportunity; variations enabled by the wizard on other objects get
// their tab added HERE at runtime via the /metadata layout mutations
// (guarded by the LAYOUTS settings flag — covered by the app role's
// canUpdateAllSettings). Idempotent: keyed on the tab title.
//
// The new tab appears after the frontend's metadata store refreshes (route
// change or reload) — same caveat as any layout edit.
//
// WHY a near-duplicate of ensure-formula-tab.ts rather than a shared helper:
// a parameterized helper would couple two features' UX to one shape for
// ~60 duplicated lines; this app's convention is one file per tab concern.
// This duplication is deliberate, not accidental.

const TAB_TITLE = 'Variations';

export type EnsureVariationTabResult =
  | 'exists'
  | 'created'
  | 'no-record-page-layout'
  | 'front-component-not-found';

export const ensureVariationTabOnObject = async (
  objectMetadataId: string,
): Promise<EnsureVariationTabResult> => {
  const client = new MetadataApiClient();

  const layoutsResponse = await client.query({
    getPageLayouts: {
      __args: { objectMetadataId, pageLayoutType: 'RECORD_PAGE' },
      id: true,
      tabs: { id: true, title: true },
    },
  });
  const layout = (layoutsResponse?.getPageLayouts ?? [])[0];
  if (!layout?.id) return 'no-record-page-layout';
  if (
    (layout.tabs ?? []).some(
      (tab: { title?: string }) => tab?.title === TAB_TITLE,
    )
  ) {
    return 'exists';
  }

  // Widget configuration needs the RUNTIME front component id, not the
  // universal identifier the manifest uses.
  const componentsResponse = await client.query({
    frontComponents: { id: true, universalIdentifier: true },
  });
  const widgetComponent = (componentsResponse?.frontComponents ?? []).find(
    (component: { universalIdentifier?: string }) =>
      component?.universalIdentifier === VARIATION_WIDGET_UNIVERSAL_IDENTIFIER,
  );
  if (!widgetComponent?.id) return 'front-component-not-found';

  // Mirrors the deploy-time Opportunity tab (CANVAS, position 1000, 4x4).
  const tabResponse = await client.mutation({
    createPageLayoutTab: {
      __args: {
        input: {
          title: TAB_TITLE,
          pageLayoutId: layout.id,
          position: 1000,
          layoutMode: 'CANVAS',
        },
      },
      id: true,
    },
  });
  const tabId = tabResponse?.createPageLayoutTab?.id;
  if (!tabId) return 'no-record-page-layout';

  await client.mutation({
    createPageLayoutWidget: {
      __args: {
        input: {
          pageLayoutTabId: tabId,
          title: 'Record variations',
          type: 'FRONT_COMPONENT',
          gridPosition: { row: 0, column: 0, rowSpan: 4, columnSpan: 4 },
          configuration: {
            configurationType: 'FRONT_COMPONENT',
            frontComponentId: widgetComponent.id,
          },
        },
      },
      id: true,
    },
  });

  return 'created';
};
