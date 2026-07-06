import {
  type AstNode,
  collectStringComparisonRefs,
  detectCycle,
  extractDependenciesFromAst,
  type FormulaDependencies,
  type FormulaTarget,
  isFormulaError,
  parse,
} from 'src/engine';
import { type FormulaDefinitionRecord } from 'src/logic-functions/lib/types';

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

const toTarget = (
  formula: Pick<
    FormulaDefinitionRecord,
    'targetObject' | 'targetField' | 'expression'
  >,
): FormulaTarget | null => {
  const object = formula.targetObject ?? '';
  const field = formula.targetField ?? '';
  const expression = formula.expression ?? '';
  if (!object || !field) {
    return null;
  }
  try {
    return {
      object,
      field,
      dependencies: extractDependenciesFromAst(parse(expression)),
    };
  } catch {
    // A sibling formula that itself fails to parse contributes no edges.
    return null;
  }
};

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
    'id' | 'targetObject' | 'targetField' | 'expression'
  >;
  // All OTHER enabled formulas (the candidate is added on top).
  existingFormulas: FormulaDefinitionRecord[];
  // Field name -> metadata type (e.g. 'SELECT') for the candidate's target
  // object. When present, a string comparison against a same-record field whose
  // kind cannot hold a string is rejected. Omitted (or a field absent from the
  // map) -> that check is skipped, so validation is fully backward compatible.
  targetObjectFieldKinds?: Map<string, string>;
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
  targetObjectFieldKinds,
}: ValidateArgs): SaveValidationResult => {
  const object = candidate.targetObject ?? '';
  const field = candidate.targetField ?? '';
  const expression = candidate.expression ?? '';

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

  // 1. Parse + dependency extraction.
  let ast: AstNode;
  let dependencies: FormulaDependencies;
  try {
    ast = parse(expression);
    dependencies = extractDependenciesFromAst(ast);
  } catch (error) {
    return {
      valid: false,
      error: isFormulaError(error)
        ? `${error.code}: ${error.message}`
        : String(error),
    };
  }

  // 1b. String-comparison field-kind check. A string comparison against a
  //     same-record field whose kind cannot hold a string (anything but SELECT /
  //     TEXT) is rejected here — between dependency extraction and cycle
  //     detection. Unknown fields and cross-refs pass (they resolve to null at
  //     runtime). Skipped entirely when the kinds map is unavailable.
  if (targetObjectFieldKinds) {
    for (const path of collectStringComparisonRefs(ast).sameRecordPaths) {
      const rootField = path.split('.')[0];
      const kind = targetObjectFieldKinds.get(rootField);
      if (kind !== undefined && kind !== 'SELECT' && kind !== 'TEXT') {
        return {
          valid: false,
          error: `String comparison against "${rootField}" is not supported (field type ${kind}; only SELECT and TEXT fields)`,
        };
      }
    }
  }

  // 2. Cycle detection over the full graph (existing formulas + candidate).
  //    Exclude any existing record with the same id (this IS the candidate) so
  //    an update re-evaluates cleanly.
  const others = existingFormulas
    .filter((formula) => formula.id !== candidate.id)
    .map(toTarget)
    .filter((target): target is FormulaTarget => target !== null);

  const graph: FormulaTarget[] = [...others, { object, field, dependencies }];

  const cycle = detectCycle(graph);
  if (cycle.hasCycle) {
    return {
      valid: false,
      error: `Dependency cycle detected: ${cycle.cycle.join(' -> ')}`,
      dependencies,
    };
  }

  return { valid: true, dependencies };
};
