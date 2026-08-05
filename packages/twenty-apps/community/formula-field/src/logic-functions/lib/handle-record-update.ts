import { usesToday } from 'src/engine/dependencies';
import {
  loadAllEnabledFormulas,
  recordEvaluationHeartbeat,
} from 'src/logic-functions/lib/formula-repository';
import {
  type CompiledFormula,
  computeFormulaValueForRecord,
  computeMirrorValueForRecord,
  kindObjectsForFormula,
  recomputeAllRecords,
  recomputeForRecord,
  resolveKindsForObjects,
  safeCompileFormula,
} from 'src/logic-functions/lib/recompute';
import { deepJsonEqual } from 'src/logic-functions/lib/deep-equal';
import {
  isMirrorDefinition,
  isMirrorTargetKind,
} from 'src/logic-functions/lib/mirror-kinds';
import {
  decodeMirrorOverrideValue,
  findOverride,
  type OverrideRecord,
  overrideSlotForKind,
  upsertOverride,
} from 'src/logic-functions/lib/override-repository';
import {
  findCyclicTargets,
  isCyclicTarget,
} from 'src/logic-functions/lib/save-validation';
import {
  type FormulaClient,
  type RecomputeOutcome,
} from 'src/logic-functions/lib/types';
import { navigatePath } from 'src/logic-functions/lib/coercion';
import {
  isIntegerBackedFormat,
  normalizeComputedValue,
  normalizeStoredValue,
  tagEngineValue,
  type TargetFieldKind,
  targetFieldKind,
} from 'src/logic-functions/lib/value-io';
import { type EngineValue } from 'src/engine/evaluator';

// Shared body for every per-object database-event trigger. Given a record that
// changed on `objectName`, it recomputes:
//   1. formulas whose target IS this object and whose inputs on this record
//      actually changed (using the event payload's `after` — no refetch), and
//   2. formulas on ANY object that cross-reference this exact record on a field
//      that changed (recomputed across all their target records, because a
//      cross-record formula applies to every target row — ADR 0004).
//
// Consulting the dependency index means unrelated formulas are skipped, and a
// formula whose only changed field is its own value output (our previous write)
// is a no-op — the trigger-level half of the recursion guard.

// Equality between a written value and the formula's computed value: numbers
// compare float-tolerantly (a stored value has been through a round-trip), text
// and nulls compare strictly.
const storedValuesEqual = (a: EngineValue, b: EngineValue): boolean => {
  if (typeof a === 'number' && typeof b === 'number') {
    return Math.abs(a - b) < 1e-9;
  }
  return a === b;
};

// The value an ACTIVE override pins, read from the column its target kind
// actually uses. A TEXT target pins the JSON text slot (overrideValueText, the
// convention deployed TEXT mirrors already store) and leaves overrideValue null,
// so reading the numeric column would report every pinned text record as empty.
// A non-string decode (corrupted or legacy composite text) reports null rather
// than leaking a non-text value into a text-tagged outcome.
const pinnedOverrideValue = (
  targetKind: TargetFieldKind,
  override: OverrideRecord,
): EngineValue => {
  if (targetKind !== 'TEXT') {
    return override.overrideValue;
  }
  const decoded = decodeMirrorOverrideValue(override.overrideValueText).value;
  return typeof decoded === 'string' ? decoded : null;
};

// True if the update touched at least one field the formula reads on the same
// record. When updatedFields is unknown/empty we recompute to stay safe.
const sameRecordAffected = (
  dependencyFields: string[],
  updatedFields: string[] | undefined,
): boolean => {
  if (!updatedFields || updatedFields.length === 0) {
    return true;
  }
  return dependencyFields.some((field) => updatedFields.includes(field));
};

export type HandleRecordUpdateArgs = {
  client: FormulaClient;
  objectName: string;
  recordId: string;
  after: Record<string, unknown> | null | undefined;
  updatedFields: string[] | undefined;
  // Set when the write came from a real person (not the app). Used to detect a
  // manual, direct edit of a value field and turn it into an override (#2).
  actorWorkspaceMemberId?: string | null;
};

