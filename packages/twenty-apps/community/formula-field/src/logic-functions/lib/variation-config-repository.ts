import { type VariationConfigRecord } from 'src/logic-functions/lib/variation-types';
import { type FormulaClient } from 'src/logic-functions/lib/types';
import { withRetry } from 'src/logic-functions/lib/with-retry';

const VARIATION_CONFIG_FIELDS_SELECTION = {
  id: true,
  name: true,
  targetObject: true,
  relationFieldName: true,
  createdRelationField: true,
  enabled: true,
  lastSyncedAt: true,
  lastError: true,
  status: true,
  statusReason: true,
} as const;

export const loadAllEnabledVariationConfigs = async (
  client: FormulaClient,
  pageSize = 200,
): Promise<VariationConfigRecord[]> => {
  const results: VariationConfigRecord[] = [];
  let after: string | undefined;

  for (;;) {
    const response = await withRetry(() =>
      client.query({
        variationConfigs: {
          __args: {
            first: pageSize,
            filter: { enabled: { eq: true } },
            ...(after ? { after } : {}),
          },
          edges: { node: VARIATION_CONFIG_FIELDS_SELECTION },
          pageInfo: { hasNextPage: true, endCursor: true },
        },
      }),
    );
    const connection = response?.variationConfigs;
    for (const edge of connection?.edges ?? []) {
      if (edge?.node) results.push(edge.node as VariationConfigRecord);
    }
    if (!connection?.pageInfo?.hasNextPage) break;
    after = connection.pageInfo.endCursor ?? undefined;
  }

  return results;
};

// Every config regardless of `enabled`. The enabled-only loader above drives
// role resolution (an unclaimed object stays invisible); this all-configs read
// is used ONLY on the widget's hidden branch to tell a genuinely unconfigured
// object apart from one whose config exists but is DISABLED.
export const loadAllVariationConfigs = async (
  client: FormulaClient,
  pageSize = 200,
): Promise<VariationConfigRecord[]> => {
  const results: VariationConfigRecord[] = [];
  let after: string | undefined;

  for (;;) {
    const response = await withRetry(() =>
      client.query({
        variationConfigs: {
          __args: {
            first: pageSize,
            ...(after ? { after } : {}),
          },
          edges: { node: VARIATION_CONFIG_FIELDS_SELECTION },
          pageInfo: { hasNextPage: true, endCursor: true },
        },
      }),
    );
    const connection = response?.variationConfigs;
    for (const edge of connection?.edges ?? []) {
      if (edge?.node) results.push(edge.node as VariationConfigRecord);
    }
    if (!connection?.pageInfo?.hasNextPage) break;
    after = connection.pageInfo.endCursor ?? undefined;
  }

  return results;
};

export const findVariationConfigByTargetObject = async (
  client: FormulaClient,
  targetObject: string,
): Promise<VariationConfigRecord | null> => {
  const response = await withRetry(() =>
    client.query({
      variationConfigs: {
        __args: { first: 1, filter: { targetObject: { eq: targetObject } } },
        edges: { node: VARIATION_CONFIG_FIELDS_SELECTION },
      },
    }),
  );
  return (
    (response?.variationConfigs?.edges?.[0]?.node as
      | VariationConfigRecord
      | undefined) ?? null
  );
};

// Single fresh read of one config by id (singular-record convention, same shape
// as variation-sync's fetchRecordById). Used to re-check the CURRENT stored
// record before acting on a possibly-stale trigger snapshot.
export const findVariationConfigById = async (
  client: FormulaClient,
  configId: string,
): Promise<VariationConfigRecord | null> => {
  const response = await withRetry(() =>
    client.query({
      variationConfig: {
        __args: { filter: { id: { eq: configId } } },
        ...VARIATION_CONFIG_FIELDS_SELECTION,
      },
    }),
  );
  return (
    (response?.variationConfig as VariationConfigRecord | null) ?? null
  );
};

export const updateVariationConfigBookkeeping = async (
  client: FormulaClient,
  configId: string,
  data: {
    lastSyncedAt?: string;
    lastError?: string;
    status?: string;
    statusReason?: string;
  },
): Promise<void> => {
  await withRetry(() =>
    client.mutation({
      updateVariationConfig: {
        __args: { id: configId, data },
        id: true,
      },
    }),
  );
};

// 24h heartbeat: the editor shows lastSyncedAt as "last synced", so it cannot
// go permanently stale — but bumping it every hourly sweep churned one
// variationConfig.updated timeline row per config per hour (ADR 0022).
export const VARIATION_BOOKKEEPING_HEARTBEAT_MS = 24 * 60 * 60 * 1000;

// Write-avoidant bookkeeping (mirrors formula-repository's M3 contract): a
// no-op sweep performs ZERO config-row writes. Writes only when error/status
// content changed, or once per heartbeat window to keep lastSyncedAt honest.
// NaN from an unparsable lastSyncedAt reads as heartbeat-due, not fresh
// (same Number.isFinite posture as recordEvaluationHeartbeat).
export const updateVariationConfigBookkeepingIfChanged = async (
  client: FormulaClient,
  config: VariationConfigRecord,
  next: { lastError: string; status: string; statusReason: string },
): Promise<boolean> => {
  const changed =
    (config.lastError ?? '') !== next.lastError ||
    (config.status ?? '') !== next.status ||
    (config.statusReason ?? '') !== next.statusReason;
  const lastSyncedAtMs = Date.parse(config.lastSyncedAt ?? '');
  const heartbeatDue =
    !Number.isFinite(lastSyncedAtMs) ||
    Date.now() - lastSyncedAtMs > VARIATION_BOOKKEEPING_HEARTBEAT_MS;
  if (!changed && !heartbeatDue) {
    return false;
  }
  await updateVariationConfigBookkeeping(client, config.id, {
    lastSyncedAt: new Date().toISOString(),
    lastError: next.lastError,
    status: next.status,
    statusReason: next.statusReason,
  });
  return true;
};
