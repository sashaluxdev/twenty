import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ensureFieldLayoutVisibility } from 'src/logic-functions/lib/fx-status-field';

// Layout convergence drives the record-page "Fields" view: it creates or heals
// the target field's viewField row so the chip lands in the right group, at the
// right position, with the right visibility. The source instantiates
// `new MetadataApiClient()` directly, so we mock the module and hand back a
// fixture-driven fake that dispatches on the genql-style top-level selection key.

type ViewFieldRow = {
  id: string;
  fieldMetadataId: string;
  isVisible: boolean;
  position: number;
  viewFieldGroupId: string | null;
};

type ViewFieldGroupRow = { id: string; position: number; isVisible: boolean };

type FakeConfig = {
  viewId: string;
  widgetType?: string;
  viewFields: ViewFieldRow[];
  viewFieldGroups?: ViewFieldGroupRow[];
};

type CreatedViewField = Record<string, unknown>;
type UpdatedViewField = { id: string; update: Record<string, unknown> };

class FakeMetadataClient {
  public createdFields: CreatedViewField[] = [];
  public updatedFields: UpdatedViewField[] = [];
  // View ids for which getViewFieldGroups was consulted (fallback path only).
  public viewFieldGroupQueryViewIds: string[] = [];

  constructor(private readonly config: FakeConfig) {}

  async query(
    selection: Record<string, { __args?: Record<string, unknown> }>,
  ): Promise<unknown> {
    const key = Object.keys(selection)[0];
    const args = selection[key].__args ?? {};

    if (key === 'getPageLayouts') {
      return {
        getPageLayouts: [
          {
            id: 'layout-1',
            tabs: [
              {
                id: 'tab-1',
                widgets: [
                  {
                    id: 'widget-1',
                    type: this.config.widgetType ?? 'FIELDS',
                    configuration: { viewId: this.config.viewId },
                  },
                ],
              },
            ],
          },
        ],
      };
    }
    if (key === 'getViewFields') {
      return { getViewFields: this.config.viewFields };
    }
    if (key === 'getViewFieldGroups') {
      this.viewFieldGroupQueryViewIds.push(args.viewId as string);
      return { getViewFieldGroups: this.config.viewFieldGroups ?? [] };
    }
    throw new Error(`FakeMetadataClient: unhandled query ${key}`);
  }

  async mutation(
    selection: Record<string, { __args: { input: Record<string, unknown> } }>,
  ): Promise<unknown> {
    const key = Object.keys(selection)[0];
    const input = selection[key].__args.input;

    if (key === 'createViewField') {
      this.createdFields.push(input);
      return { createViewField: { id: 'created-view-field' } };
    }
    if (key === 'updateViewField') {
      this.updatedFields.push(input as UpdatedViewField);
      return { updateViewField: { id: input.id as string } };
    }
    throw new Error(`FakeMetadataClient: unhandled mutation ${key}`);
  }
}

const mocks = vi.hoisted(() => ({ client: null as FakeMetadataClient | null }));

vi.mock('twenty-client-sdk/metadata', () => ({
  // A non-arrow function so the source's `new MetadataApiClient()` can
  // construct it; returning an object makes `new` yield our shared fake.
  MetadataApiClient: vi.fn(function () {
    return mocks.client;
  }),
}));

const objectMetadataId = 'object-1';

const useFake = (config: FakeConfig): FakeMetadataClient => {
  const fake = new FakeMetadataClient(config);
  mocks.client = fake;
  return fake;
};

describe('ensureFieldLayoutVisibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should create a missing viewField under the anchor group at anchor+0.5 when an anchor is given', async () => {
    const fake = useFake({
      viewId: 'view-1',
      viewFields: [
        {
          id: 'vf-anchor',
          fieldMetadataId: 'anchor-field',
          isVisible: true,
          position: 3,
          viewFieldGroupId: 'group-anchor',
        },
      ],
    });

    await ensureFieldLayoutVisibility({
      objectMetadataId,
      fieldMetadataId: 'target-field',
      visible: true,
      anchorFieldMetadataId: 'anchor-field',
    });

    expect(fake.createdFields).toEqual([
      {
        viewId: 'view-1',
        fieldMetadataId: 'target-field',
        isVisible: true,
        position: 3.5,
        viewFieldGroupId: 'group-anchor',
      },
    ]);
    expect(fake.updatedFields).toHaveLength(0);
  });

  it('should heal a null group to the anchor group (position not forced) when the target is hidden but already correctly placed', async () => {
    // visible:false + isVisible already false + position already anchor+0.5:
    // the only divergence is the null group, so the update fires solely on the
    // groupWrong branch — `visible && positionWrong` cannot trigger it here.
    const fake = useFake({
      viewId: 'view-1',
      viewFields: [
        {
          id: 'vf-anchor',
          fieldMetadataId: 'anchor-field',
          isVisible: true,
          position: 2,
          viewFieldGroupId: 'group-anchor',
        },
        {
          id: 'vf-own',
          fieldMetadataId: 'target-field',
          isVisible: false,
          position: 2.5,
          viewFieldGroupId: null,
        },
      ],
    });

    await ensureFieldLayoutVisibility({
      objectMetadataId,
      fieldMetadataId: 'target-field',
      visible: false,
      anchorFieldMetadataId: 'anchor-field',
    });

    expect(fake.createdFields).toHaveLength(0);
    expect(fake.updatedFields).toEqual([
      {
        id: 'vf-own',
        update: {
          isVisible: false,
          position: 2.5,
          viewFieldGroupId: 'group-anchor',
        },
      },
    ]);
  });

  it('should not mutate anything when the row is already fully converged (visibility, position and group all match)', async () => {
    const fake = useFake({
      viewId: 'view-1',
      viewFields: [
        {
          id: 'vf-anchor',
          fieldMetadataId: 'anchor-field',
          isVisible: true,
          position: 2,
          viewFieldGroupId: 'group-anchor',
        },
        {
          id: 'vf-own',
          fieldMetadataId: 'target-field',
          isVisible: true,
          position: 2.5,
          viewFieldGroupId: 'group-anchor',
        },
      ],
    });

    await ensureFieldLayoutVisibility({
      objectMetadataId,
      fieldMetadataId: 'target-field',
      visible: true,
      anchorFieldMetadataId: 'anchor-field',
    });

    expect(fake.createdFields).toHaveLength(0);
    expect(fake.updatedFields).toHaveLength(0);
  });

  it('should fall back to the highest-position visible group when there is no anchor and the row has no group', async () => {
    const fake = useFake({
      viewId: 'view-1',
      viewFields: [
        {
          id: 'vf-own',
          fieldMetadataId: 'target-field',
          isVisible: true,
          position: 5,
          viewFieldGroupId: null,
        },
      ],
      viewFieldGroups: [
        { id: 'group-first', position: 0, isVisible: true },
        // Highest position overall but hidden — must be skipped.
        { id: 'group-hidden', position: 10, isVisible: false },
        { id: 'group-last-visible', position: 5, isVisible: true },
      ],
    });

    await ensureFieldLayoutVisibility({
      objectMetadataId,
      fieldMetadataId: 'target-field',
      visible: true,
    });

    expect(fake.viewFieldGroupQueryViewIds).toEqual(['view-1']);
    expect(fake.createdFields).toHaveLength(0);
    expect(fake.updatedFields).toHaveLength(1);
    expect(fake.updatedFields[0]).toEqual({
      id: 'vf-own',
      update: { isVisible: true, viewFieldGroupId: 'group-last-visible' },
    });
    // No anchor -> no desired position -> position must not be written.
    expect(fake.updatedFields[0].update).not.toHaveProperty('position');
  });

  it('should keep the row own group and skip the group lookup when the row has a group and no anchor is given', async () => {
    const fake = useFake({
      viewId: 'view-1',
      viewFields: [
        {
          id: 'vf-own',
          fieldMetadataId: 'target-field',
          isVisible: true,
          position: 4,
          viewFieldGroupId: 'group-own',
        },
      ],
    });

    await ensureFieldLayoutVisibility({
      objectMetadataId,
      fieldMetadataId: 'target-field',
      visible: true,
    });

    expect(fake.viewFieldGroupQueryViewIds).toHaveLength(0);
    expect(fake.createdFields).toHaveLength(0);
    expect(fake.updatedFields).toHaveLength(0);
  });
});
