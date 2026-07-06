import { compileFormula } from 'src/engine';
import { graphqlEnum } from 'src/logic-functions/lib/dynamic-client';
import { isMirrorDefinition } from 'src/logic-functions/lib/mirror-kinds';
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
  lastValueText: true,
  lastError: true,
  lastEvaluatedAt: true,
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

// Minimal projection of a soft-deleted (trashed) FormulaDefinition — enough to
// decide field liveness and, for the front hide convergence, which fields to
// hide. Task 3 reuses this exact loader.
export type TrashedFormulaRecord = {
  id: string;
  targetObject?: string | null;
  targetField?: string | null;
  createdField?: boolean | null;
};

const TRASHED_FORMULA_FIELDS = {
  id: true,
  targetObject: true,
  targetField: true,
  createdField: true,
} as const;

// Loads soft-deleted (trashed) FormulaDefinitions, optionally scoped to one
// target object. The record API returns soft-deleted rows ONLY when the filter
// carries a deletedAt key (the server applies withDeleted() solely then), so the
// `deletedAt: { is: NOT_NULL }` clause is load-bearing. NOT_NULL is a FilterIs
// enum value, emitted unquoted via graphqlEnum. Paginates fully.
export const loadTrashedFormulas = async (
  client: FormulaClient,
  targetObject?: string,
  pageSize = 200,
): Promise<TrashedFormulaRecord[]> => {
  const filter: Record<string, unknown> = {
    deletedAt: { is: graphqlEnum('NOT_NULL') },
  };
  if (targetObject) {
    filter.targetObject = { eq: targetObject };
  }

  const trashed: TrashedFormulaRecord[] = [];
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
          edges: { node: TRASHED_FORMULA_FIELDS },
          pageInfo: { hasNextPage: true, endCursor: true },
        },
      }),
    );

    const connection = response?.formulaDefinitions;
    const edges: Array<{ node?: TrashedFormulaRecord }> =
      connection?.edges ?? [];

    for (const edge of edges) {
      if (edge?.node) {
        trashed.push(edge.node);
      }
    }

    if (!connection?.pageInfo?.hasNextPage) {
      break;
    }
    after = connection.pageInfo.endCursor ?? undefined;
  }

  return trashed;
};

export type BookkeepingUpdate = {
  lastValue?: number | null;
  // Mirror diagnostic value (JSON-stringified, truncated) — see FormulaDefinition.
  lastValueText?: string | null;
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
//
// ADR 0015 carve-out: for a formula that reads TODAY(), "no value change" does
// NOT mean "not evaluated" — a healthy TODAY formula can go a long time between
// value changes, so `lastEvaluatedAt` would otherwise mean "last change" and
// falsely look stale to the widget/editor. The caller-supplied
// `expressionUsesToday` flag (computed once from the already-parsed AST, no
// re-parse) scopes a single extra write — timestamp alone, nothing else — to
// only these formulas, and only once per hour (sweep cadence), so
// `lastEvaluatedAt` becomes truthful ("last evaluation") for TODAY formulas
// while every other formula keeps the original zero-write guarantee.
// JSON-stringifies a mirror's raw value for the lastValueText heartbeat,
// truncated to 500 chars (display/diagnostic only). A nullish value -> null text.
const MIRROR_VALUE_TEXT_MAX = 500;
const mirrorValueText = (rawValue: unknown): string | null => {
  if (rawValue === null || rawValue === undefined) {
    return null;
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(rawValue);
  } catch {
    // A pathologically deep or circular RAW_JSON value can throw here; this is a
    // display/diagnostic string only, so degrade to a marker rather than let the
    // heartbeat throw. Truncation still applies below.
    serialized = '[unserializable]';
  }
  return serialized.slice(0, MIRROR_VALUE_TEXT_MAX);
};

// True when the definition is a mirror (bare ref + non-engine target kind), so
// the heartbeat records lastValueText instead of the NUMBER-typed lastValue.
const isMirrorHeartbeat = (formula: FormulaDefinitionRecord): boolean => {
  try {
    return isMirrorDefinition(
      compileFormula(formula.expression ?? '').ast,
      formula.targetFieldType,
    );
  } catch {
    return false;
  }
};

export const recordEvaluationHeartbeat = async (
  client: FormulaClient,
  formula: FormulaDefinitionRecord,
  outcome: { value: number | null; error: string | null; rawValue?: unknown },
  expressionUsesToday: boolean,
): Promise<void> => {
  const nextError = outcome.error ?? '';
  const errorChanged = (formula.lastError ?? '') !== nextError;

  // Mirror formulas store their diagnostic value in lastValueText (lastValue is
  // NUMBER-typed and stays null). Write-avoidance intact: text unchanged AND
  // error unchanged -> zero writes. Mirrors never use TODAY(), so the ADR 0015
  // stale carve-out below does not apply to them.
  if (isMirrorHeartbeat(formula)) {
    const nextValueText = mirrorValueText(outcome.rawValue);
    const textChanged = (formula.lastValueText ?? null) !== nextValueText;
    if (!textChanged && !errorChanged) {
      return;
    }
    await updateFormulaBookkeeping(client, formula.id, {
      lastValueText: nextValueText,
      lastError: nextError,
      lastEvaluatedAt: new Date().toISOString(),
    });
    return;
  }

  const nextValue = outcome.value ?? null;
  const valueChanged = (formula.lastValue ?? null) !== nextValue;
  if (!valueChanged && !errorChanged) {
    if (expressionUsesToday) {
      const staleMs = 60 * 60 * 1000;
      // NaN from an unparseable timestamp must read as STALE, not fresh — a
      // `now - NaN > staleMs` comparison is always false, which would stall
      // the self-heal forever (same Number.isFinite guard as date-serial.ts).
      const lastEvaluatedAtMs = Date.parse(formula.lastEvaluatedAt ?? '');
      const isStale =
        !Number.isFinite(lastEvaluatedAtMs) ||
        Date.now() - lastEvaluatedAtMs > staleMs;
      if (isStale) {
        await updateFormulaBookkeeping(client, formula.id, {
          lastEvaluatedAt: new Date().toISOString(),
        });
      }
    }
    return;
  }
  await updateFormulaBookkeeping(client, formula.id, {
    lastValue: nextValue,
    lastError: nextError,
    lastEvaluatedAt: new Date().toISOString(),
  });
};
