import {
  type BareReference,
  bareReferenceOf,
  compileFormula,
  DEFAULT_MAX_DEPTH,
} from 'src/engine';
import { type FormulaDependencies, usesToday } from 'src/engine/dependencies';
import { FormulaError, isFormulaError } from 'src/engine/errors';
import { deepJsonEqual } from 'src/logic-functions/lib/deep-equal';
import {
  isMirrorDefinition,
  selectionEntryForMirrorKind,
} from 'src/logic-functions/lib/mirror-kinds';
import {
  buildScanSelection,
  scanNodeSelection,
  type ScanSelection,
} from 'src/logic-functions/lib/scan-selection';
import {
  evaluate,
  type RawVariableResolver,
  type VariableResolver,
} from 'src/engine/evaluator';
import { coerceToNumber, navigatePath } from 'src/logic-functions/lib/coercion';
import { currentEpochDay } from 'src/logic-functions/lib/date-serial';
import { graphqlEnum } from 'src/logic-functions/lib/dynamic-client';
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
export const fieldSelection = (fields: string[]): Record<string, boolean> => {
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
export const resolveFieldKinds = async (
  client: FormulaClient,
  objectName: string,
): Promise<Map<string, string>> =>
  client.fieldKinds ? await client.fieldKinds(objectName) : new Map();

// Sub-selection overrides for dependency fields whose kind is composite
// (CURRENCY). Without these the server SILENTLY returns null for a scalar
// selection on a composite field (no error!), so formulas with currency
// inputs null-propagated to nothing on activation.
export const dependencySelectionOverrides = (
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
        // Runtime evaluation-depth ceiling — second line of defence behind
        // save-time cycle detection (ADR 0004/0005). Sourced from the engine's
        // own DEFAULT_MAX_DEPTH so the production ceiling can never drift from
        // the value the evaluator documents.
        maxDepth: DEFAULT_MAX_DEPTH,
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

// Mirror-mode compute (design 2026-07-06): resolves the definition's single bare
// whole-field ref to the source field's RAW value (scalar/array/composite),
// bypassing the engine's numeric domain entirely. Also returns the target record
// (`sameRecord`) so the caller can read the current target value for the no-op
// check from the same fetch. Shared by recompute and by FM Task 3's mirror
// override detection.
export type ComputeMirrorResult = {
  rawValue: unknown;
  error: string | null;
  sameRecord: Record<string, unknown> | null;
};

export const computeMirrorValueForRecord = async ({
  client,
  formula,
  targetRecordId,
  prefetchedRecord,
}: Omit<RecomputeArgs, 'overriddenRecordIds'>): Promise<ComputeMirrorResult> => {
  const targetObject = formula.targetObject ?? '';
  const targetField = formula.targetField ?? '';
  const targetKind = formula.targetFieldType ?? '';

  let bare: BareReference | null;
  try {
    bare = bareReferenceOf(compileFormula(formula.expression ?? '').ast);
  } catch (error) {
    return {
      rawValue: null,
      sameRecord: null,
      error: isFormulaError(error) ? error.message : String(error),
    };
  }
  if (bare === null) {
    return {
      rawValue: null,
      sameRecord: null,
      error: 'Mirror expression is not a bare field reference',
    };
  }

  const sourceObject = bare.kind === 'same' ? targetObject : bare.ref.object;
  const sourceField = bare.kind === 'same' ? bare.field : bare.ref.fieldPath;

  // Resolve the source field's kind to pick its composite sub-selection. An
  // unresolvable kind fails VISIBLY (null + error naming the field) rather than
  // silently selecting a composite as a scalar — which the server answers with a
  // null (no error), the currency-input trap this feature must not reintroduce.
  const sourceKind = (await resolveFieldKinds(client, sourceObject)).get(
    sourceField,
  );
  if (sourceKind === undefined) {
    return {
      rawValue: null,
      sameRecord: null,
      error: `Cannot resolve field kind for ${sourceObject}.${sourceField}`,
    };
  }

  // The target record always carries the current target value (for the no-op
  // check); a SAME-record mirror's source lives on it too, so select both.
  const targetSelectionFields =
    bare.kind === 'same' ? [sourceField, targetField] : [targetField];
  const targetOverrides: Record<string, unknown> = {
    [targetField]: selectionEntryForMirrorKind(targetKind),
  };
  if (bare.kind === 'same') {
    targetOverrides[sourceField] = selectionEntryForMirrorKind(sourceKind);
  }

  let sameRecord = prefetchedRecord ?? null;
  const needsFetch =
    sameRecord === null ||
    targetSelectionFields.some((field) => !(field in sameRecord!));
  if (needsFetch) {
    try {
      sameRecord = await fetchRecord(
        client,
        targetObject,
        targetRecordId,
        targetSelectionFields,
        targetOverrides,
      );
    } catch (error) {
      return {
        rawValue: null,
        sameRecord: null,
        error: `Failed to load ${targetObject} ${targetRecordId}: ${
          (error as Error).message
        }`,
      };
    }
  }
  if (sameRecord === null) {
    return {
      rawValue: null,
      sameRecord: null,
      error: `Record ${targetRecordId} not found`,
    };
  }

  // Same-record mirror: the source value is on the target record itself.
  if (bare.kind === 'same') {
    return {
      rawValue: navigatePath(sameRecord, sourceField) ?? null,
      sameRecord,
      error: null,
    };
  }

  // Cross-record mirror: fetch the referenced source record. A missing source
  // record mirrors the engine's silent-null parity — write null, no error.
  let sourceRecord: Record<string, unknown> | null;
  try {
    sourceRecord = await fetchRecord(
      client,
      sourceObject,
      bare.ref.recordId,
      [sourceField],
      { [sourceField]: selectionEntryForMirrorKind(sourceKind) },
    );
  } catch (error) {
    return {
      rawValue: null,
      sameRecord,
      error: `Failed to load ${sourceObject} ${bare.ref.recordId}: ${
        (error as Error).message
      }`,
    };
  }
  if (sourceRecord === null) {
    return { rawValue: null, sameRecord, error: null };
  }
  return {
    rawValue: navigatePath(sourceRecord, sourceField) ?? null,
    sameRecord,
    error: null,
  };
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

  // Mirror mode: a bare whole-field ref onto a non-engine target kind performs a
  // typed RAW passthrough — write the source value verbatim, bypassing
  // normalizeComputedValue / normalizeStoredValue / buildTargetWriteData
  // entirely. Engine-family formulas fall through to the unchanged path below.
  let isMirror = false;
  try {
    isMirror = isMirrorDefinition(
      compileFormula(formula.expression ?? '').ast,
      formula.targetFieldType,
    );
  } catch {
    // Unparseable expression is not a mirror; the engine path surfaces the error.
    isMirror = false;
  }

  if (isMirror) {
    const mirror = await computeMirrorValueForRecord({
      client,
      formula,
      targetRecordId,
      prefetchedRecord,
    });
    if (mirror.error !== null || mirror.sameRecord === null) {
      return { ...base, error: mirror.error ?? 'Record not found' };
    }

    const currentRaw = navigatePath(mirror.sameRecord, targetField);
    // No-op suppression / recursion guard: deep JSON equality of the current
    // target value and the source value skips the write.
    if (deepJsonEqual(currentRaw, mirror.rawValue)) {
      return { ...base, changed: false, rawValue: mirror.rawValue };
    }

    const mirrorMutationName = `update${capitalize(targetObject)}`;
    try {
      await withRetry(() =>
        client.mutation({
          [mirrorMutationName]: {
            __args: {
              id: targetRecordId,
              data: { [targetField]: mirror.rawValue },
            },
            id: true,
          },
        }),
      );
    } catch (error) {
      return {
        ...base,
        rawValue: mirror.rawValue,
        error: `Failed to write ${targetField}: ${(error as Error).message}`,
      };
    }

    return { ...base, changed: true, rawValue: mirror.rawValue };
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

export type RecomputeAllRecordsOptions = {
  // Page size for the cursor-paginated record scan. NOT in the original ADR
  // 0023 plan — folded in here because this positional param already existed
  // and is exercised by pagination.spec.ts; production callers rely on the
  // default.
  pageSize?: number;
  // Polled between records; return false to stop the sweep early (e.g. the
  // initiating widget unmounted). Already-processed records keep their
  // writes — the sweep is idempotent, the cron sweep finishes the rest.
  shouldContinue?: () => boolean;
};

// Recomputes a formula across ALL records of its target object (paginated).
// Used by the cron sweep and by cross-object recompute, where a change to a
// referenced record affects the formula on every target record. Also used by
// refreshStaleTodayFormulas' definition-page sweep, which passes
// shouldContinue so the sweep stops at the next record boundary after the
// initiating widget unmounts (ADR 0023) instead of running to completion
// orphaned.
export const recomputeAllRecords = async (
  client: FormulaClient,
  formula: FormulaDefinitionRecord,
  options: RecomputeAllRecordsOptions = {},
): Promise<RecomputeOutcome[]> => {
  const pageSize = options.pageSize ?? 100;
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

  // Page nodes carry the dependency + target fields so recomputeForRecord's
  // prefetch check skips its per-record read. Null -> id-only scan.
  let scanSelection: ScanSelection | null = null;
  try {
    scanSelection = await buildScanSelection(client, formula);
  } catch {
    // Building the selection needs a metadata read. Before the prefetch that
    // read happened per record and a failure became one error outcome; hoisted
    // here it would abort the pass and every remaining formula in the sweep.
    // Degrade to the id-only scan, which restores that per-record isolation.
    scanSelection = null;
  }

  const queryPage = async (
    cursor: string | undefined,
  ): Promise<Record<string, unknown> | null> => {
    const pageArgs = {
      first: pageSize,
      // Stable scan order (ADR 0022): the heartbeat's representative lastValue
      // is "first non-error, non-null outcome" of this scan. Unordered
      // pagination made that sample flip between records run-to-run, defeating
      // the write-avoidance guard and churning formulaDefinition.updated rows.
      orderBy: [{ id: graphqlEnum('AscNullsFirst') }],
      ...(cursor ? { after: cursor } : {}),
    };
    const build = (nodeSelection: Record<string, unknown>) => ({
      [pluralName]: {
        __args: pageArgs,
        edges: { node: nodeSelection },
        pageInfo: { hasNextPage: true, endCursor: true },
      },
    });

    const widened = scanSelection;
    if (widened !== null) {
      try {
        return await withRetry(() =>
          client.query(build(scanNodeSelection(widened))),
        );
      } catch {
        // A field the live schema dropped would abort the entire pass here and
        // take every remaining formula in the sweep with it. Degrade to the
        // id-only scan and let per-record fetches surface the error one record
        // at a time (the isolation the widened selection would otherwise cost).
        scanSelection = null;
      }
    }
    return withRetry(() => client.query(build({ id: true })));
  };

  let after: string | undefined;

  for (;;) {
    if (options.shouldContinue && !options.shouldContinue()) {
      break;
    }
    const response = await queryPage(after);

    const connection = response?.[pluralName] as
      | {
          edges?: Array<{ node?: Record<string, unknown> }>;
          pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
        }
      | undefined;
    const edges = connection?.edges ?? [];

    for (const edge of edges) {
      if (options.shouldContinue && !options.shouldContinue()) {
        break;
      }
      const node = edge?.node;
      const id = typeof node?.id === 'string' ? node.id : undefined;
      if (!id) {
        continue;
      }
      try {
        outcomes.push(
          await recomputeForRecord({
            client,
            formula,
            targetRecordId: id,
            // Only a widened page yields a usable prefetch. After a fallback,
            // nodes are id-only and the per-record fetch must run.
            prefetchedRecord: scanSelection !== null ? node : undefined,
            overriddenRecordIds,
          }),
        );
      } catch (error) {
        // Per-record fault isolation: a thrown error (a RangeError from a
        // pathologically deep value included) becomes this record's outcome and
        // the sweep continues, rather than one poisoned record aborting the whole
        // pass. The heartbeat below still runs with the accumulated outcomes.
        outcomes.push({
          formulaId: formula.id,
          targetRecordId: id,
          changed: false,
          value: null,
          error: String(error),
        });
      }
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
    // Mirror heartbeat: sample a representative raw value (the heartbeat itself
    // detects mirror-ness and derives lastValueText). Undefined for engine
    // formulas, which the heartbeat ignores in favour of `value`.
    const sampleRawValue =
      outcomes.find(
        (o) => !o.error && o.rawValue !== null && o.rawValue !== undefined,
      )?.rawValue ?? null;
    await recordEvaluationHeartbeat(
      client,
      formula,
      {
        value: sampleValue,
        error: firstError,
        rawValue: sampleRawValue,
      },
      expressionUsesTodayOf(formula),
    );
  }

  return outcomes;
};

export { FormulaError };
