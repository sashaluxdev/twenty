import { compileFormula } from 'src/engine';
import { type FormulaDependencies, usesToday } from 'src/engine/dependencies';
import { FormulaError, isFormulaError } from 'src/engine/errors';
import {
  evaluate,
  type RawVariableResolver,
  type VariableResolver,
} from 'src/engine/evaluator';
import { coerceToNumber, navigatePath } from 'src/logic-functions/lib/coercion';
import { currentEpochDay } from 'src/logic-functions/lib/date-serial';
import { recordEvaluationHeartbeat } from 'src/logic-functions/lib/formula-repository';
import {
  buildTargetWriteData,
  isIntegerBackedFormat,
  normalizeComputedValue,
  normalizeStoredValue,
  selectionEntryForFieldKind,
} from 'src/logic-functions/lib/value-io';
import { loadOverriddenRecordIds } from 'src/logic-functions/lib/override-repository';
import {
  type FormulaClient,
  type FormulaDefinitionRecord,
  type RecomputeOutcome,
} from 'src/logic-functions/lib/types';
import { withRetry } from 'src/logic-functions/lib/with-retry';

// Runtime evaluation-depth ceiling — second line of defence behind save-time
// cycle detection (ADR 0004/0005).
const MAX_EVAL_DEPTH = 64;

const capitalize = (value: string): string =>
  value.charAt(0).toUpperCase() + value.slice(1);

// English pluralizer for the plural GraphQL query field (opportunity ->
// opportunities, company -> companies, person -> people). Twenty's standard
// objects follow these rules; a custom object with an irregular plural would
// need its plural passed explicitly (documented limitation).
const IRREGULAR_PLURALS: Record<string, string> = {
  person: 'people',
};

export const pluralize = (singular: string): string => {
  if (IRREGULAR_PLURALS[singular]) {
    return IRREGULAR_PLURALS[singular];
  }
  if (/[^aeiou]y$/.test(singular)) {
    return `${singular.slice(0, -1)}ies`;
  }
  if (/(s|x|z|ch|sh)$/.test(singular)) {
    return `${singular}es`;
  }
  return `${singular}s`;
};

const crossKey = (object: string, recordId: string): string =>
  `${object}:${recordId}`;

// Safe usesToday() over a possibly-invalid expression, for the heartbeat
// carve-out (ADR 0015). A formula that fails to parse has no TODAY()
// dependency to track — evaluation surfaces the parse error elsewhere.
const expressionUsesTodayOf = (formula: FormulaDefinitionRecord): boolean => {
  try {
    return usesToday(compileFormula(formula.expression ?? '').ast);
  } catch {
    return false;
  }
};

// Builds the genql field selection for a set of root field names.
const fieldSelection = (fields: string[]): Record<string, boolean> => {
  const selection: Record<string, boolean> = { id: true };
  for (const field of fields) {
    selection[field] = true;
  }
  return selection;
};

// Fetches a single record of `object` by id, selecting the given root fields.
// `selectionOverrides` replaces entries that need a sub-selection (composite
// fields like CURRENCY). Returns null if the record is not found.
const fetchRecord = async (
  client: FormulaClient,
  object: string,
  recordId: string,
  fields: string[],
  selectionOverrides?: Record<string, unknown>,
): Promise<Record<string, unknown> | null> => {
  const response = await withRetry(() =>
    client.query({
      [object]: {
        __args: { filter: { id: { eq: recordId } } },
        ...fieldSelection(fields),
        ...selectionOverrides,
      },
    }),
  );
  return (response?.[object] as Record<string, unknown> | null) ?? null;
};

// Field name -> FieldMetadataType for an object, via the client's optional
// metadata-backed resolver. Empty map (scalar selections) when unavailable.
const resolveFieldKinds = async (
  client: FormulaClient,
  objectName: string,
): Promise<Map<string, string>> =>
  client.fieldKinds ? await client.fieldKinds(objectName) : new Map();

