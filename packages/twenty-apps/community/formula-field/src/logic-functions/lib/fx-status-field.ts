import { MetadataApiClient } from 'twenty-client-sdk/metadata';

import { loadAllObjectsWithFields } from 'src/logic-functions/lib/metadata-objects';

// Layout plumbing for wizard-created formula value fields. Historically this
// module also owned the per-record "FX Status" companion SELECT field; ADR
// 0021 removed that in favor of a status snackbar, so what remains is the
// viewField convergence used to hide a TRASHED definition's value field, plus
// companionFieldName — still needed by the legacy-tolerance paths (lifecycle,
// delete-completely, timeline-cleanup) and the companion cleanup sweep.

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
    const objects = await loadAllObjectsWithFields();
    for (const object of objects) {
      const fields = new Map<string, FieldInfo>();
      for (const field of object.fields) {
        fields.set(field.name, { id: field.id, isActive: field.isActive });
      }
      index.set(object.nameSingular, {
        objectMetadataId: object.id,
        fields,
      });
    }
  } catch {
    // Metadata unavailable -> empty index (companions simply not synced).
  }
  return index;
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
      // A missing viewField row is already invisible — never create one just to
      // hide a field (that is exactly the trashed-definition convergence path).
      if (!visible) continue;
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

// Front-component layout convergence for a TRASHED (soft-deleted) definition's
// value field. Idempotent and write-avoidant; throttled so widget polling
// doesn't spam the metadata API. Silently a no-op for users without the
// VIEWS permission.
const layoutConvergedAt = new Map<string, number>();
const LAYOUT_CONVERGE_TTL_MS = 60_000;

// Test-only: reset / inspect the convergence throttle map so unit tests can
// assert the key-clearing interaction without waiting out the 60s TTL.
export const resetLayoutConvergenceThrottle = (): void => {
  layoutConvergedAt.clear();
};
export const getLayoutConvergenceKeys = (): string[] =>
  Array.from(layoutConvergedAt.keys());

// Hides a TRASHED (soft-deleted) definition's value field: this app's field,
// no live definition still targets it. A naive delete performs NO field
// mutation (the value column stays ACTIVE), so this layout flip is the only
// thing that removes the orphaned field from the record page. Inactive fields
// (legacy deletes that DID deactivate) are skipped — they already left the
// views.
export const convergeTrashedDefinitionLayout = async ({
  objectNameSingular,
  targetField,
}: {
  objectNameSingular: string;
  targetField: string;
}): Promise<void> => {
  const signature = `${objectNameSingular}.${targetField}:trashed`;
  const last = layoutConvergedAt.get(signature);
  if (last && Date.now() - last < LAYOUT_CONVERGE_TTL_MS) return;
  layoutConvergedAt.set(signature, Date.now());

  try {
    const index = await loadObjectFieldIndex();
    const objectIndex = index.get(objectNameSingular);
    if (!objectIndex) return;
    const valueField = objectIndex.fields.get(targetField);

    if (valueField?.isActive) {
      await ensureFieldLayoutVisibility({
        objectMetadataId: objectIndex.objectMetadataId,
        fieldMetadataId: valueField.id,
        visible: false,
      });
    }
  } catch {
    // Layout is cosmetic; permission or transport failures must not break
    // the widget. Allow a retry after the TTL.
  }
};
