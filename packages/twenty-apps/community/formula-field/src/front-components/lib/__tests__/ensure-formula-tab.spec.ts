import { describe, expect, it } from 'vitest';

import { ensureFormulaTabOnObject } from 'src/front-components/lib/ensure-formula-tab';
import { FORMULA_EDITOR_UNIVERSAL_IDENTIFIER } from 'src/front-components/lib/front-component-ids';

// The tab helper runs through an INJECTED metadata client, so the tests hand in
// a plain fake — no module mocking. The fake answers the two queries the helper
// issues (frontComponents, getPageLayouts) and records every mutation with its
// FULL payload: a repair carrying the wrong `configurationType` would blank the
// widget just as silently as the stale id it replaces.

const LIVE_COMPONENT_ID = 'front-component-live';
const STALE_COMPONENT_ID = 'front-component-stale';
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
}: {
  tabs?: FakeTab[];
  hasLiveComponent?: boolean;
  hasLayout?: boolean;
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
            { id: 'other-component', universalIdentifier: OTHER_UNIVERSAL_IDENTIFIER },
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
      tabs: [
        formulaTab([
          {
            id: 'widget-1',
            type: 'FRONT_COMPONENT',
            configuration: {
              configurationType: 'FRONT_COMPONENT',
              frontComponentId: STALE_COMPONENT_ID,
            },
          },
        ]),
      ],
    });

    const result = await ensureFormulaTabOnObject('object-1', client);

    expect(result).toBe('repaired');
    expect(client.mutations).toEqual([
      {
        key: 'updatePageLayoutWidget',
        args: {
          id: 'widget-1',
          input: {
            configuration: {
              configurationType: 'FRONT_COMPONENT',
              frontComponentId: LIVE_COMPONENT_ID,
            },
          },
        },
      },
    ]);
  });

  it('should leave widgets of other types alone while repairing the front component one', async () => {
    const client = makeClient({
      tabs: [
        formulaTab([
          { id: 'widget-fields', type: 'FIELDS' },
          {
            id: 'widget-1',
            type: 'FRONT_COMPONENT',
            configuration: {
              configurationType: 'FRONT_COMPONENT',
              frontComponentId: STALE_COMPONENT_ID,
            },
          },
        ]),
      ],
    });

    const result = await ensureFormulaTabOnObject('object-1', client);

    expect(result).toBe('repaired');
    expect(client.mutations).toHaveLength(1);
    expect(client.mutations[0].args.id).toBe('widget-1');
  });

  it('should mutate nothing and report "exists" when the tab widget already points at the live id', async () => {
    const client = makeClient({
      tabs: [
        formulaTab([
          {
            id: 'widget-1',
            type: 'FRONT_COMPONENT',
            configuration: {
              configurationType: 'FRONT_COMPONENT',
              frontComponentId: LIVE_COMPONENT_ID,
            },
          },
        ]),
      ],
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

  // The union sub-selection is the part unit tests cannot otherwise protect: a
  // bare `configuration: true` is accepted by the builder but rejected by the
  // server ("must have a selection of subfields"), which would make every
  // existing tab look correct and never get repaired.
  it('should read the widget configuration through the FrontComponentConfiguration union member', async () => {
    const client = makeClient({
      tabs: [
        formulaTab([
          {
            id: 'widget-1',
            type: 'FRONT_COMPONENT',
            configuration: {
              configurationType: 'FRONT_COMPONENT',
              frontComponentId: LIVE_COMPONENT_ID,
            },
          },
        ]),
      ],
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
});
