import { graphqlEnum } from 'src/logic-functions/lib/dynamic-client';
import { workspaceCacheKey } from 'src/logic-functions/lib/metadata-objects';
import {
  type ComputedValue,
  type FormulaClient,
  type FormulaDefinitionRecord,
} from 'src/logic-functions/lib/types';
import { withRetry } from 'src/logic-functions/lib/with-retry';

// Data-access for FormulaDefinition records. Kept separate from the recompute
// engine so both can be tested against a fake client.

const FORMULA_FIELDS = {
  id: true,
  name: true,
  order: true,
  targetObject: true,
  targetField: true,
  targetFieldType: true,
  currencyCode: true,
  outputFormat: true,
  createdField: true,
  expression: true,
  enabled: true,
  allowOverride: true,
  lastValue: true,
  lastValueText: true,
  lastError: true,
  lastEvaluatedAt: true,
  status: true,
  statusReason: true,
  scanCursor: true,
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
            // Stable order so a time-bounded sweep resumes at a predictable
            // definition instead of starving whichever ones land late in an
            // unspecified ordering.
            orderBy: [{ id: graphqlEnum('AscNullsFirst') }],
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

// Same posture as metadata-objects.ts's catalog cache: computeSyncableFields
// re-scans EVERY enabled definition on every widget open and every
// variation-sync event. 60s staleness for the syncable-field set is the
// documented, deliberate trade-off there — mirror it, including the in-flight
// dedup so N cold-cache callers share one paginated fetch.
const SYNC_EXCLUSION_FORMULAS_TTL_MS = 60_000;

type SyncExclusionFormulasCacheEntry = {
  formulas: FormulaDefinitionRecord[];
  loadedAt: number;
};
const syncExclusionFormulasCacheByWorkspace = new Map<
  string,
  SyncExclusionFormulasCacheEntry
>();
const syncExclusionFormulasInFlightByWorkspace = new Map<
  string,
  Promise<FormulaDefinitionRecord[]>
>();

export const invalidateSyncExclusionFormulasCache = (): void => {
  syncExclusionFormulasCacheByWorkspace.delete(workspaceCacheKey());
};

export const __clearSyncExclusionFormulasCacheForTests = (): void => {
  syncExclusionFormulasCacheByWorkspace.clear();
  syncExclusionFormulasInFlightByWorkspace.clear();
};

export const loadSyncExclusionFormulasCached = async (
  client: FormulaClient,
): Promise<FormulaDefinitionRecord[]> => {
  const cacheKey = workspaceCacheKey();
  const cached = syncExclusionFormulasCacheByWorkspace.get(cacheKey);
  if (cached && Date.now() - cached.loadedAt < SYNC_EXCLUSION_FORMULAS_TTL_MS) {
    return cached.formulas;
  }

  const inFlight = syncExclusionFormulasInFlightByWorkspace.get(cacheKey);
  if (inFlight) {
    return inFlight;
  }

  const fetchPromise = (async () => {
    // Variation sync must ignore enabled-formula targets AND locked targets even
    // while the locked definition is disabled (§2.6 / ADR 0028): locked = fully
    // computed, no exceptions. Sync-exclusion is this cache's only consumer;
    // recompute paths use the uncached enabled-only loader.
    const filter = {
      or: [{ enabled: { eq: true } }, { allowOverride: { eq: false } }],
    };
    const pageSize = 200;

    const formulas: FormulaDefinitionRecord[] = [];
    let after: string | undefined;

    for (;;) {
      const response = await withRetry(() =>
        client.query({
          formulaDefinitions: {
            __args: {
              first: pageSize,
              filter,
              // Deterministic page order, so a cached set does not reshuffle
              // between refreshes.
              orderBy: [{ id: graphqlEnum('AscNullsFirst') }],
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

    // Cache only on success — a rejected pull leaves nothing behind, so the
    // next caller retries reality instead of a poisoned entry.
    syncExclusionFormulasCacheByWorkspace.set(cacheKey, {
      formulas,
      loadedAt: Date.now(),
    });
    return formulas;
  })();
  syncExclusionFormulasInFlightByWorkspace.set(cacheKey, fetchPromise);
  try {
    return await fetchPromise;
  } finally {
    syncExclusionFormulasInFlightByWorkspace.delete(cacheKey);
  }
};

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
// JSON-stringifies a non-numeric value (a mirror's raw value or an engine text
// result) for the lastValueText heartbeat, truncated to 500 chars
// (display/diagnostic only). A nullish value -> null text. The JSON encoding is
// the convention deployed mirror rows already store, so it must not change.
const MIRROR_VALUE_TEXT_MAX = 500;

// JSON-encodes a string so the ENVELOPE fits the budget, shrinking the slice
// until it does. The encoded length is not simply the raw length + 2 quotes —
// a quote, a backslash or a control character expands under escaping — so the
// slice is re-encoded rather than sized by a guessed safe ratio.
const encodeTextWithinBudget = (value: string): string => {
  let end = Math.min(value.length, MIRROR_VALUE_TEXT_MAX);
  let encoded = JSON.stringify(value.slice(0, end));
  while (encoded.length > MIRROR_VALUE_TEXT_MAX && end > 0) {
    // Rescale by the observed expansion ratio (a string of quotes doubles), and
    // always drop at least one character so the loop cannot stall.
    const rescaled = Math.floor((end * MIRROR_VALUE_TEXT_MAX) / encoded.length);
    end = Math.max(Math.min(rescaled, end - 1), 0);
    encoded = JSON.stringify(value.slice(0, end));
  }
  return encoded;
};

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
  if (serialized.length <= MIRROR_VALUE_TEXT_MAX) {
    return serialized;
  }
  // Over budget: truncate the VALUE and re-encode, never the encoded text.
  // Slicing the envelope cuts mid-string and stores unterminated JSON, which
  // every reader (displayHeartbeatValue) fails to parse — so a long text result
  // showed a permanent dash instead of a preview. A non-string value degrades to
  // a JSON string holding a preview of its encoding: this column is
  // display/diagnostic only, and a readable preview beats an unparseable blob.
  return encodeTextWithinBudget(
    typeof rawValue === 'string' ? rawValue : serialized,
  );
};

// Write-avoidance is handled by the caller (it only calls this when the cursor
// actually moves) — an unconditional write here would re-fire the definition
// trigger on every page.
export const updateScanCursor = async (
  client: FormulaClient,
  formulaId: string,
  cursor: string | null,
): Promise<void> => {
  await withRetry(() =>
    client.mutation({
      updateFormulaDefinition: {
        __args: { id: formulaId, data: { scanCursor: cursor ?? '' } },
        id: true,
      },
    }),
  );
};

// The record API round-trips a SQL-NULL TEXT column as '', while mirrorValueText
// produces null for a null value and never '' (every non-null value JSON-encodes
// to at least two characters). Comparing the two verbatim made a gated
// TEXT-target definition rewrite `lastValueText: null` on EVERY pass (F4) — one
// pure heartbeat write per sweep, forever. So '' can only mean "no stored text",
// and reads as null here, exactly as the lastError comparison normalizes the same
// ambiguity toward ''. The number lane needs none of this: a float column
// round-trips null as null.
const storedValueText = (value: string | null | undefined): string | null =>
  value === null || value === undefined || value === '' ? null : value;

// ADR 0015 staleness probe, shared by every heartbeat lane: a formula reading
// TODAY() can go a long time between VALUE changes, so a no-op outcome still has
// to refresh lastEvaluatedAt once per sweep cadence or "last evaluated" would
// read stale forever. Scoped to TODAY-using formulas so every other formula
// keeps finding M3's zero-write guarantee.
const HEARTBEAT_STALE_MS = 60 * 60 * 1000;
const heartbeatIsStale = (lastEvaluatedAt: string | null | undefined): boolean => {
  // NaN from an unparseable timestamp must read as STALE, not fresh — a
  // `now - NaN > staleMs` comparison is always false, which would stall the
  // self-heal forever (same Number.isFinite guard as date-serial.ts).
  const lastEvaluatedAtMs = Date.parse(lastEvaluatedAt ?? '');
  return (
    !Number.isFinite(lastEvaluatedAtMs) ||
    Date.now() - lastEvaluatedAtMs > HEARTBEAT_STALE_MS
  );
};

export const recordEvaluationHeartbeat = async (
  client: FormulaClient,
  formula: FormulaDefinitionRecord,
  outcome: { value: ComputedValue; error: string | null },
  expressionUsesToday: boolean,
): Promise<void> => {
  // Each write below syncs the passed record with EXACTLY the fields that write
  // carried. The comparisons here read that same in-memory record, and so does
  // formula-sweep straight after this returns — left stale, both see the
  // pre-write state and repeat a write that already landed. A blanket
  // four-field assignment would be worse than none: it would claim fields the
  // row never received.
  const nextError = outcome.error ?? '';
  const errorChanged = (formula.lastError ?? '') !== nextError;

  // Non-numeric outcomes — a mirror passthrough or an engine text result — store
  // their diagnostic value in lastValueText (lastValue is NUMBER-typed and stays
  // null). The outcome's own tag decides this; nothing re-parses the expression.
  // Write-avoidance intact: text unchanged AND error unchanged -> zero writes,
  // save for the ADR 0015 TODAY carve-out, which is lane-agnostic — a TEXT
  // formula reading TODAY() (IF(TODAY() > dueDate, "Overdue", "OK")) changes
  // value rarely and would otherwise read stale forever. A mirror is a bare ref,
  // so the flag is never set on the raw lane and its zero-write path stands.
  if (outcome.value.kind !== 'number') {
    const nextValueText = mirrorValueText(outcome.value.value);
    const textChanged = storedValueText(formula.lastValueText) !== nextValueText;
    if (!textChanged && !errorChanged) {
      if (expressionUsesToday && heartbeatIsStale(formula.lastEvaluatedAt)) {
        const evaluatedAt = new Date().toISOString();
        await updateFormulaBookkeeping(client, formula.id, {
          lastEvaluatedAt: evaluatedAt,
        });
        formula.lastEvaluatedAt = evaluatedAt;
      }
      return;
    }
    const evaluatedAt = new Date().toISOString();
    await updateFormulaBookkeeping(client, formula.id, {
      lastValueText: nextValueText,
      lastError: nextError,
      lastEvaluatedAt: evaluatedAt,
    });
    formula.lastValueText = nextValueText;
    formula.lastError = nextError;
    formula.lastEvaluatedAt = evaluatedAt;
    return;
  }

  const nextValue = outcome.value.value ?? null;
  const valueChanged = (formula.lastValue ?? null) !== nextValue;
  if (!valueChanged && !errorChanged) {
    if (expressionUsesToday && heartbeatIsStale(formula.lastEvaluatedAt)) {
      const evaluatedAt = new Date().toISOString();
      await updateFormulaBookkeeping(client, formula.id, {
        lastEvaluatedAt: evaluatedAt,
      });
      formula.lastEvaluatedAt = evaluatedAt;
    }
    return;
  }
  const evaluatedAt = new Date().toISOString();
  await updateFormulaBookkeeping(client, formula.id, {
    lastValue: nextValue,
    lastError: nextError,
    lastEvaluatedAt: evaluatedAt,
  });
  formula.lastValue = nextValue;
  formula.lastError = nextError;
  formula.lastEvaluatedAt = evaluatedAt;
};