export const handleRecordUpdate = async ({
  client,
  objectName,
  recordId,
  after,
  updatedFields,
  actorWorkspaceMemberId,
}: HandleRecordUpdateArgs): Promise<RecomputeOutcome[]> => {
  const formulas = await loadAllEnabledFormulas(client);
  // Never recompute a formula caught in a dependency cycle — that is what would
  // ping-pong forever. Save-time validation disables these, but this is the
  // runtime backstop for cyclic formulas created directly via the API.
  const cyclic = findCyclicTargets(formulas);
  const outcomes: RecomputeOutcome[] = [];

  // One parse per DEFINITION for the whole event. Both loops below (override
  // detection and recompute) read the same program, and recomputeForRecord no
  // longer parses again inside. OFFLINE definitions are skipped by both loops,
  // so compiling them would be rent for nothing.
  const compiledByFormulaId = new Map<string, CompiledFormula>();
  for (const formula of formulas) {
    if (formula.status === 'OFFLINE') {
      continue;
    }
    const compiled = safeCompileFormula(formula.expression ?? '');
    if (compiled !== undefined) {
      compiledByFormulaId.set(formula.id, compiled);
    }
  }

  // One kind map for the whole event, eagerly built (spec D5: the lazy variant
  // optimizes a path that does not exist yet). Kinds are needed only by
  // engine-lane formulas TARGETING this object — a cross-impacted formula runs
  // a full pass, which resolves its own. The map is object-keyed, so the union
  // across formulas is a merge, never a leak between them.
  const eventKindObjects = new Set<string>();
  for (const formula of formulas) {
    if (formula.targetObject !== objectName) {
      continue;
    }
    const compiled = compiledByFormulaId.get(formula.id);
    if (compiled === undefined) {
      continue;
    }
    // The kind is checked first so the mirror test costs no AST walk for every
    // engine-family target (finding M1). A mirror resolves its source field's
    // kind inside computeMirrorValueForRecord and never reads this map.
    if (
      isMirrorTargetKind(formula.targetFieldType ?? '') &&
      isMirrorDefinition(compiled.ast, formula.targetFieldType)
    ) {
      continue;
    }
    for (const object of kindObjectsForFormula(formula, compiled)) {
      eventKindObjects.add(object);
    }
  }
  const eventFieldKindsByObject = await resolveKindsForObjects(
    client,
    eventKindObjects,
  );

  // Manual override detection (#2). A value field changed on this record. We
  // must tell a genuine human edit apart from the app's OWN recompute write —
  // and the actor alone is not enough, because a recompute triggered by a user's
  // input edit inherits that user's identity on its event. So we compare the
  // written value to what the formula actually computes: if they match, it's the
  // app's recompute (ignore); if they differ, a human pinned a manual value.
  if (actorWorkspaceMemberId && updatedFields && updatedFields.length > 0) {
    for (const field of updatedFields) {
      const formula = formulas.find(
        (candidate) =>
          candidate.targetObject === objectName &&
          candidate.targetField === field,
      );
      if (!formula) continue; // not a formula value field
      // OFFLINE: inputs are unfetchable, so "what would the formula say?" has
      // no answer — never turn edits into overrides while broken.
      if (formula.status === 'OFFLINE') continue;
      const compiled = compiledByFormulaId.get(formula.id);

      // Mirror fork: a mirror target stores non-numeric raw values, so the
      // funnel below cannot decide it. Same compare-value-not-actor rule as the
      // engine path, but with deep JSON equality on raw values.
      // A TEXT target no longer takes this fork (ADR 0026): it goes down the
      // funnel below, where normalizeStoredValue/storedValuesEqual compare
      // strings strictly and overrideSlotForKind pins the JSON text column.
      // The kind is checked first so the parse is skipped for every
      // engine-family target (finding M1).
      const formulaIsMirror =
        compiled !== undefined &&
        isMirrorTargetKind(formula.targetFieldType ?? '') &&
        isMirrorDefinition(compiled.ast, formula.targetFieldType);

      if (formulaIsMirror) {
        // The event value written on this field (its raw form; NOT
        // sub-selection-guaranteed, so used only as the event's own value).
        const eventRaw = after?.[field];

        // Fresh, kind-aware read (no prefetch — the event `after` is not
        // sub-selection-safe for composite mirror kinds): the source raw value
        // and the CURRENT stored target value.
        const mirror = await computeMirrorValueForRecord({
          client,
          formula,
          targetRecordId: recordId,
          compiled,
        });
        // Can't compute (record vanished / load error) -> never risk a false pin.
        if (mirror.error !== null || mirror.sameRecord === null) continue;

        const currentRaw = navigatePath(mirror.sameRecord, field);

        // Superseded write in flight: the stored value already moved past the
        // value this event reports -> a newer write is converging, skip the echo.
        if (!deepJsonEqual(currentRaw, eventRaw)) continue;

        // Current stored value equals the mirror source -> the app's own
        // passthrough write, not a human pin.
        if (deepJsonEqual(mirror.rawValue, currentRaw)) continue;

        // A human pinned a value that differs from the source: store its raw
        // value as JSON text (overrideValueText); overrideValue stays null.
        await upsertOverride(
          client,
          objectName,
          field,
          recordId,
          overrideSlotForKind('raw', currentRaw),
        );
        continue;
      }

      // Kind-aware: a CURRENCY value field arrives as
      // { amountMicros, currencyCode } — its numeric value is the micros.
      const targetKind = targetFieldKind(formula.targetFieldType);
      const eventValue = normalizeStoredValue(after?.[field], targetKind);

      // finding m1: read the record FRESH (no prefetch) so the decision uses the
      // CURRENT inputs and CURRENT stored value, not the possibly-stale event
      // snapshot. This closes the echo-race: the event that echoes the app's own
      // write can arrive after an input already moved on, and comparing the fresh
      // compute to the stale snapshot would fabricate a spurious override.
      const fresh = await computeFormulaValueForRecord({
        client,
        formula,
        targetRecordId: recordId,
        // Kind-directed resolution: without these a DATE input resolves as text
        // and `closeDate + 30` becomes a NON_NUMERIC_VALUE error, which would
        // read as "cannot compute" and silently suppress every override
        // decision on date formulas. Shared with the recompute loop below —
        // resolved once for the whole event.
        fieldKindsByObject: eventFieldKindsByObject,
        compiled,
      });
      // Can't compute (record vanished / load error) -> never risk a false pin.
      if (fresh.error !== null || fresh.sameRecord === null) continue;

      const currentStored = normalizeStoredValue(
        navigatePath(fresh.sameRecord, field),
        targetKind,
      );

      // Superseded write in flight: the stored value already moved past the
      // value this event reports, so a newer write is converging — treating the
      // stale echo as a human pin would be wrong. Skip it.
      if (!storedValuesEqual(currentStored, eventValue)) continue;

      // The same write-boundary normalization recompute applies, so the compare
      // happens in the field's own representation. A value the target cannot
      // hold (text onto a numeric field) throws here — "can't compute -> never
      // risk a false pin" covers that case too.
      let computedStored: EngineValue;
      try {
        computedStored = normalizeComputedValue(
          formula.targetFieldType,
          fresh.value,
          { integerBacked: isIntegerBackedFormat(formula.outputFormat) },
        );
      } catch {
        continue;
      }

      // The current stored value matches the formula on CURRENT inputs -> it is
      // the app's own recompute, not a human pin.
      if (storedValuesEqual(computedStored, currentStored)) continue;

      await upsertOverride(
        client,
        objectName,
        field,
        recordId,
        overrideSlotForKind(targetKind, currentStored),
      );
    }
  }

  for (const formula of formulas) {
    if (isCyclicTarget(cyclic, formula)) {
      continue;
    }

    // OFFLINE: an input field is deactivated/missing — recompute would only
    // error against unfetchable inputs. UPSTREAM formulas keep computing.
    if (formula.status === 'OFFLINE') {
      continue;
    }

    const compiled = compiledByFormulaId.get(formula.id);
    if (compiled === undefined) {
      continue;
    }
    const dependencies = compiled.dependencies;

    // Case 1: this object's own record changed and it feeds this formula.
    if (
      formula.targetObject === objectName &&
      sameRecordAffected(dependencies.sameRecordFields, updatedFields)
    ) {
      // Mirror formulas do their own kind-aware fetch inside
      // computeMirrorValueForRecord — the event `after` is NOT
      // sub-selection-guaranteed for composite mirror kinds, so it must not be
      // trusted as a prefetch (FM Task 2 carry-forward). The engine path keeps
      // trusting `after` (byte-identical behavior), and TEXT joins it there: a
      // TEXT column is a plain scalar in the payload, so the distinction
      // dissolves and a deployed TEXT mirror now costs one fewer refetch.
      const isMirror = isMirrorDefinition(compiled.ast, formula.targetFieldType);

      // Respect an ACTIVE manual override on this specific record (#2).
      const override = await findOverride(
        client,
        formula.targetObject ?? '',
        formula.targetField ?? '',
        recordId,
      );
      if (override?.active) {
        const pinnedKind = targetFieldKind(formula.targetFieldType);
        outcomes.push({
          formulaId: formula.id,
          targetRecordId: recordId,
          changed: false,
          // A mirror pins its value in the text column, so the numeric column
          // this outcome reports is null for that lane — tagged 'raw' rather
          // than mistagged as a number.
          value: isMirror
            ? { kind: 'raw', value: null }
            : tagEngineValue(
                pinnedKind,
                pinnedOverrideValue(pinnedKind, override),
              ),
          error: null,
          overridden: true,
        });
        continue;
      }
      const outcome = await recomputeForRecord({
        client,
        formula,
        targetRecordId: recordId,
        prefetchedRecord: isMirror ? undefined : after ?? undefined,
        // The event path prefetches, so nothing else on it would resolve kinds:
        // without them a DATE input on this record reads as text. Object-keyed
        // and resolved once for the whole event, above.
        fieldKindsByObject: eventFieldKindsByObject,
        compiled,
      });
      outcomes.push(outcome);
      await recordEvaluationHeartbeat(
        client,
        formula,
        { value: outcome.value, error: outcome.error },
        usesToday(compiled.ast),
      );
      continue;
    }

    // Case 2: a record this formula cross-references changed on a field it reads.
    const crossImpacted = dependencies.crossRecordRefs.some(
      (ref) =>
        ref.object === objectName &&
        ref.recordId === recordId &&
        (!updatedFields ||
          updatedFields.length === 0 ||
          updatedFields.includes(ref.field)),
    );

    if (crossImpacted) {
      outcomes.push(...(await recomputeAllRecords(client, formula)));
    }
  }

  return outcomes;
};
