import { MetadataApiClient, MetadataSchema } from 'twenty-client-sdk/metadata';

import { FORMULA_EDITOR_UNIVERSAL_IDENTIFIER } from 'src/front-components/lib/front-component-ids';

// Ensures the target object's record page has a "Formulas" tab hosting the
// (object-agnostic) formula-editor widget. There are no deploy-time page-layout
// tabs any more (the declarative Opportunity tab went away in 12e2b01213), so
// EVERY such tab is created HERE at runtime via the /metadata layout mutations
// (guarded by the LAYOUTS settings flag — covered by the app role's
// canUpdateAllSettings). Idempotent: keyed on the tab title.
//
// WHY an existing tab is still revalidated instead of trusted: the tab and its
// widget belong to the workspace's "Custom" application, so uninstalling the app
// leaves them in place while hard-deleting its frontComponent rows — and a
// reinstall mints brand-new front component ids. The widget's snapshotted
// frontComponentId then dangles, and the platform renders a blank tab with no
// error at all. So the live id is resolved first and any widget pointing
// elsewhere is repaired in place.
//
// The new tab appears after the frontend's metadata store refreshes (route
// change or reload) — same caveat as any layout edit.

const TAB_TITLE = 'Formulas';

export type EnsureFormulaTabResult =
  | 'exists'
  | 'created'
  | 'repaired'
  | 'no-record-page-layout'
  | 'front-component-not-found';

// Minimal metadata client surface (loose shapes mirror the genql client's
// runtime-built selections). Injectable so unit tests hand in a plain fake.
type LayoutClient = {
  query: (selection: any) => Promise<any>;
  mutation: (selection: any) => Promise<any>;
};

type ExistingWidget = {
  id?: string;
  type?: string;
  configuration?: { frontComponentId?: string };
};

export const ensureFormulaTabOnObject = async (
  objectMetadataId: string,
  client: LayoutClient = new MetadataApiClient(),
): Promise<EnsureFormulaTabResult> => {
  const layoutsResponse = await client.query({
    getPageLayouts: {
      __args: { objectMetadataId, pageLayoutType: 'RECORD_PAGE' },
      id: true,
      tabs: {
        id: true,
        title: true,
        widgets: {
          id: true,
          type: true,
          // `configuration` is the WidgetConfiguration UNION, and a union field
          // must carry a member sub-selection — this genql builder spells that
          // `on_<TypeName>` (compiled to a `... on FrontComponentConfiguration`
          // fragment). A bare `configuration: true` would be rejected by the
          // server; the `satisfies` below turns that into a compile error.
          configuration: {
            on_FrontComponentConfiguration: {
              configurationType: true,
              frontComponentId: true,
            },
          },
        },
      },
    },
  } satisfies MetadataSchema.QueryGenqlSelection);
  const layout = (layoutsResponse?.getPageLayouts ?? [])[0];
  if (!layout?.id) return 'no-record-page-layout';

  // Widget configuration needs the RUNTIME front component id, not the
  // universal identifier the manifest uses. Resolved before the already-exists
  // check because both branches need it: one to write it, one to verify it.
  const componentsResponse = await client.query({
    frontComponents: { id: true, universalIdentifier: true },
  });
  const editorComponent = (componentsResponse?.frontComponents ?? []).find(
    (component: { universalIdentifier?: string }) =>
      component?.universalIdentifier === FORMULA_EDITOR_UNIVERSAL_IDENTIFIER,
  );
  if (!editorComponent?.id) return 'front-component-not-found';

  const existingTab = (layout.tabs ?? []).find(
    (tab: { title?: string }) => tab?.title === TAB_TITLE,
  );
  if (existingTab) {
    const staleWidgets = (existingTab.widgets ?? []).filter(
      (widget: ExistingWidget) =>
        widget?.type === 'FRONT_COMPONENT' &&
        typeof widget?.id === 'string' &&
        widget?.configuration?.frontComponentId !== editorComponent.id,
    );
    if (staleWidgets.length === 0) return 'exists';

    for (const widget of staleWidgets) {
      await client.mutation({
        updatePageLayoutWidget: {
          __args: {
            id: widget.id,
            input: {
              configuration: {
                configurationType: 'FRONT_COMPONENT',
                frontComponentId: editorComponent.id,
              },
            },
          },
          id: true,
        },
      });
    }
    return 'repaired';
  }

  // Mirrors the retired deploy-time Opportunity tab (CANVAS, position 1000, 4x4).
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