// Sub-selection overrides for dependency fields whose kind is composite
// (CURRENCY). Without these the server SILENTLY returns null for a scalar
// selection on a composite field (no error!), so formulas with currency
// inputs null-propagated to nothing on activation.
const dependencySelectionOverrides = (
  fields: string[] | Set<string>,
  fieldKinds: Map<string, string>,
): Record<string, unknown> => {
  const overrides: Record<string, unknown> = {};
  for (const field of fields) {
    const entry = selectionEntryForFieldKind(fieldKinds.get(field));
    if (entry !== true) {
      overrides[field] = entry;
    }
  }
  return overrides;
};

// Fetches every cross-referenced record once (grouped by object + id) and
// returns a map from "object:recordId" to the record.
const fetchCrossRecords = async (
  client: FormulaClient,
  dependencies: FormulaDependencies,
): Promise<Map<string, Record<string, unknown> | null>> => {
  const byRecord = new Map<
    string,
    { object: string; recordId: string; fields: Set<string> }
  >();

  for (const ref of dependencies.crossRecordRefs) {
    const key = crossKey(ref.object, ref.recordId);
    const existing = byRecord.get(key);
    if (existing) {
      existing.fields.add(ref.field);
    } else {
      byRecord.set(key, {
        object: ref.object,
        recordId: ref.recordId,
        fields: new Set([ref.field]),
      });
    }
  }

  const results = new Map<string, Record<string, unknown> | null>();

  for (const { object, recordId, fields } of byRecord.values()) {
    const record = await fetchRecord(
      client,
      object,
      recordId,
      Array.from(fields),
      dependencySelectionOverrides(fields, await resolveFieldKinds(client, object)),
    );
    results.set(crossKey(object, recordId), record);
  }

  return results;
};

const buildResolver = (
  sameRecord: Record<string, unknown>,
  crossRecords: Map<string, Record<string, unknown> | null>,
): VariableResolver => {
  return (reference) => {
    if (reference.kind === 'same') {
      const raw = navigatePath(sameRecord, reference.path);
      if (raw === undefined) {
        return undefined;
      }
      return coerceToNumber(raw);
    }

    const record = crossRecords.get(
      crossKey(reference.ref.object, reference.ref.recordId),
    );
    if (record === undefined || record === null) {
      // Referenced record missing entirely -> treat as empty (null propagates)
      // rather than a hard error: the target record may legitimately have no
      // linked record yet.
      return null;
    }
    const raw = navigatePath(record, reference.ref.fieldPath);
    if (raw === undefined) {
      return undefined;
    }
    return coerceToNumber(raw);
  };
};

// Raw (untyped) resolver for string-mode = / != comparisons. Same navigation as
// buildResolver — same-record navigatePath, cross-record map lookup — but WITHOUT
// coerceToNumber: a value is kept only when it is actually a string, so a string
// comparison matches on the field's raw string (anything else -> null, which
// null-propagates the IF). A missing cross record -> null (silent-null parity).
const buildRawResolver = (
  sameRecord: Record<string, unknown>,
  crossRecords: Map<string, Record<string, unknown> | null>,
): RawVariableResolver => {
  return (reference) => {
    if (reference.kind === 'same') {
      const raw = navigatePath(sameRecord, reference.path);
      return typeof raw === 'string' ? raw : null;
    }

    const record = crossRecords.get(
      crossKey(reference.ref.object, reference.ref.recordId),
    );
    if (record === undefined || record === null) {
      return null;
    }
    const raw = navigatePath(record, reference.ref.fieldPath);
    return typeof raw === 'string' ? raw : null;
  };
};

const valuesEqual = (a: number | null, b: number | null): boolean => {
  if (a === null || b === null) {
    return a === b;
  }
  return a === b;
};

export type RecomputeArgs = {
  client: FormulaClient;
  formula: FormulaDefinitionRecord;
  targetRecordId: string;
  // Optional pre-fetched record (e.g. the event payload's `after`) to avoid a
  // round-trip for same-record dependencies and the current value.
  prefetchedRecord?: Record<string, unknown> | null;
  // Record ids the user has manually overridden for this formula's field —
  // recompute leaves those records alone (feature #2).
  overriddenRecordIds?: Set<string>;
};

