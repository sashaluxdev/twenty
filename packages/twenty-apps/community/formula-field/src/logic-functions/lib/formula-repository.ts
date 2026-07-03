import {
  type FormulaClient,
  type FormulaDefinitionRecord,
} from 'src/logic-functions/lib/types';
import { withRetry } from 'src/logic-functions/lib/with-retry';

// Data-access for FormulaDefinition records. Kept separate from the recompute
// engine so both can be tested against a fake client.

const FORMULA_FIELDS = {
  id: true,
  name: true,
  targetObject: true,
  targetField: true,
  targetFieldType: true,
  currencyCode: true,
  outputFormat: true,
  createdField: true,
  expression: true,
  enabled: true,
  lastValue: true,
  lastError: true,
  status: true,
  statusReason: true,
} as const;

// Loads all enabled formula definitions (optionally filtered by target object),
// paginating fully so large workspaces are handled.
export const loadEnabledFormulas = async (
  client: FormulaClient,
  targetObject?: string,
  pageSize = 200,
): Promise<FormulaDefinitionRecord[]> => {
  const filter: Record<string, unknown> = { enabled: { eq: true } };
  if (targetObject) {
    filter.targetObject = { eq: targetObject };
  }

  const formulas: FormulaDefinitionRecord[] = [];
  let after: string | undefined;

  for (;;) {
    const response = await withRetry(() =>
      client.query({
        formulaDefinitions: {
          __args: {
            first: pageSize,
            filter,
            ...(after ? { after } : {}),
          },
          edges: { node: FORMULA_FIELDS },
          pageInfo: { hasNextPage: true, endCursor: true },
        },
      }),
    );

    const connection = response?.formulaDefinitions;
    const edges: Array<{ node?: FormulaDefinitionRecord }> =
      connection?.edges ?? [];

    for (const edge of edges) {
      if (edge?.node) {
        formulas.push(edge.node);
      }
    }

    if (!connection?.pageInfo?.hasNextPage) {
      break;
    }
    after = connection.pageInfo.endCursor ?? undefined;
  }

  return formulas;
};

// Loads all enabled formula definitions across every target object — used by the
// cron sweep and by save-time cycle detection (which needs the whole graph).
export const loadAllEnabledFormulas = (
  client: FormulaClient,
): Promise<FormulaDefinitionRecord[]> => loadEnabledFormulas(client);

export type BookkeepingUpdate = {
  lastValue?: number | null;
  lastError?: string | null;
  lastEvaluatedAt?: string | null;
  // Set to persist the parsed dependency index (JSON).
  dependencies?: unknown;
  // Set to disable a formula that failed validation (e.g. cycle).
  enabled?: boolean;
  // Operational status (OFFLINE/UPSTREAM machinery) — system-managed.
  status?: string;
  statusReason?: string;
};

// Writes bookkeeping fields on a FormulaDefinition. Write-avoidant callers
// should only invoke this when something actually changed, to avoid churning
// formulaDefinition.updated events.
export const updateFormulaBookkeeping = async (
  client: FormulaClient,
  formulaId: string,
  update: BookkeepingUpdate,
): Promise<void> => {
  await withRetry(() =>
    client.mutation({
      updateFormulaDefinition: {
        __args: { id: formulaId, data: update },
        id: true,
      },
    }),
  );
};

// Records a "last evaluation" heartbeat on the FormulaDefinition: the most recent
// computed value, when it ran, and the error (empty when healthy). A formula is
// column-level so lastValue is a representative sample, not per-record. These are
// all bookkeeping fields, so the write is ignored by the save-time trigger and
// never loops.
//
// finding M3: write-avoidant. A no-op recompute (value unchanged, no new error)
// must perform ZERO definition-row writes — otherwise every same-record echo and
// every sweep pass rewrites the row purely to bump lastEvaluatedAt, churning
// formulaDefinition.updated events. So the timestamp ALONE never forces a write:
// only a changed value or changed error content does.
export const recordEvaluationHeartbeat = async (
  client: FormulaClient,
  formula: FormulaDefinitionRecord,
  outcome: { value: number | null; error: string | null },
): Promise<void> => {
  const nextValue = outcome.value ?? null;
  const nextError = outcome.error ?? '';
  const valueChanged = (formula.lastValue ?? null) !== nextValue;
  const errorChanged = (formula.lastError ?? '') !== nextError;
  if (!valueChanged && !errorChanged) {
    return;
  }
  await updateFormulaBookkeeping(client, formula.id, {
    lastValue: nextValue,
    lastError: nextError,
    lastEvaluatedAt: new Date().toISOString(),
  });
};
