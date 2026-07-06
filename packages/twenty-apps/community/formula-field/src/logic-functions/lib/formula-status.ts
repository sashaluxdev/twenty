import { compileFormula } from 'src/engine';
import {
  loadAllEnabledFormulas,
  loadTrashedFormulas,
  type TrashedFormulaRecord,
  updateFormulaBookkeeping,
} from 'src/logic-functions/lib/formula-repository';
import { loadAllObjectsWithFields } from 'src/logic-functions/lib/metadata-objects';
import {
  loadObjectFieldIndex,
  syncCompanionStatusField,
} from 'src/logic-functions/lib/fx-status-field';
import {
  type FormulaClient,
  type FormulaDefinitionRecord,
} from 'src/logic-functions/lib/types';

// Operational status machinery ("holy" formula columns): when a formula's
// input field is deactivated or missing, the formula goes OFFLINE (recompute
// stops — its inputs are physically unfetchable). Formulas further down the
// chain (they read an OFFLINE/UPSTREAM formula's still-active target field)
// get UPSTREAM: they keep computing on stale inputs, but are clearly flagged
// as not working as designed. Statuses are recomputed from scratch as a pure
// function of the dependency graph + field liveness, so delete/restore
// sequences converge regardless of event ordering.

export type FormulaOperationalStatus = '' | 'OFFLINE' | 'UPSTREAM';

export type ComputedStatus = {
  status: FormulaOperationalStatus;
  reason: string;
};

// True when the field exists and is active on the object.
export type FieldLiveness = (object: string, field: string) => boolean;

const MAX_REASON_LENGTH = 400;

const fieldKey = (object: string, field: string): string =>
  `${object}.${field}`;

const dependencyRefs = (
  definition: FormulaDefinitionRecord,
): Array<{ object: string; field: string }> => {
  try {
    const dependencies = compileFormula(
      definition.expression ?? '',
    ).dependencies;
    return [
      ...dependencies.sameRecordFields.map((field) => ({
        object: definition.targetObject ?? '',
        field,
      })),
      ...dependencies.crossRecordRefs.map((ref) => ({
        object: ref.object,
        field: ref.field,
      })),
    ];
  } catch {
    // Unparseable expression contributes no dependency edges (validation
    // already disables it and records the parse error).
    return [];
  }
};

// Trashed-target liveness (ADR 0009 refinement): a field is "trash-dead" iff a
// trashed definition CREATED it (createdField: true) AND no live definition
// still targets the same object+field. Naive-trashing a definition no longer
// deactivates its wizard-created field, so this is what keeps a dependent of a
// trashed formula OFFLINE — it is subtracted from the live-field set, routing
// the dependent through the existing dead-input path (same reason wording).
//
// The "still shared" check is derived from the already-loaded live formulas
// list (no extra query, no third copy of anotherDefinitionTargets).
export const buildTrashDeadFieldKeys = (
  trashed: ReadonlyArray<
    Pick<TrashedFormulaRecord, 'targetObject' | 'targetField' | 'createdField'>
  >,
  liveDefinitions: ReadonlyArray<
    Pick<FormulaDefinitionRecord, 'targetObject' | 'targetField'>
  >,
): Set<string> => {
  const liveTargets = new Set<string>();
  for (const definition of liveDefinitions) {
    if (definition.targetObject && definition.targetField) {
      liveTargets.add(fieldKey(definition.targetObject, definition.targetField));
    }
  }

  const trashDead = new Set<string>();
  for (const definition of trashed) {
    if (
      definition.createdField !== true ||
      !definition.targetObject ||
      !definition.targetField
    ) {
      continue;
    }
    const key = fieldKey(definition.targetObject, definition.targetField);
    if (!liveTargets.has(key)) {
      trashDead.add(key);
    }
  }
  return trashDead;
};

