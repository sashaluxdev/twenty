import { MetadataApiClient } from 'twenty-client-sdk/metadata';

import { pluralize } from 'src/logic-functions/lib/recompute';
import {
  type FormulaClient,
  type FormulaDefinitionRecord,
} from 'src/logic-functions/lib/types';
import { withRetry } from 'src/logic-functions/lib/with-retry';

// Per-record "FX Status" companion field (SELECT, created by the wizard next
// to each value field). The field stays ACTIVE at all times and its values
// stay accurate; what toggles is its LAYOUT visibility: the record-page
// "Fields" area is a view (viewField rows), so showing/hiding the chip is a
// viewField.isVisible flip, positioned right under its parent value field
// (float positions allow between-placement). This replaces the earlier
// isActive activate/deactivate design, which lost view membership on every
// reactivation (deactivating a field drops its viewField rows and
// reactivation does not restore them) — the chips were written but invisible.

export const companionFieldName = (targetField: string): string =>
  `${targetField}FxStatus`;

export type FieldInfo = { id: string; isActive: boolean };

export type ObjectFieldIndex = {
  objectMetadataId: string;
  fields: Map<string, FieldInfo>;
};

// One metadata query for every object's fields (the metadata ObjectFilter
// cannot filter by name). Key: objectNameSingular.
export const loadObjectFieldIndex = async (): Promise<
  Map<string, ObjectFieldIndex>
> => {
  const index = new Map<string, ObjectFieldIndex>();
  try {
    const client = new MetadataApiClient();
    const response = await client.query({
      objects: {
        __args: { filter: {}, paging: { first: 1000 } },
        edges: {
          node: {
            id: true,
            nameSingular: true,
            fields: {
              __args: { paging: { first: 1000 }, filter: {} },
              edges: { node: { id: true, name: true, isActive: true } },
            },
          },
        },
      },
    });
    for (const objectEdge of response?.objects?.edges ?? []) {
      const node = objectEdge?.node;
      if (!node?.nameSingular || !node?.id) continue;
      const fields = new Map<string, FieldInfo>();
      for (const fieldEdge of node.fields?.edges ?? []) {
        const field = fieldEdge?.node;
        if (field?.id && field?.name) {
          fields.set(field.name, {
            id: field.id,
            isActive: field.isActive !== false,
          });
        }
      }
      index.set(node.nameSingular, { objectMetadataId: node.id, fields });
    }
  } catch {
    // Metadata unavailable -> empty index (companions simply not synced).
  }
  return index;
};

const setFieldActive = async (fieldId: string, isActive: boolean) => {
  const client = new MetadataApiClient();
  await client.mutation({
    updateOneField: {
      __args: { input: { id: fieldId, update: { isActive } } },
      id: true,
    },
  });
};

// The record page's "Fields" area(s) are FIELDS widgets whose configuration
// points at a view; those views' viewField rows drive field visibility/order.
const findFieldsViewIds = async (
  metadata: MetadataApiClient,
  objectMetadataId: string,
): Promise<string[]> => {
  const response = await metadata.query({
    getPageLayouts: {
      __args: { objectMetadataId, pageLayoutType: 'RECORD_PAGE' },
      id: true,
      tabs: {
        id: true,
        widgets: {
          id: true,
          type: true,
          configuration: { on_FieldsConfiguration: { viewId: true } },
        },
      },
    },
  });
  const viewIds = new Set<string>();
  for (const layout of response?.getPageLayouts ?? []) {
    for (const tab of layout?.tabs ?? []) {
      for (const widget of tab?.widgets ?? []) {
        const viewId = widget?.configuration?.viewId;
        if (widget?.type === 'FIELDS' && viewId) viewIds.add(viewId);
      }
    }
  }
  return Array.from(viewIds);
};

