import { MetadataApiClient } from 'twenty-client-sdk/metadata';

import { FORMULA_EDITOR_UNIVERSAL_IDENTIFIER } from 'src/front-components/lib/front-component-ids';

// Ensures the target object's record page has a "Formulas" tab hosting the
// (object-agnostic) formula-editor widget. Deploy-time page-layout tabs only
// cover Opportunity; formulas created by the wizard on other objects get
// their tab added HERE at runtime via the /metadata layout mutations
// (guarded by the LAYOUTS settings flag — covered by the app role's
// canUpdateAllSettings). Idempotent: keyed on the tab title.
//
// The new tab appears after the frontend's metadata store refreshes (route
// change or reload) — same caveat as any layout edit.

const TAB_TITLE = 'Formulas';

export type EnsureFormulaTabResult =
  | 'exists'
  | 'created'
  | 'no-record-page-layout'
  | 'front-component-not-found';

export const ensureFormulaTabOnObject = async (
  objectMetadataId: string,
): Promise<EnsureFormulaTabResult> => {
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
  const editorComponent = (componentsResponse?.frontComponents ?? []).find(
    (component: { universalIdentifier?: string }) =>
      component?.universalIdentifier === FORMULA_EDITOR_UNIVERSAL_IDENTIFIER,
  );
  if (!editorComponent?.id) return 'front-component-not-found';

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
          title: 'Formula fields',
          type: 'FRONT_COMPONENT',
          gridPosition: { row: 0, column: 0, rowSpan: 4, columnSpan: 4 },
          configuration: {
            configurationType: 'FRONT_COMPONENT',
            frontComponentId: editorComponent.id,
          },
        },
      },
      id: true,
    },
  });

  return 'created';
};
