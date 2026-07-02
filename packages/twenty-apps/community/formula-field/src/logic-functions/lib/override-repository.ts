import { type FormulaClient } from 'src/logic-functions/lib/types';
import { withRetry } from 'src/logic-functions/lib/with-retry';

// Data access for FormulaOverride rows (feature #2). One row per
// (targetObject, targetField, recordId). The `name` field is a deterministic key
// so lookups and idempotent upserts are simple.

export type OverrideRecord = {
  id: string;
  targetObject: string;
  targetField: string;
  recordId: string;
  overrideValue: number | null;
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
} as const;

// All overridden record ids for a given (object, field) — used by recompute to
// skip pinned records in one pass.
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

export const upsertOverride = async (
  client: FormulaClient,
  targetObject: string,
  targetField: string,
  recordId: string,
  overrideValue: number | null,
): Promise<void> => {
  const existing = await findOverride(client, targetObject, targetField, recordId);
  if (existing) {
    if (existing.overrideValue !== overrideValue) {
      await withRetry(() =>
        client.mutation({
          updateFormulaOverride: {
            __args: { id: existing.id, data: { overrideValue } },
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
          },
        },
        id: true,
      },
    }),
  );
};

export const deleteOverride = async (
  client: FormulaClient,
  targetObject: string,
  targetField: string,
  recordId: string,
): Promise<boolean> => {
  const existing = await findOverride(client, targetObject, targetField, recordId);
  if (!existing) return false;
  await withRetry(() =>
    client.mutation({
      deleteFormulaOverride: { __args: { id: existing.id }, id: true },
    }),
  );
  return true;
};