// Evaluates a formula for a record WITHOUT writing. Returns the computed value
// (and the record it read, so callers can compare against the stored value).
// Shared by recomputeForRecord and by the manual-override detection, which needs
// to know "what would the formula say?" to tell an app recompute apart from a
// genuine human edit.
export type ComputeResult = {
  value: number | null;
  error: string | null;
  sameRecord: Record<string, unknown> | null;
};

export const computeFormulaValueForRecord = async ({
  client,
  formula,
  targetRecordId,
  prefetchedRecord,
}: Omit<RecomputeArgs, 'overriddenRecordIds'>): Promise<ComputeResult> => {
  const targetObject = formula.targetObject ?? '';
  const targetField = formula.targetField ?? '';
  const expression = formula.expression ?? '';

  let dependencies: FormulaDependencies;
  let compiled: ReturnType<typeof compileFormula>;
  try {
    compiled = compileFormula(expression);
    dependencies = compiled.dependencies;
  } catch (error) {
    return {
      value: null,
      sameRecord: null,
      error: isFormulaError(error) ? error.message : String(error),
    };
  }

  let sameRecord = prefetchedRecord ?? null;
  const needsFetch =
    sameRecord === null ||
    dependencies.sameRecordFields.some((field) => !(field in sameRecord!)) ||
    !(targetField in sameRecord);

  if (needsFetch) {
    try {
      const fieldKinds = await resolveFieldKinds(client, targetObject);
      sameRecord = await fetchRecord(
        client,
        targetObject,
        targetRecordId,
        dependencies.sameRecordFields,
        {
          ...dependencySelectionOverrides(
            dependencies.sameRecordFields,
            fieldKinds,
          ),
          [targetField]: selectionEntryForFieldKind(formula.targetFieldType),
        },
      );
    } catch (error) {
      return {
        value: null,
        sameRecord: null,
        error: `Failed to load ${targetObject} ${targetRecordId}: ${
          (error as Error).message
        }`,
      };
    }
  }

  if (sameRecord === null) {
    return {
      value: null,
      sameRecord: null,
      error: `Record ${targetRecordId} not found`,
    };
  }

  let crossRecords: Map<string, Record<string, unknown> | null>;
  try {
    crossRecords = await fetchCrossRecords(client, dependencies);
  } catch (error) {
    return {
      value: null,
      sameRecord,
      error: `Failed to load cross-record references: ${
        (error as Error).message
      }`,
    };
  }

  try {
    const value = evaluate(
      compiled.ast,
      buildResolver(sameRecord, crossRecords),
      {
        maxDepth: MAX_EVAL_DEPTH,
        todayEpochDay: currentEpochDay(),
        resolveRaw: buildRawResolver(sameRecord, crossRecords),
      },
    );
    return { value, sameRecord, error: null };
  } catch (error) {
    return {
      value: null,
      sameRecord,
      error: isFormulaError(error)
        ? `${error.code}: ${error.message}`
        : String(error),
    };
  }
};

