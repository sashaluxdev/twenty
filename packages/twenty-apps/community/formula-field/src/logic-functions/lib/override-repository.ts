import { type FormulaClient } from 'src/logic-functions/lib/types';
import { withRetry } from 'src/logic-functions/lib/with-retry';

// Data access for FormulaOverride rows (feature #2). One row per
// (targetObject, targetField, recordId). The `name` field is a deterministic key
// so lookups and idempotent upserts are simple.
//
// An override has an `active` flag: only active overrides pin a record (recompute
// skips them). Turning an override off DEACTIVATES it (keeps the value) so it can
// be restored later, rather than deleting it.

export type OverrideRecord = {
  id: string;
  targetObject: string;
  targetField: string;
  recordId: string;
  // Engine-family (NUMBER/CURRENCY/DATE/DATE_TIME) targets pin their numeric
  // value here; mirror targets leave it null and pin overrideValueText instead.
  overrideValue: number | null;
  // Mirror targets (non-engine kinds) pin their raw value here, JSON-stringified
  // (scalar, array or composite); engine-family targets leave it null.
  overrideValueText: string | null;
  active: boolean;
};

export const overrideKey = (
  targetObject: string,
  targetField: string,
  recordId: string,
): string => `${targetObject}.${targetField}#${recordId}`;

const OVERRIDE_FIELDS = {
  id: true,
  targetObject: true,
  targetField: true,
  recordId: true,
  overrideValue: true,
  overrideValueText: true,
  active: true,
} as const;

// Active overridden record ids for a given (object, field) — used by recompute
// to skip pinned records in one pass. Only ACTIVE overrides count.
export const loadOverriddenRecordIds = async (
  client: FormulaClient,
  targetObject: string,
  targetField: string,
  pageSize = 500,
): Promise<Set<string>> => {
  const ids = new Set<string>();
  let after: string | undefined;

  for (;;) {
    const response = await withRetry(() =>
      client.query({
        formulaOverrides: {
          __args: {
            first: pageSize,
            filter: {
              targetObject: { eq: targetObject },
              targetField: { eq: targetField },
              active: { eq: true },
            },
            ...(after ? { after } : {}),
          },
          edges: { node: { recordId: true } },
          pageInfo: { hasNextPage: true, endCursor: true },
        },
      }),
    );
    const connection = response?.formulaOverrides;
    for (const edge of connection?.edges ?? []) {
      if (edge?.node?.recordId) ids.add(edge.node.recordId);
    }
    if (!connection?.pageInfo?.hasNextPage) break;
    after = connection.pageInfo.endCursor ?? undefined;
  }

  return ids;
};

// Returns the override row for a record (active or not), or null.
export const findOverride = async (
  client: FormulaClient,
  targetObject: string,
  targetField: string,
  recordId: string,
): Promise<OverrideRecord | null> => {
  const response = await withRetry(() =>
    client.query({
      formulaOverrides: {
        __args: {
          first: 1,
          filter: {
            name: { eq: overrideKey(targetObject, targetField, recordId) },
          },
        },
        edges: { node: OVERRIDE_FIELDS },
      },
    }),
  );
  return (
    (response?.formulaOverrides?.edges?.[0]?.node as OverrideRecord | undefined) ??
    null
  );
};

// The pinned value for an override: an engine-family target pins `numeric`
// (overrideValue); a mirror target pins `text` (overrideValueText, a
// JSON-stringified raw value). Exactly one is meaningful per call — the other
// column is written null so the two never disagree.
export type OverrideValue = {
  numeric?: number | null;
  text?: string | null;
};

// Creates or updates an ACTIVE override pinning the given value. Numeric targets
// pin overrideValue (overrideValueText null); mirror targets pin overrideValueText
// (overrideValue null).
export const upsertOverride = async (
  client: FormulaClient,
  targetObject: string,
  targetField: string,
  recordId: string,
  value: OverrideValue,
): Promise<void> => {
  const overrideValue = value.numeric ?? null;
  const overrideValueText = value.text ?? null;
  const existing = await findOverride(client, targetObject, targetField, recordId);
  if (existing) {
    if (
      existing.overrideValue !== overrideValue ||
      existing.overrideValueText !== overrideValueText ||
      existing.active !== true
    ) {
      await withRetry(() =>
        client.mutation({
          updateFormulaOverride: {
            __args: {
              id: existing.id,
              data: { overrideValue, overrideValueText, active: true },
            },
            id: true,
          },
        }),
      );
    }
    return;
  }
  await withRetry(() =>
    client.mutation({
      createFormulaOverride: {
        __args: {
          data: {
            name: overrideKey(targetObject, targetField, recordId),
            targetObject,
            targetField,
            recordId,
            overrideValue,
            overrideValueText,
            active: true,
          },
        },
        id: true,
      },
    }),
  );
};

// Decodes a mirror override's stored text back to its raw value. A parse failure
// (corrupted text) or an absent value signals "no restorable value" so the caller
// pins the CURRENT value instead of a broken one.
export const decodeMirrorOverrideValue = (
  text: string | null | undefined,
): { restorable: boolean; value: unknown } => {
  if (text === null || text === undefined) {
    return { restorable: false, value: null };
  }
  try {
    return { restorable: true, value: JSON.parse(text) };
  } catch {
    return { restorable: false, value: null };
  }
};

// Turns an override off but KEEPS its value, so it can be restored later.
export const deactivateOverride = async (
  client: FormulaClient,
  targetObject: string,
  targetField: string,
  recordId: string,
): Promise<boolean> => {
  const existing = await findOverride(client, targetObject, targetField, recordId);
  if (!existing || existing.active === false) return false;
  await withRetry(() =>
    client.mutation({
      updateFormulaOverride: {
        __args: { id: existing.id, data: { active: false } },
        id: true,
      },
    }),
  );
  return true;
};

// Re-activates a previously-set override and returns its stored value so the
// caller can write it back to the field. Returns null if there is no prior
// override to restore.
export const activateOverride = async (
  client: FormulaClient,
  targetObject: string,
  targetField: string,
  recordId: string,
): Promise<OverrideRecord | null> => {
  const existing = await findOverride(client, targetObject, targetField, recordId);
  if (!existing) return null;
  if (existing.active !== true) {
    await withRetry(() =>
      client.mutation({
        updateFormulaOverride: {
          __args: { id: existing.id, data: { active: true } },
          id: true,
        },
      }),
    );
  }
  return { ...existing, active: true };
};
