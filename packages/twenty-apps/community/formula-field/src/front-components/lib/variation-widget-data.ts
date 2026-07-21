import { deriveRecordDisplayLabel } from 'src/front-components/lib/formula-field-formats';
import { loadAllObjectsWithFields } from 'src/logic-functions/lib/metadata-objects';
import { selectionEntryForMirrorKind } from 'src/logic-functions/lib/mirror-kinds';
import {
  deactivateOverride,
  loadActiveOverrideFieldsForRecord,
} from 'src/logic-functions/lib/override-repository';
import { computeSyncableFields } from 'src/logic-functions/lib/syncable-fields';
import { pluralize } from 'src/logic-functions/lib/recompute';
import { type FormulaClient } from 'src/logic-functions/lib/types';
import { loadAllVariationConfigs } from 'src/logic-functions/lib/variation-config-repository';
import { type VariationConfigRecord } from 'src/logic-functions/lib/variation-types';
import {
  fetchPrimaryRecordInclTrashed,
  syncOneVariation,
  type SyncOutcome,
} from 'src/logic-functions/lib/variation-sync';
import { withRetry } from 'src/logic-functions/lib/with-retry';

// The widget's pure, testable data layer (design 2026-07-07, Plan 3 Task 1).
// Every function here reuses the Plan 1 sync engine directly — the widget UI
// (Tasks 3-4) is a thin shell over these. Nothing here holds React state or
// touches the DOM, so the whole surface is unit-tested against FakeClient.

// ADR 0024: the metadata catalog is object-independent and its loader dedupes
// in-flight callers, so the widget fires it at t0 — concurrent with the config
// scan — instead of paying it as a sequential leg after host resolution
// (~300ms on cloud). Fire-and-forget: the real consumers (resolveLabelField,
// computeSyncableFields) still await their own call and surface any failure;
// this reference just must not become an unhandled rejection.
export const prefetchMetadataCatalog = (): void => {
  void loadAllObjectsWithFields().catch(() => {});
};

const DEFAULT_RELATION_FIELD = 'primaryRecord';

const relationFieldOf = (config: VariationConfigRecord): string =>
  config.relationFieldName ?? DEFAULT_RELATION_FIELD;

export type LabelFieldInfo = { name: string; kind: string };

// The object's label-identifier field (name + kind), resolved from the shared
// metadata pull. Any kind is returned here; the label WRITE/READ policy narrows
// to TEXT/FULL_NAME at the call sites (matching the wizard's labelFieldSelection
// policy). Returns null when the object or its label field can't be resolved.
export const resolveLabelField = async (
  objectName: string,
): Promise<LabelFieldInfo | null> => {
  const objects = await loadAllObjectsWithFields();
  const object = objects.find((candidate) => candidate.nameSingular === objectName);
  if (!object || !object.labelIdentifierFieldMetadataId) {
    return null;
  }
  const field = object.fields.find(
    (candidate) => candidate.id === object.labelIdentifierFieldMetadataId,
  );
  return field ? { name: field.name, kind: field.type } : null;
};

// Only TEXT / FULL_NAME labels are readable/writable (same policy as the
// wizard); every other kind yields no label. Narrows a resolved label field to
// the selectable subset.
const selectableLabelField = (
  labelField: LabelFieldInfo | null,
): LabelFieldInfo | null =>
  labelField && (labelField.kind === 'TEXT' || labelField.kind === 'FULL_NAME')
    ? labelField
    : null;

// The (fields, selectionOverrides) pair fetchPrimaryRecordInclTrashed needs to
// read a kind-aware label: TEXT selects scalar `true`; FULL_NAME selects the
// {firstName,lastName} composite.
const labelSelectionArgs = (
  labelField: LabelFieldInfo | null,
): { fields: string[]; overrides: Record<string, unknown> } => {
  const selectable = selectableLabelField(labelField);
  if (!selectable) {
    return { fields: [], overrides: {} };
  }
  if (selectable.kind === 'FULL_NAME') {
    return {
      fields: [],
      overrides: { [selectable.name]: selectionEntryForMirrorKind('FULL_NAME') },
    };
  }
  return { fields: [selectable.name], overrides: {} };
};

export type WidgetRole =
  | { kind: 'hidden' }
  | { kind: 'primary'; config: VariationConfigRecord }
  | {
      kind: 'variation';
      config: VariationConfigRecord;
      primaryRecordId: string;
      frozen: boolean;
      primaryLabel: string | null;
    };

