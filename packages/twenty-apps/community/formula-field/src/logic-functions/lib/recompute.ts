import { compileFormula } from 'src/engine';
import { type FormulaDependencies } from 'src/engine/dependencies';
import { FormulaError, isFormulaError } from 'src/engine/errors';
import { evaluate, type VariableResolver } from 'src/engine/evaluator';
import { coerceToNumber, navigatePath } from 'src/logic-functions/lib/coercion';
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

const pluralize = (singular: string): string => {
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

// Builds the genql field selection for a set of root field names.
const fieldSelection = (fields: string[]): Record<string, boolean> => {
  const selection: Record<string, boolean> = { id: true };
  for (const field of fields) {
    selection[field] = true;
  }
  return selection;
};

// Fetches a single record of `object` by id, selecting the given root fields.
// Returns null if the record is not found.
const fetchRecord = async (
  client: FormulaClient,
  object: string,
  recordId: string,
  fields: string[],
): Promise<Record<string, unknown> | null> => {
  const response = await withRetry(() =>
    client.query({
      [object]: {
        __args: { filter: { id: { eq: recordId } } },
        ...fieldSelection(fields),
      },
    }),
  );
  return (response?.[object] as Record<string, unknown> | null) ?? null;
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
};

// Recomputes a single formula for a single target record. Idempotent and
// write-avoidant: skips the mutation when the value is unchanged (this is the
// recursion guard — our own write re-fires the trigger and converges here).
export const recomputeForRecord = async ({
  client,
  formula,
  targetRecordId,
  prefetchedRecord,
}: RecomputeArgs): Promise<RecomputeOutcome> => {
  const targetObject = formula.targetObject ?? '';
  const targetField = formula.targetField ?? '';
  const expression = formula.expression ?? '';

  const base: RecomputeOutcome = {
    formulaId: formula.id,
    targetRecordId,
    changed: false,
    value: null,
    error: null,
  };

  let dependencies: FormulaDependencies;
  let compiled: ReturnType<typeof compileFormula>;
  try {
    compiled = compileFormula(expression);
    dependencies = compiled.dependencies;
  } catch (error) {
    return {
      ...base,
      error: isFormulaError(error) ? error.message : String(error),
    };
  }

  // Ensure we have the same-record fields and the current value. If the caller
  // pre-fetched the record (event payload), use it; otherwise fetch exactly the
  // dependency fields plus the target field.
  let sameRecord = prefetchedRecord ?? null;
  const needsFetch =
    sameRecord === null ||
    dependencies.sameRecordFields.some((field) => !(field in sameRecord!)) ||
    !(targetField in sameRecord);

  if (needsFetch) {
    try {
      sameRecord = await fetchRecord(client, targetObject, targetRecordId, [
        ...dependencies.sameRecordFields,
        targetField,
      ]);
    } catch (error) {
      return {
        ...base,
        error: `Failed to load ${targetObject} ${targetRecordId}: ${
          (error as Error).message
        }`,
      };
    }
  }

  if (sameRecord === null) {
    return { ...base, error: `Record ${targetRecordId} not found` };
  }

  let crossRecords: Map<string, Record<string, unknown> | null>;
  try {
    crossRecords = await fetchCrossRecords(client, dependencies);
  } catch (error) {
    return {
      ...base,
      error: `Failed to load cross-record references: ${
        (error as Error).message
      }`,
    };
  }

  let result: number | null;
  try {
    result = evaluate(compiled.ast, buildResolver(sameRecord, crossRecords), {
      maxDepth: MAX_EVAL_DEPTH,
    });
  } catch (error) {
    return {
      ...base,
      error: isFormulaError(error)
        ? `${error.code}: ${error.message}`
        : String(error),
    };
  }

  const currentRaw = navigatePath(sameRecord, targetField);
  const currentValue =
    currentRaw === undefined || currentRaw === null
      ? null
      : (currentRaw as number);

  // No-op suppression / recursion guard: skip the write when nothing changed.
  if (valuesEqual(currentValue, result)) {
    return { ...base, value: result, changed: false };
  }

  const mutationName = `update${capitalize(targetObject)}`;
  try {
    await withRetry(() =>
      client.mutation({
        [mutationName]: {
          __args: { id: targetRecordId, data: { [targetField]: result } },
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
  const pluralName = pluralize(targetObject);
  const outcomes: RecomputeOutcome[] = [];

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
        await recomputeForRecord({ client, formula, targetRecordId: id }),
      );
    }

    if (!connection?.pageInfo?.hasNextPage) {
      break;
    }
    after = connection.pageInfo.endCursor ?? undefined;
  }

  return outcomes;
};

export const MAX_EVALUATION_DEPTH = MAX_EVAL_DEPTH;
export { FormulaError };
