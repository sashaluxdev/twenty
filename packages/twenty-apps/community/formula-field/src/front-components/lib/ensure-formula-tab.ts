import { MetadataApiClient, MetadataSchema } from 'twenty-client-sdk/metadata';

import { FORMULA_EDITOR_UNIVERSAL_IDENTIFIER } from 'src/front-components/lib/front-component-ids';

// Ensures the target object's record page has a "Formulas" tab hosting the
// (object-agnostic) formula-editor widget. Nothing deploy-time covers a USER
// object's record page: the declarative Opportunity tab went away in 12e2b01213,
// and the app's two remaining page layouts (src/page-layouts/*.ts) only cover the
// app's own objects. So every such tab is created HERE at runtime via the
// /metadata layout mutations (guarded by the LAYOUTS settings flag — covered by
// the app role's canUpdateAllSettings). Idempotent: keyed on the tab title.
//
// WHY an existing tab is revalidated instead of trusted: runtime tabs are the
// only ones that can rot. A declarative widget references its component by
// `frontComponentUniversalIdentifier`, which the platform re-resolves on every
// install; a runtime widget must hard-snapshot the RUNTIME `frontComponentId`.
// These tabs are created under the workspace's "Custom" application, so
// uninstalling the app leaves them in place while hard-deleting the app's
// frontComponent rows — and a reinstall mints brand-new ids. The snapshotted id
// then dangles and the platform renders a blank tab with no error at all. Hence:
// resolve the live component ids first, put back a widget the tab has lost, and
// repoint any widget that points at no live component.
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

// Mirrors the retired deploy-time Opportunity widget (CANVAS tab, 4x4 at 0,0).
// Shared by the fresh-tab path and the lost-widget repair path.
const createEditorWidget = async (
  client: LayoutClient,
  pageLayoutTabId: string,
  frontComponentId: string,
): Promise<void> => {
  await client.mutation({
    createPageLayoutWidget: {
      __args: {
        input: {
          pageLayoutTabId,
          title: 'Formula fields',
          type: 'FRONT_COMPONENT',
          gridPosition: { row: 0, column: 0, rowSpan: 4, columnSpan: 4 },
          configuration: {
            configurationType: 'FRONT_COMPONENT',
            frontComponentId,
          },
        },
      },
      id: true,
    },
  });
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
          // server; the `satisfies` below turns that into a compile error, and
          // the spec asserts the emitted document.
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
  // `frontComponents` is workspace-wide with no application filter, so this is
  // also the complete set of LIVE ids — enough to tell a dangling widget from
  // another app's perfectly good one below.
  const componentsResponse = await client.query({
    frontComponents: { id: true, universalIdentifier: true },
  } satisfies MetadataSchema.QueryGenqlSelection);
  const components = componentsResponse?.frontComponents ?? [];
  const editorComponent = components.find(
    (component: { universalIdentifier?: string }) =>
      component?.universalIdentifier === FORMULA_EDITOR_UNIVERSAL_IDENTIFIER,
  );
  if (!editorComponent?.id) return 'front-component-not-found';
  const liveComponentIds = new Set(
    components.map((component: { id?: string }) => component?.id),
  );

  const existingTab = (layout.tabs ?? []).find(
    (tab: { title?: string }) => tab?.title === TAB_TITLE,
  );
  if (existingTab?.id) {
    const frontComponentWidgets = (existingTab.widgets ?? []).filter(
      (widget: ExistingWidget) =>
        widget?.type === 'FRONT_COMPONENT' && typeof widget?.id === 'string',
    );

    // A tab that hosts no front-component widget at all is just as blank as one
    // pointing at a dead id: a half-created tab (the widget mutation failed
    // after the tab landed), or a platform that starts cascading the widget
    // delete on uninstall — `frontComponentId` is a non-FK serialized relation,
    // so surviving the delete is current behaviour, not a contract.
    if (frontComponentWidgets.length === 0) {
      await createEditorWidget(client, existingTab.id, editorComponent.id);
      return 'repaired';
    }

    // Only DANGLING widgets get repointed. A widget on another app's LIVE
    // component is not ours to touch: the tab is matched by title alone, so a
    // title collision must stay harmless.
    const staleWidgets = frontComponentWidgets.filter(
      (widget: ExistingWidget) =>
        !liveComponentIds.has(widget?.configuration?.frontComponentId),
    );
    if (staleWidgets.length === 0) return 'exists';

    let repairedCount = 0;
    let firstError: unknown;
    for (const widget of staleWidgets) {
      try {
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
        repairedCount += 1;
      } catch (error) {
        firstError ??= error;
        // Callers treat tab upkeep as best-effort and swallow throws, so an
        // unlogged failure here looks exactly like the blank tab this repair
        // exists to fix.
        console.warn(
          `[formula-field] could not repair the "${TAB_TITLE}" tab widget ${widget.id}; it will keep rendering blank until the next attempt`,
          error,
        );
      }
    }
    // Never claim a repair that did not happen — let the caller's best-effort
    // handler see the failure.
    if (repairedCount === 0) throw firstError;
    return 'repaired';
  }

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

  await createEditorWidget(client, tabId, editorComponent.id);

  return 'created';
};
