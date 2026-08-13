import { describe, expect, it, vi } from 'vitest';
import { MetadataApiClient } from 'twenty-client-sdk/metadata';

import { ensureFormulaTabOnObject } from 'src/front-components/lib/ensure-formula-tab';
import { FORMULA_EDITOR_UNIVERSAL_IDENTIFIER } from 'src/front-components/lib/front-component-ids';

// The tab helper runs through an INJECTED metadata client, so the tests hand in
// a plain fake — no module mocking. The fake answers the two queries the helper
// issues (frontComponents, getPageLayouts) and records every mutation with its
// FULL payload: a repair carrying the wrong `configurationType` would blank the
// widget just as silently as the stale id it replaces.

const LIVE_COMPONENT_ID = 'front-component-live';
const DEAD_COMPONENT_ID = 'front-component-dead';
// A live component that belongs to some OTHER app in the same workspace:
// `frontComponents` is workspace-wide, so this id is visible here too.
const OTHER_APP_COMPONENT_ID = 'front-component-other-app';
const OTHER_UNIVERSAL_IDENTIFIER = 'ffffffff-0000-0000-0000-000000000000';

type FakeWidget = {
  id: string;
  type: string;
  configuration?: { configurationType?: string; frontComponentId?: string };
};

type FakeTab = { id: string; title: string; widgets?: FakeWidget[] };

const makeClient = ({
  tabs = [],
  hasLiveComponent = true,
  hasLayout = true,
  failUpdates = false,
}: {
  tabs?: FakeTab[];
  hasLiveComponent?: boolean;
  hasLayout?: boolean;
  failUpdates?: boolean;
} = {}) => {
  const querySelections: any[] = [];
  const mutations: { key: string; args: any }[] = [];
  return {
    querySelections,
    mutations,
    query: async (selection: any) => {
      querySelections.push(selection);
      if (selection.frontComponents) {
        return {
          frontComponents: [
            {
              id: OTHER_APP_COMPONENT_ID,
              universalIdentifier: OTHER_UNIVERSAL_IDENTIFIER,
            },
            ...(hasLiveComponent
              ? [
                  {
                    id: LIVE_COMPONENT_ID,
                    universalIdentifier: FORMULA_EDITOR_UNIVERSAL_IDENTIFIER,
                  },
                ]
              : []),
          ],
        };
      }
      if (selection.getPageLayouts) {
        return { getPageLayouts: hasLayout ? [{ id: 'layout-1', tabs }] : [] };
      }
      throw new Error(
        `unexpected metadata query ${Object.keys(selection).join(',')}`,
      );
    },
    mutation: async (selection: any) => {
      const key = Object.keys(selection)[0];
      mutations.push({ key, args: selection[key].__args });
      if (key === 'createPageLayoutTab') {
        return { createPageLayoutTab: { id: 'tab-new' } };
      }
      if (key === 'createPageLayoutWidget') {
        return { createPageLayoutWidget: { id: 'widget-new' } };
      }
      if (key === 'updatePageLayoutWidget') {
        if (failUpdates) throw new Error('LAYOUTS permission denied');
        return { updatePageLayoutWidget: { id: selection[key].__args.id } };
      }
      throw new Error(`unexpected metadata mutation ${key}`);
    },
  };
};

const formulaTab = (widgets: FakeWidget[]): FakeTab => ({
  id: 'tab-1',
  title: 'Formulas',
  widgets,
});

const frontComponentWidget = (
  id: string,
  frontComponentId: string,
): FakeWidget => ({
  id,
  type: 'FRONT_COMPONENT',
  configuration: { configurationType: 'FRONT_COMPONENT', frontComponentId },
});

const repairPayload = (widgetId: string) => ({
  key: 'updatePageLayoutWidget',
  args: {
    id: widgetId,
    input: {
      configuration: {
        configurationType: 'FRONT_COMPONENT',
        frontComponentId: LIVE_COMPONENT_ID,
      },
    },
  },
});