// One call resolving everything the shell needs: config lookup, a FRESH pointer
// read (never trusted from a cached prop — same rule as the dispatchers), and
// for a variation a deletedAt-inclusive primary fetch that also yields the
// label. Hidden when no enabled config exists for the object.
export const resolveWidgetRole = async (
  client: FormulaClient,
  objectName: string,
  recordId: string,
  // The caller's load() already scanned all enabled configs — re-querying the
  // same config here was a redundant sequential leg on the first-paint path.
  config: VariationConfigRecord | null,
): Promise<WidgetRole> => {
  if (!config || config.enabled !== true) {
    return { kind: 'hidden' };
  }

  const relationFieldName = relationFieldOf(config);
  const pointerField = `${relationFieldName}Id`;

  // Fresh one-field pointer read: a cached pointer prop is exactly the value an
  // echo-race could make stale, so re-read it before deciding the role.
  const pointerResponse = await withRetry(() =>
    client.query({
      [objectName]: {
        __args: { filter: { id: { eq: recordId } } },
        id: true,
        [pointerField]: true,
      },
    }),
  );
  const record = pointerResponse?.[objectName] as
    | Record<string, unknown>
    | null
    | undefined;
  const primaryRecordId =
    (record?.[pointerField] as string | null | undefined) ?? null;

  if (!primaryRecordId) {
    return { kind: 'primary', config };
  }

  const labelField = await resolveLabelField(objectName);
  const { fields, overrides } = labelSelectionArgs(labelField);
  const { record: primary, frozen } = await fetchPrimaryRecordInclTrashed(
    client,
    objectName,
    primaryRecordId,
    fields,
    overrides,
    relationFieldName,
  );

  const selectable = selectableLabelField(labelField);
  const primaryLabel =
    primary && selectable
      ? deriveRecordDisplayLabel(primary, selectable.name, selectable.kind)
      : null;

  return {
    kind: 'variation',
    config,
    primaryRecordId,
    frozen,
    primaryLabel,
  };
};

export type HiddenReason = 'no-config' | 'disabled-config';

// Called ONLY on the widget's hidden branch (no ENABLED config claims this
// record's object). Distinguishes a genuinely unconfigured object ('no-config'
// → the widget renders null, byte-identical to before) from an object whose
// Variation config exists but is DISABLED ('disabled-config' → a one-line hint,
// so a disabled config no longer leaves a permanently blank pane under the
// still-present "Variations" tab). Scoped to the hidden branch: one all-configs
// read plus a probe per DISABLED targetObject, so the happy path pays nothing.
export const resolveHiddenReason = async (
  client: FormulaClient,
  recordId: string,
): Promise<HiddenReason> => {
  const configs = await loadAllVariationConfigs(client);
  const disabledTargets = Array.from(
    new Set(
      configs
        .filter((config) => config.enabled !== true)
        .map((config) => config.targetObject)
        .filter(Boolean),
    ),
  ) as string[];

  for (const targetObject of disabledTargets) {
    const response = await client.query({
      [targetObject]: {
        __args: { filter: { id: { eq: recordId } } },
        id: true,
      },
    });
    if (response?.[targetObject]) {
      return 'disabled-config';
    }
  }

  return 'no-config';
};

// Active override field names grouped by variation record id, loaded in ONE
// paginated query (filter targetObject + active) — never one query per
// variation. The grouped shape lets loadVariationList compute every variation's
// diverged count from a single read.
const loadActiveOverridesGroupedByRecord = async (
  client: FormulaClient,
  targetObject: string,
  pageSize = 500,
): Promise<Map<string, Set<string>>> => {
  const grouped = new Map<string, Set<string>>();
  let after: string | undefined;

  for (;;) {
    const response = await withRetry(() =>
      client.query({
        formulaOverrides: {
          __args: {
            first: pageSize,
            filter: {
              targetObject: { eq: targetObject },
              active: { eq: true },
            },
            ...(after ? { after } : {}),
          },
          edges: { node: { recordId: true, targetField: true } },
          pageInfo: { hasNextPage: true, endCursor: true },
        },
      }),
    );
    const connection = response?.formulaOverrides;
    for (const edge of connection?.edges ?? []) {
      const recordId = edge?.node?.recordId as string | undefined;
      const targetField = edge?.node?.targetField as string | undefined;
      if (!recordId || !targetField) continue;
      const fields = grouped.get(recordId) ?? new Set<string>();
      fields.add(targetField);
      grouped.set(recordId, fields);
    }
    if (!connection?.pageInfo?.hasNextPage) break;
    after = connection.pageInfo.endCursor ?? undefined;
  }

  return grouped;
};

type VariationRecordWithLabel = { id: string; label: string | null };