// When a Fields view has viewFieldGroups (record pages are seeded with
// several), the widget renders ONLY viewFields bucketed into a group —
// a row with viewFieldGroupId null matches no bucket and is silently
// dropped, however visible/positioned it is. Position also sorts WITHIN
// the group, so group membership must be converged before position means
// anything. Custom fields are parked by the platform in the last group
// (e.g. "System"), which is the fallback when there is no anchor to copy.
const resolveFallbackGroupId = async (
  metadata: MetadataApiClient,
  viewId: string,
): Promise<string | undefined> => {
  const response = await metadata.query({
    getViewFieldGroups: {
      __args: { viewId },
      id: true,
      position: true,
      isVisible: true,
    },
  });
  const groups = (response?.getViewFieldGroups ?? [])
    .filter(
      (group: { isVisible?: boolean; id?: string }) =>
        group?.id && group?.isVisible !== false,
    )
    .sort(
      (a: { position?: number }, b: { position?: number }) =>
        (a.position ?? 0) - (b.position ?? 0),
    );
  return groups.length > 0 ? groups[groups.length - 1].id : undefined;
};

// Converges the field's viewField rows in every record-page Fields view:
// visibility, group membership (see resolveFallbackGroupId), and (when an
// anchor is given) position right below the anchor within the anchor's group.
//
// MUST run from a FRONT COMPONENT (user token): the viewField permission
// guards only recognize userWorkspaceId / apiKeyId — an application token is
// denied regardless of role, so logic functions cannot touch view layout.
export const ensureFieldLayoutVisibility = async ({
  objectMetadataId,
  fieldMetadataId,
  visible,
  anchorFieldMetadataId,
}: {
  objectMetadataId: string;
  fieldMetadataId: string;
  visible: boolean;
  anchorFieldMetadataId?: string;
}): Promise<void> => {
  const metadata = new MetadataApiClient();
  const viewIds = await findFieldsViewIds(metadata, objectMetadataId);

  for (const viewId of viewIds) {
    const response = await metadata.query({
      getViewFields: {
        __args: { viewId },
        id: true,
        fieldMetadataId: true,
        isVisible: true,
        position: true,
        viewFieldGroupId: true,
      },
    });
    const viewFields = response?.getViewFields ?? [];
    const own = viewFields.find(
      (viewField: { fieldMetadataId?: string }) =>
        viewField?.fieldMetadataId === fieldMetadataId,
    );
    const anchor = anchorFieldMetadataId
      ? viewFields.find(
          (viewField: { fieldMetadataId?: string }) =>
            viewField?.fieldMetadataId === anchorFieldMetadataId,
        )
      : undefined;
    // Float position: slot directly under the anchor (its position + 0.5
    // sorts after it and before the next integer-positioned field).
    const desiredPosition =
      anchor && typeof anchor.position === 'number'
        ? anchor.position + 0.5
        : undefined;
    const desiredGroupId: string | undefined =
      anchor?.viewFieldGroupId ??
      own?.viewFieldGroupId ??
      (await resolveFallbackGroupId(metadata, viewId));

    if (!own) {
      await metadata.mutation({
        createViewField: {
          __args: {
            input: {
              viewId,
              fieldMetadataId,
              isVisible: visible,
              ...(desiredPosition !== undefined
                ? { position: desiredPosition }
                : {}),
              ...(desiredGroupId !== undefined
                ? { viewFieldGroupId: desiredGroupId }
                : {}),
            },
          },
          id: true,
        },
      });
      continue;
    }

    const positionWrong =
      desiredPosition !== undefined && own.position !== desiredPosition;
    const groupWrong =
      desiredGroupId !== undefined && own.viewFieldGroupId !== desiredGroupId;
    if (own.isVisible !== visible || (visible && positionWrong) || groupWrong) {
      await metadata.mutation({
        updateViewField: {
          __args: {
            input: {
              id: own.id,
              update: {
                isVisible: visible,
                ...(desiredPosition !== undefined
                  ? { position: desiredPosition }
                  : {}),
                ...(desiredGroupId !== undefined
                  ? { viewFieldGroupId: desiredGroupId }
                  : {}),
              },
            },
          },
          id: true,
        },
      });
    }
  }
};