// Recomputes a single formula for a single target record. Idempotent and
// write-avoidant: skips the mutation when the value is unchanged (this is the
// recursion guard — our own write re-fires the trigger and converges here).
export const recomputeForRecord = async ({
  client,
  formula,
  targetRecordId,
  prefetchedRecord,
  overriddenRecordIds,
}: RecomputeArgs): Promise<RecomputeOutcome> => {
  const targetObject = formula.targetObject ?? '';
  const targetField = formula.targetField ?? '';

  const base: RecomputeOutcome = {
    formulaId: formula.id,
    targetRecordId,
    changed: false,
    value: null,
    error: null,
  };

  // Manual override: this record is pinned by the user — do not recompute it.
  if (overriddenRecordIds?.has(targetRecordId)) {
    return { ...base, overridden: true };
  }

  const computed = await computeFormulaValueForRecord({
    client,
    formula,
    targetRecordId,
    prefetchedRecord,
  });
  if (computed.error !== null || computed.sameRecord === null) {
    return { ...base, error: computed.error ?? 'Record not found' };
  }
  // CURRENCY stores integer micros and integer-backed NUMBER fields store whole
  // numbers — compare and write the rounded value, or a fractional result would
  // never match the stored value and rewrite forever (finding M2).
  const result = normalizeComputedValue(formula.targetFieldType, computed.value, {
    integerBacked: isIntegerBackedFormat(formula.outputFormat),
  });
  const sameRecord = computed.sameRecord;

  const currentRaw = navigatePath(sameRecord, targetField);
  // Composite-aware read: for CURRENCY value fields the stored numeric value is
  // the amountMicros sub-field (micros end-to-end).
  const currentValue = normalizeStoredValue(currentRaw);

  // No-op suppression / recursion guard: skip the write when nothing changed.
  if (valuesEqual(currentValue, result)) {
    return { ...base, value: result, changed: false };
  }

  const mutationName = `update${capitalize(targetObject)}`;
  try {
    await withRetry(() =>
      client.mutation({
        [mutationName]: {
          __args: {
            id: targetRecordId,
            data: buildTargetWriteData(
              targetField,
              formula.targetFieldType,
              result,
              currentRaw,
              formula.currencyCode,
            ),
          },
          id: true,
        },
      }),
    );
  } catch (error) {
    return {
      ...base,
      value: result,
      error: `Failed to write ${targetField}: ${(error as Error).message}`,
    };
  }

  return { ...base, value: result, changed: true };
};

// Recomputes a formula across ALL records of its target object (paginated).
// Used by the cron sweep and by cross-object recompute, where a change to a
// referenced record affects the formula on every target record.
export const recomputeAllRecords = async (
  client: FormulaClient,
  formula: FormulaDefinitionRecord,
  pageSize = 100,
): Promise<RecomputeOutcome[]> => {
  const targetObject = formula.targetObject ?? '';
  const targetField = formula.targetField ?? '';
  const pluralName = pluralize(targetObject);
  const outcomes: RecomputeOutcome[] = [];

  // Load the overridden record ids once so pinned records are skipped (#2).
  const overriddenRecordIds = await loadOverriddenRecordIds(
    client,
    targetObject,
    targetField,
  );

  let after: string | undefined;

  for (;;) {
    const response = await withRetry(() =>
      client.query({
        [pluralName]: {
          __args: {
            first: pageSize,
            ...(after ? { after } : {}),
          },
          edges: { node: { id: true } },
          pageInfo: { hasNextPage: true, endCursor: true },
        },
      }),
    );

    const connection = response?.[pluralName];
    const edges: Array<{ node?: { id?: string } }> = connection?.edges ?? [];

    for (const edge of edges) {
      const id = edge?.node?.id;
      if (!id) {
        continue;
      }
      outcomes.push(
        await recomputeForRecord({
          client,
          formula,
          targetRecordId: id,
          overriddenRecordIds,
        }),
      );
    }

    if (!connection?.pageInfo?.hasNextPage) {
      break;
    }
    after = connection.pageInfo.endCursor ?? undefined;
  }

  // Heartbeat: record a representative value + timestamp on the definition so
  // "last value / last evaluated" is populated (an error takes precedence).
  if (outcomes.length > 0) {
    const firstError = outcomes.find((o) => o.error)?.error ?? null;
    const sampleValue =
      outcomes.find((o) => !o.error && o.value !== null)?.value ??
      outcomes.find((o) => !o.error)?.value ??
      null;
    await recordEvaluationHeartbeat(
      client,
      formula,
      {
        value: sampleValue,
        error: firstError,
      },
      expressionUsesTodayOf(formula),
    );
  }

  return outcomes;
};

export const MAX_EVALUATION_DEPTH = MAX_EVAL_DEPTH;
export { FormulaError };