// Every variation id AND its kind-aware label in ONE paginated read: the label
// field (already resolved from the ≤60s metadata cache) rides the same
// variation-ids query that filters the plural object by the config relation FK.
// A page of M variations costs one query instead of M singular label reads. The
// label selection is part of the per-query node selection, so it is applied to
// EVERY page automatically — pagination never dilutes it. No selectable label
// field -> ids-only selection and label:null for every entry (the OVERRIDE load
// still can't ride this read, but labels always could — they belong to the
// variation record itself, not the formulaOverrides connection).
const loadVariationRecordsWithLabels = async (
  client: FormulaClient,
  targetObject: string,
  relationFieldName: string,
  primaryRecordId: string,
  labelField: LabelFieldInfo | null,
  pageSize = 200,
): Promise<VariationRecordWithLabel[]> => {
  const pluralName = pluralize(targetObject);
  const filterFieldName = `${relationFieldName}Id`;
  const selectable = selectableLabelField(labelField);
  const { fields, overrides } = labelSelectionArgs(labelField);
  const labelSelection: Record<string, unknown> = {
    ...Object.fromEntries(fields.map((fieldName) => [fieldName, true])),
    ...overrides,
  };

  const records: VariationRecordWithLabel[] = [];
  let after: string | undefined;

  for (;;) {
    const response = await withRetry(() =>
      client.query({
        [pluralName]: {
          __args: {
            first: pageSize,
            filter: { [filterFieldName]: { eq: primaryRecordId } },
            ...(after ? { after } : {}),
          },
          edges: { node: { id: true, ...labelSelection } },
          pageInfo: { hasNextPage: true, endCursor: true },
        },
      }),
    );
    const connection = response?.[pluralName];
    for (const edge of connection?.edges ?? []) {
      const node = edge?.node as Record<string, unknown> | undefined;
      const id = node?.id as string | undefined;
      if (!id) continue;
      const label = selectable
        ? deriveRecordDisplayLabel(node, selectable.name, selectable.kind)
        : null;
      records.push({ id, label });
    }
    if (!connection?.pageInfo?.hasNextPage) break;
    after = connection.pageInfo.endCursor ?? undefined;
  }

  return records;
};

export type VariationListEntry = {
  id: string;
  label: string | null;
  divergedCount: number;
};

// Primary view data: every variation id (paginated), its display label, and its
// diverged-field count = active override fields ∩ current syncable set.
export const loadVariationList = async (
  client: FormulaClient,
  config: VariationConfigRecord,
  primaryRecordId: string,
): Promise<VariationListEntry[]> => {
  const targetObject = config.targetObject ?? '';
  const relationFieldName = relationFieldOf(config);

  // Label-field resolution must precede the ids+labels read (it shapes that
  // read's selection) — but it's a cached-metadata lookup, not a query. The
  // three actual reads below are mutually independent, so they run in parallel.
  const labelField = await resolveLabelField(targetObject);

  const [syncable, overridesByRecord, variations] = await Promise.all([
    computeSyncableFields(client, targetObject, relationFieldName),
    loadActiveOverridesGroupedByRecord(client, targetObject),
    loadVariationRecordsWithLabels(
      client,
      targetObject,
      relationFieldName,
      primaryRecordId,
      labelField,
    ),
  ]);
  const syncableNames = new Set(syncable.map((field) => field.name));

  return variations.map((variation) => {
    const overrideFields = overridesByRecord.get(variation.id) ?? new Set<string>();
    let divergedCount = 0;
    for (const fieldName of overrideFields) {
      if (syncableNames.has(fieldName)) divergedCount += 1;
    }
    return { id: variation.id, label: variation.label, divergedCount };
  });
};

export type DivergedField = { name: string; kind: string };