// Writes `value` into the companion column of every record that differs.
const bulkWriteCompanion = async (
  client: FormulaClient,
  objectName: string,
  fieldName: string,
  value: string | null,
  pageSize = 100,
): Promise<number> => {
  const pluralName = pluralize(objectName);
  const mutationName = `update${objectName.charAt(0).toUpperCase()}${objectName.slice(1)}`;
  let written = 0;
  let after: string | undefined;

  for (;;) {
    const response = await withRetry(() =>
      client.query({
        [pluralName]: {
          __args: { first: pageSize, ...(after ? { after } : {}) },
          edges: { node: { id: true, [fieldName]: true } },
          pageInfo: { hasNextPage: true, endCursor: true },
        },
      }),
    );
    const connection = response?.[pluralName];
    for (const edge of connection?.edges ?? []) {
      const node = edge?.node;
      if (!node?.id) continue;
      if ((node[fieldName] ?? null) === value) continue;
      await withRetry(() =>
        client.mutation({
          [mutationName]: {
            __args: { id: node.id, data: { [fieldName]: value } },
            id: true,
          },
        }),
      );
      written += 1;
    }
    if (!connection?.pageInfo?.hasNextPage) break;
    after = connection.pageInfo.endCursor ?? undefined;
  }
  return written;
};

// Converges the companion CHIP VALUES to the formula's operational status
// (null when healthy). Runs server-side (record writes work with the app
// token); LAYOUT visibility is converged separately by the front components
// via convergeFormulaFieldLayout (view mutations need a user token).
export const syncCompanionStatusField = async (
  client: FormulaClient,
  objectIndex: ObjectFieldIndex | undefined,
  definition: FormulaDefinitionRecord,
  status: string,
): Promise<void> => {
  if (!objectIndex || !definition.targetObject || !definition.targetField) {
    return;
  }
  const fieldName = companionFieldName(definition.targetField);
  const companion = objectIndex.fields.get(fieldName);
  if (!companion) return;

  // Legacy heal: companions are meant to be always-active now.
  if (!companion.isActive) {
    await setFieldActive(companion.id, true);
    companion.isActive = true;
  }

  await bulkWriteCompanion(
    client,
    definition.targetObject,
    fieldName,
    status === '' ? null : status,
  );
};

// Front-component layout convergence: value field visible, companion chip
// visible only while broken and slotted right under it. Idempotent and
// write-avoidant; throttled so widget polling doesn't spam the metadata API.
// Silently a no-op for users without the VIEWS permission.
const layoutConvergedAt = new Map<string, number>();
const LAYOUT_CONVERGE_TTL_MS = 60_000;

export const convergeFormulaFieldLayout = async ({
  objectNameSingular,
  targetField,
  statusVisible,
}: {
  objectNameSingular: string;
  targetField: string;
  statusVisible: boolean;
}): Promise<void> => {
  const signature = `${objectNameSingular}.${targetField}:${statusVisible}`;
  const last = layoutConvergedAt.get(signature);
  if (last && Date.now() - last < LAYOUT_CONVERGE_TTL_MS) return;
  layoutConvergedAt.set(signature, Date.now());

  try {
    const index = await loadObjectFieldIndex();
    const objectIndex = index.get(objectNameSingular);
    if (!objectIndex) return;
    const valueField = objectIndex.fields.get(targetField);
    const companion = objectIndex.fields.get(companionFieldName(targetField));

    if (valueField?.isActive) {
      await ensureFieldLayoutVisibility({
        objectMetadataId: objectIndex.objectMetadataId,
        fieldMetadataId: valueField.id,
        visible: true,
      });
    }
    if (companion?.isActive) {
      await ensureFieldLayoutVisibility({
        objectMetadataId: objectIndex.objectMetadataId,
        fieldMetadataId: companion.id,
        visible: statusVisible,
        anchorFieldMetadataId: valueField?.id,
      });
    }
  } catch {
    // Layout is cosmetic; permission or transport failures must not break
    // the widget. Allow a retry after the TTL.
  }
};