describe('ensureFormulaTabOnObject', () => {
  it('should create the tab and its widget with the live front component id when no such tab exists', async () => {
    const client = makeClient({ tabs: [{ id: 'tab-0', title: 'Timeline' }] });

    const result = await ensureFormulaTabOnObject('object-1', client);

    expect(result).toBe('created');
    expect(client.mutations.map((mutation) => mutation.key)).toEqual([
      'createPageLayoutTab',
      'createPageLayoutWidget',
    ]);
    expect(client.mutations[0].args.input).toMatchObject({
      title: 'Formulas',
      pageLayoutId: 'layout-1',
      position: 1000,
      layoutMode: 'CANVAS',
    });
    expect(client.mutations[1].args.input).toMatchObject({
      pageLayoutTabId: 'tab-new',
      type: 'FRONT_COMPONENT',
      configuration: {
        configurationType: 'FRONT_COMPONENT',
        frontComponentId: LIVE_COMPONENT_ID,
      },
    });
  });

  it('should repair a widget still pointing at a dead front component id and report "repaired"', async () => {
    const client = makeClient({
      tabs: [formulaTab([frontComponentWidget('widget-1', DEAD_COMPONENT_ID)])],
    });

    const result = await ensureFormulaTabOnObject('object-1', client);

    expect(result).toBe('repaired');
    expect(client.mutations).toEqual([repairPayload('widget-1')]);
  });

  it('should repair every dangling widget when a tab hosts more than one', async () => {
    const client = makeClient({
      tabs: [
        formulaTab([
          frontComponentWidget('widget-1', DEAD_COMPONENT_ID),
          frontComponentWidget('widget-2', 'front-component-also-dead'),
        ]),
      ],
    });

    const result = await ensureFormulaTabOnObject('object-1', client);

    expect(result).toBe('repaired');
    expect(client.mutations).toEqual([
      repairPayload('widget-1'),
      repairPayload('widget-2'),
    ]);
  });

  it('should leave widgets of other types alone while repairing the front component one', async () => {
    const client = makeClient({
      tabs: [
        formulaTab([
          { id: 'widget-fields', type: 'FIELDS' },
          frontComponentWidget('widget-1', DEAD_COMPONENT_ID),
        ]),
      ],
    });

    const result = await ensureFormulaTabOnObject('object-1', client);

    expect(result).toBe('repaired');
    expect(client.mutations).toEqual([repairPayload('widget-1')]);
  });

  // The tab is matched by TITLE alone, so a same-titled tab from another app
  // must not be hijacked: only widgets pointing at no live component are ours
  // to repoint.
  it('should not touch a widget pointing at another app’s live front component', async () => {
    const client = makeClient({
      tabs: [
        formulaTab([
          frontComponentWidget('widget-other-app', OTHER_APP_COMPONENT_ID),
        ]),
      ],
    });

    const result = await ensureFormulaTabOnObject('object-1', client);

    expect(result).toBe('exists');
    expect(client.mutations).toEqual([]);
  });

  // Same failure class as the bug being fixed: an existing tab with no widget of
  // ours renders blank forever, so the widget is put back into that very tab.
  it('should recreate the missing widget in an existing tab that lost it', async () => {
    const client = makeClient({
      tabs: [formulaTab([{ id: 'widget-fields', type: 'FIELDS' }])],
    });

    const result = await ensureFormulaTabOnObject('object-1', client);

    expect(result).toBe('repaired');
    expect(client.mutations.map((mutation) => mutation.key)).toEqual([
      'createPageLayoutWidget',
    ]);
    expect(client.mutations[0].args.input).toMatchObject({
      pageLayoutTabId: 'tab-1',
      type: 'FRONT_COMPONENT',
      configuration: {
        configurationType: 'FRONT_COMPONENT',
        frontComponentId: LIVE_COMPONENT_ID,
      },
    });
  });

  it('should mutate nothing and report "exists" when the tab widget already points at the live id', async () => {
    const client = makeClient({
      tabs: [formulaTab([frontComponentWidget('widget-1', LIVE_COMPONENT_ID)])],
    });

    const result = await ensureFormulaTabOnObject('object-1', client);

    expect(result).toBe('exists');
    expect(client.mutations).toEqual([]);
  });

  it('should mutate nothing and report "front-component-not-found" when the component is missing', async () => {
    const client = makeClient({ hasLiveComponent: false });

    const result = await ensureFormulaTabOnObject('object-1', client);

    expect(result).toBe('front-component-not-found');
    expect(client.mutations).toEqual([]);
  });

  it('should mutate nothing and report "no-record-page-layout" when the object has no record page', async () => {
    const client = makeClient({ hasLayout: false });

    const result = await ensureFormulaTabOnObject('object-1', client);

    expect(result).toBe('no-record-page-layout');
    expect(client.mutations).toEqual([]);
  });

  // Callers swallow layout failures, so a failed repair must at least be visible
  // in the console and must never be reported as a repair.
  it('should warn and surface the error when the repair mutation fails', async () => {
    const client = makeClient({
      tabs: [formulaTab([frontComponentWidget('widget-1', DEAD_COMPONENT_ID)])],
      failUpdates: true,
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(ensureFormulaTabOnObject('object-1', client)).rejects.toThrow(
      'LAYOUTS permission denied',
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('widget-1');

    warn.mockRestore();
  });

  // The union sub-selection is the part unit tests cannot otherwise protect: a
  // bare `configuration: true` is accepted by the builder but rejected by the
  // server ("must have a selection of subfields"), which would make every
  // existing tab look correct and never get repaired.
  it('should read the widget configuration through the FrontComponentConfiguration union member', async () => {
    const client = makeClient({
      tabs: [formulaTab([frontComponentWidget('widget-1', LIVE_COMPONENT_ID)])],
    });

    await ensureFormulaTabOnObject('object-1', client);

    const layoutsSelection = client.querySelections.find(
      (selection) => selection.getPageLayouts,
    );
    const configurationSelection =
      layoutsSelection.getPageLayouts.tabs.widgets.configuration;
    expect(configurationSelection).not.toBe(true);
    expect(
      configurationSelection.on_FrontComponentConfiguration.frontComponentId,
    ).toBe(true);
  });

  // …and the selection above only proves the OBJECT matches the implementation.
  // This drives the REAL genql client with a fake fetch and inspects the GraphQL
  // document it would have POSTed, so a wrong-but-self-consistent convention
  // cannot pass. Offline: no server, no network.
  it('should emit a union member fragment on the wire for the widget configuration', async () => {
    const documents: string[] = [];
    const fakeFetch = async (_url: string, init: { body: string }) => {
      documents.push(JSON.parse(init.body).query);
      return {
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify({ data: { getPageLayouts: [] } }),
      };
    };
    const client = new MetadataApiClient({
      url: 'http://localhost:1/metadata',
      fetch: fakeFetch,
    } as any);

    const result = await ensureFormulaTabOnObject('object-1', client);

    expect(result).toBe('no-record-page-layout');
    const layoutsDocument = documents.find((document) =>
      document.includes('getPageLayouts'),
    );
    expect(layoutsDocument).toContain('configuration{...f');
    expect(layoutsDocument).toMatch(
      /fragment f\d+ on FrontComponentConfiguration\{configurationType,frontComponentId\}/,
    );
  });
});