// Variation view data: the active overrides on this record ∩ the syncable set,
// carried as {name, kind} so the re-sync action knows the field's selection
// shape.
export const loadDivergedFields = async (
  client: FormulaClient,
  config: VariationConfigRecord,
  variationRecordId: string,
): Promise<DivergedField[]> => {
  const targetObject = config.targetObject ?? '';
  const relationFieldName = relationFieldOf(config);

  const syncable = await computeSyncableFields(client, targetObject, relationFieldName);
  const activeOverrideFields = await loadActiveOverrideFieldsForRecord(
    client,
    targetObject,
    variationRecordId,
  );

  return syncable
    .filter((field) => activeOverrideFields.has(field.name))
    .map((field) => ({ name: field.name, kind: field.kind }));
};

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// "<primary label> (variation)", numbered on collision. Scans the existing
// variation labels for the exact base and "(variation N)" suffixes: the plain
// base counts as 1, and the next label is max(taken)+1. The primary label is
// regex-escaped so a label like "Acme (test)" matches literally.
export const nextVariationLabel = (
  primaryLabel: string,
  existingLabels: (string | null)[],
): string => {
  const base = `${primaryLabel} (variation)`;
  const numberedPattern = new RegExp(
    `^${escapeRegExp(primaryLabel)} \\(variation (\\d+)\\)$`,
  );

  let maxTaken = 0;
  for (const label of existingLabels) {
    if (label == null) continue;
    if (label === base) {
      maxTaken = Math.max(maxTaken, 1);
      continue;
    }
    const match = numberedPattern.exec(label);
    if (match) {
      maxTaken = Math.max(maxTaken, Number(match[1]));
    }
  }

  return maxTaken === 0 ? base : `${primaryLabel} (variation ${maxTaken + 1})`;
};

// The label WRITE policy for creating a variation, by label-field kind:
//   TEXT      -> { [labelField]: nextVariationLabel(...) }
//   FULL_NAME -> { [labelField]: { firstName: <copied>, lastName: numbered } }
//   other/unknown -> {} (create unnamed; server default applies). Numbering is
// only meaningful where we can write a label at all, so non-TEXT/FULL_NAME
// label objects get unnamed variations — acceptable for v1.
export const buildVariationLabelData = (
  labelField: LabelFieldInfo | null,
  primaryRecord: Record<string, unknown>,
  existingLabels: (string | null)[],
): Record<string, unknown> => {
  if (!labelField) {
    return {};
  }

  if (labelField.kind === 'TEXT') {
    const current = primaryRecord[labelField.name];
    const primaryLabel = typeof current === 'string' ? current : '';
    return { [labelField.name]: nextVariationLabel(primaryLabel, existingLabels) };
  }

  if (labelField.kind === 'FULL_NAME') {
    const composite = (primaryRecord[labelField.name] ?? {}) as {
      firstName?: unknown;
      lastName?: unknown;
    };
    const firstName = typeof composite.firstName === 'string' ? composite.firstName : '';
    const lastName = typeof composite.lastName === 'string' ? composite.lastName : '';
    return {
      [labelField.name]: {
        firstName,
        lastName: nextVariationLabel(lastName, existingLabels),
      },
    };
  }

  return {};
};

// Re-sync one diverged field: deactivate the override (keeping its value —
// existing toggle-OFF semantic), then copy the primary's current value via
// syncOneVariation scoped to exactly this field. Returns {frozen:true} — with
// NO write and the override left ACTIVE — when the primary is gone, because
// deactivating without a copy would silently hand the field to nothing.
export const resyncDivergedField = async (
  client: FormulaClient,
  config: VariationConfigRecord,
  variationRecordId: string,
  field: DivergedField,
): Promise<SyncOutcome | { frozen: true }> => {
  const targetObject = config.targetObject ?? '';
  const relationFieldName = relationFieldOf(config);
  const pointerField = `${relationFieldName}Id`;

  // Fresh pointer read: the variation's primary id is re-read, never trusted
  // from a cached prop.
  const pointerResponse = await withRetry(() =>
    client.query({
      [targetObject]: {
        __args: { filter: { id: { eq: variationRecordId } } },
        id: true,
        [pointerField]: true,
      },
    }),
  );
  const primaryRecordId =
    ((pointerResponse?.[targetObject] as Record<string, unknown> | null | undefined)?.[
      pointerField
    ] as string | null | undefined) ?? null;
  if (!primaryRecordId) {
    return { frozen: true };
  }

  const { record: primary, frozen } = await fetchPrimaryRecordInclTrashed(
    client,
    targetObject,
    primaryRecordId,
    [field.name],
    { [field.name]: selectionEntryForMirrorKind(field.kind) },
    relationFieldName,
  );
  if (frozen || !primary) {
    return { frozen: true };
  }

  // Deactivate FIRST: syncOneVariation skips actively-overridden fields, so the
  // override must be off before the copy. If the sync then errors, the override
  // stays deactivated and the hourly sweep converges the field — acceptable.
  // reconcileOverrides: false — the user explicitly asked for the primary's
  // value; the rename-reconcile guard must not re-pin this field off a
  // coincidental orphaned-override value match.
  await deactivateOverride(client, targetObject, field.name, variationRecordId);
  return syncOneVariation(
    client,
    targetObject,
    primary,
    variationRecordId,
    [field],
    relationFieldName,
    { reconcileOverrides: false },
  );
};