export const computeFormulaStatuses = (
  definitions: FormulaDefinitionRecord[],
  isFieldLive: FieldLiveness,
): Map<string, ComputedStatus> => {
  const result = new Map<string, ComputedStatus>();
  const byTarget = new Map<string, FormulaDefinitionRecord>();
  const dependencies = new Map<
    string,
    Array<{ object: string; field: string }>
  >();

  for (const definition of definitions) {
    if (definition.targetObject && definition.targetField) {
      byTarget.set(
        fieldKey(definition.targetObject, definition.targetField),
        definition,
      );
    }
    dependencies.set(definition.id, dependencyRefs(definition));
  }

  // Pass 1: OFFLINE — an input field is deactivated or missing.
  for (const definition of definitions) {
    const dead = (dependencies.get(definition.id) ?? []).filter(
      (ref) => !isFieldLive(ref.object, ref.field),
    );
    result.set(
      definition.id,
      dead.length > 0
        ? {
            status: 'OFFLINE',
            reason: `input ${dead
              .map((ref) => fieldKey(ref.object, ref.field))
              .join(', ')} is deactivated or missing`,
          }
        : { status: '', reason: '' },
    );
  }

  // Pass 2: UPSTREAM — fixpoint: reads the target field of a broken formula.
  // The loop is bounded by the definition count; cycles cannot spin because a
  // node's status only ever moves '' -> UPSTREAM once.
  for (;;) {
    let changed = false;
    for (const definition of definitions) {
      if (result.get(definition.id)?.status !== '') continue;
      for (const ref of dependencies.get(definition.id) ?? []) {
        const upstream = byTarget.get(fieldKey(ref.object, ref.field));
        if (!upstream || upstream.id === definition.id) continue;
        const upstreamStatus = result.get(upstream.id);
        if (upstreamStatus && upstreamStatus.status !== '') {
          const upstreamName =
            upstream.name || fieldKey(ref.object, ref.field);
          result.set(definition.id, {
            status: 'UPSTREAM',
            reason: `reads ${fieldKey(ref.object, ref.field)}, computed by "${upstreamName}" which is ${upstreamStatus.status} (${upstreamStatus.reason})`.slice(
              0,
              MAX_REASON_LENGTH,
            ),
          });
          changed = true;
          break;
        }
      }
    }
    if (!changed) break;
  }

  return result;
};

// Loads field liveness from the metadata API (fresh — status refreshes are
// rare and must see a just-deactivated field). On metadata failure everything
// is assumed live: no false OFFLINE alarms from a transient hiccup.
export const loadFieldLiveness = async (): Promise<FieldLiveness> => {
  try {
    const objects = await loadAllObjectsWithFields();
    const live = new Set<string>();
    for (const object of objects) {
      for (const field of object.fields) {
        if (field.isActive) {
          live.add(fieldKey(object.nameSingular, field.name));
        }
      }
    }
    return (object, field) => live.has(fieldKey(object, field));
  } catch {
    return () => true;
  }
};

// Recomputes and persists every enabled formula's operational status, and
// syncs the per-record FX Status companion fields. Write-avoidant; safe to
// call after any lifecycle event (delete/restore/save) and from the sweep.
export const refreshFormulaStatuses = async (
  client: FormulaClient,
  isFieldLive?: FieldLiveness,
): Promise<{
  offline: number;
  upstream: number;
  byId: Map<string, ComputedStatus>;
}> => {
  const definitions = await loadAllEnabledFormulas(client);
  // Trashed definitions whose created field no live definition still targets
  // make that field dead (its column persists but the formula that fed it is
  // gone), so dependents go OFFLINE. Loaded once and folded into liveness.
  const trashed = await loadTrashedFormulas(client);
  const trashDeadKeys = buildTrashDeadFieldKeys(trashed, definitions);
  const baseLiveness = isFieldLive ?? (await loadFieldLiveness());
  const liveness: FieldLiveness = (object, field) =>
    baseLiveness(object, field) && !trashDeadKeys.has(fieldKey(object, field));
  const statuses = computeFormulaStatuses(definitions, liveness);
  const objectFieldIndex = await loadObjectFieldIndex();

  let offline = 0;
  let upstream = 0;

  for (const definition of definitions) {
    const next = statuses.get(definition.id) ?? {
      status: '' as const,
      reason: '',
    };
    if (next.status === 'OFFLINE') offline += 1;
    if (next.status === 'UPSTREAM') upstream += 1;

    const changed =
      (definition.status ?? '') !== next.status ||
      (definition.statusReason ?? '') !== next.reason;
    if (changed) {
      await updateFormulaBookkeeping(client, definition.id, {
        status: next.status,
        statusReason: next.reason,
      });
    }

    // Companion sync runs on every refresh (not only transitions) so records
    // created while a formula was broken converge too; it is write-avoidant.
    await syncCompanionStatusField(
      client,
      definition.targetObject
        ? objectFieldIndex.get(definition.targetObject)
        : undefined,
      definition,
      next.status,
    );
  }

  return { offline, upstream, byId: statuses };
};
