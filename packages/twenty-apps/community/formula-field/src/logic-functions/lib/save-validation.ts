import {
  detectCycle,
  type FormulaDependencies,
  type FormulaTarget,
} from 'src/engine';
import { type FormulaDefinitionRecord } from 'src/logic-functions/lib/types';
import {
  toValidationTarget,
  type ValidatableFormula,
  validateExpressionCore,
} from 'src/logic-functions/lib/validation-core';

// Validates a formula at save time (ADR 0005): parse the expression, extract its
// dependency index, and check that adding it to the existing set of formulas
// does not introduce a dependency cycle. Returns a discriminated result so the
// caller can persist dependencies + clear the error, or disable + record the
// error.

export type SaveValidationResult =
  | {
      valid: true;
      dependencies: FormulaDependencies;
    }
  | {
      valid: false;
      error: string;
      // Present when parsing succeeded but a cycle was found.
      dependencies?: FormulaDependencies;
    };

const toValidatable = (
  formula: Pick<
    FormulaDefinitionRecord,
    'targetObject' | 'targetField' | 'expression'
  >,
): ValidatableFormula => ({
  targetObject: formula.targetObject ?? '',
  targetField: formula.targetField ?? '',
  expression: formula.expression ?? '',
});

const toTarget = (
  formula: Pick<
    FormulaDefinitionRecord,
    'targetObject' | 'targetField' | 'expression'
  >,
): FormulaTarget | null => toValidationTarget(toValidatable(formula));

// Target object/field API names must be plain camelCase identifiers — the same
// shape the wizard's isValidFieldName enforces and the GraphQL serializer
// accepts. Validating here (finding M1) means a definition with a malformed or
// injection-shaped target name is rejected + disabled at save with a clear
// error, consistent with how a cycle is rejected, rather than reaching the
// dynamically built recompute query. (A shared helper here avoids importing from
// the front-components tree, which would invert the dependency direction.)
const SAFE_TARGET_NAME = /^[a-z][a-zA-Z0-9]*$/i;

export const isValidTargetName = (name: string): boolean =>
  SAFE_TARGET_NAME.test(name);

export type ValidateArgs = {
  candidate: Pick<
    FormulaDefinitionRecord,
    'id' | 'targetObject' | 'targetField' | 'targetFieldType' | 'expression'
  >;
  // All OTHER enabled formulas (the candidate is added on top).
  existingFormulas: FormulaDefinitionRecord[];
  // Sync accessor over caller-preloaded field-kind maps: objectName -> (field
  // name -> metadata type), or undefined when that object's kinds were not
  // preloaded. Feeds the string-comparison check (target object) and the mirror
  // source-kind check (which may be a cross-referenced object). Omitted, or a
  // gap in the map, degrades gracefully — the affected check is skipped, keeping
  // validation backward compatible.
  fieldKinds?: (objectName: string) => Map<string, string> | undefined;
};

// Runtime safety net (ADR 0004/0005): given the current set of enabled
// formulas, return the set of "object.field" targets that participate in a
// dependency cycle. The recompute paths skip these so a cyclic pair that slipped
// past save-time validation (e.g. created directly via the API) can never drive
// an infinite value ping-pong. Repeatedly removes formulas found in a cycle
// until the remaining graph is acyclic, collecting every implicated target.
export const findCyclicTargets = (
  formulas: FormulaDefinitionRecord[],
): Set<string> => {
  const cyclic = new Set<string>();
  let targets = formulas
    .map(toTarget)
    .filter((target): target is FormulaTarget => target !== null);

  for (;;) {
    const result = detectCycle(targets);
    if (!result.hasCycle) {
      break;
    }
    for (const node of result.cycle) {
      cyclic.add(node);
    }
    // Drop the implicated nodes and re-check for further disjoint cycles.
    targets = targets.filter(
      (target) => !cyclic.has(`${target.object}.${target.field}`),
    );
  }

  return cyclic;
};

export const isCyclicTarget = (
  cyclic: Set<string>,
  formula: FormulaDefinitionRecord,
): boolean =>
  cyclic.has(`${formula.targetObject ?? ''}.${formula.targetField ?? ''}`);

export const validateFormula = ({
  candidate,
  existingFormulas,
  fieldKinds,
}: ValidateArgs): SaveValidationResult => {
  const object = candidate.targetObject ?? '';
  const field = candidate.targetField ?? '';
  const expression = candidate.expression ?? '';
  const targetFieldType = candidate.targetFieldType;

  if (!object) {
    return { valid: false, error: 'targetObject is required' };
  }
  if (!field) {
    return { valid: false, error: 'targetField is required' };
  }
  if (!isValidTargetName(object)) {
    return {
      valid: false,
      error: `Invalid target object name "${object}" (must be a camelCase identifier)`,
    };
  }
  if (!isValidTargetName(field)) {
    return {
      valid: false,
      error: `Invalid target field name "${field}" (must be a camelCase identifier)`,
    };
  }
  // F2: a definition that names a target field but no field TYPE is unevaluable —
  // the write boundary reads a blank kind as NUMBER (targetFieldKind), so it can
  // only ever store a number into whatever kind the column actually is, and a
  // mismatch fails the record write on every pass. API-only shape (both wizard
  // paths always set it); rejected here rather than in the strict kind gate,
  // which must stay skip-never-reject for a blank kind (the mirror lane shares
  // that branch).
  if (!targetFieldType) {
    return { valid: false, error: 'targetFieldType is required' };
  }

  // Exclude any existing record with the same id (this IS the candidate) so an
  // update re-evaluates cleanly; the shared core takes the graph pre-filtered.
  const result = validateExpressionCore({
    expression,
    hostObject: object,
    targetField: field,
    targetFieldType: targetFieldType ?? undefined,
    fieldKinds,
    otherFormulas: existingFormulas
      .filter((formula) => formula.id !== candidate.id)
      .map(toValidatable),
  });

  if (result.valid) {
    return { valid: true, dependencies: result.dependencies };
  }
  // Dependencies survive a cycle rejection (parsing succeeded) but not a parse
  // or kind rejection — keep the key absent rather than undefined in that case.
  return result.dependencies === undefined
    ? { valid: false, error: result.error }
    : { valid: false, error: result.error, dependencies: result.dependencies };
};
