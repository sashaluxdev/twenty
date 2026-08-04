import {
  type AstNode,
  bareReferenceOf,
  collectStringComparisonRefs,
  detectCycle,
  extractDependenciesFromAst,
  type FormulaDependencies,
  type FormulaTarget,
  isFormulaError,
  parse,
} from 'src/engine';
import {
  ENGINE_FAMILY_KINDS,
  isMirrorTargetKind,
} from 'src/logic-functions/lib/mirror-kinds';

// The single expression-validation dispatch shared by the backend save path
// (save-validation.ts) and the editor's live pre-save check
// (front-components/lib/validate-expression.ts). Both used to carry their own
// copy of the same four steps, which drifted (the editor's cycle message lacked
// "detected"); one copy means later semantic changes land in exactly one place.
//
// Deliberately depends on nothing beyond src/engine and mirror-kinds: this
// module ships inside the front-component bundle, whose weight is load-bearing
// (ADR 0024).

export type ValidatableFormula = {
  id?: string;
  targetObject: string;
  targetField: string;
  expression: string;
};

export type CoreValidationResult =
  | { valid: true; ast: AstNode; dependencies: FormulaDependencies }
  | {
      valid: false;
      error: string;
      // Present when parsing succeeded but a cycle was found.
      dependencies?: FormulaDependencies;
    };

// A sibling formula contributes a cycle-graph node only when it names a target
// and parses; anything else contributes no edges.
export const toValidationTarget = (
  formula: ValidatableFormula,
): FormulaTarget | null => {
  if (!formula.targetObject || !formula.targetField) {
    return null;
  }
  try {
    return {
      object: formula.targetObject,
      field: formula.targetField,
      dependencies: extractDependenciesFromAst(parse(formula.expression)),
    };
  } catch {
    return null;
  }
};

export const validateExpressionCore = ({
  expression,
  hostObject,
  targetField,
  targetFieldType,
  fieldKinds,
  otherFormulas,
}: {
  expression: string;
  hostObject: string;
  targetField: string;
  targetFieldType?: string;
  fieldKinds?: (objectName: string) => Map<string, string> | undefined;
  // The candidate is excluded by the caller — the backend by id, the editor by
  // targetObject+targetField pair.
  otherFormulas: ValidatableFormula[];
}): CoreValidationResult => {
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
  //     detection. Unknown fields and cross-refs are EXEMPT: their kinds live on
  //     another object this check does not read, so a cross-record non-text
  //     field in a text comparison is left to evaluate — typed equality makes it
  //     simply false (accepted delta B6, ADR 0026), never an error. Skipped
  //     entirely when the target object's kinds are absent.
  const targetObjectFieldKinds = fieldKinds?.(hostObject);
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

  // 1c. Mirror validation. A target field the engine family does not cover is in
  //     "mirror mode": its value is a typed raw passthrough of a single bare
  //     whole-field ref, not an engine expression. A null/blank target kind
  //     defaults to NUMBER (engine family, same rule as value-io's
  //     targetFieldKind), so it keeps today's engine path and skips these checks.
  //     The MIRRORABLE arm of the condition makes the two sets' membership
  //     authoritative rather than the engine family alone; with TEXT now
  //     engine-only (ADR 0026) a TEXT target skips these checks entirely, so any
  //     engine expression — `code & "-" & 1` — validates onto it.
  if (
    targetFieldType != null &&
    targetFieldType !== '' &&
    (isMirrorTargetKind(targetFieldType) ||
      !ENGINE_FAMILY_KINDS.has(targetFieldType))
  ) {
    // (a) The target kind is not mirrorable at all.
    if (!isMirrorTargetKind(targetFieldType)) {
      return {
        valid: false,
        error: `Field kind ${targetFieldType} cannot be mirrored`,
      };
    }
    // (b) Mirrorable target, but the expression is not a bare whole-field ref
    //     (an operator, function, literal, IF, or dotted subpath).
    const bare = bareReferenceOf(ast);
    if (bare === null) {
      return {
        valid: false,
        error: `Only a plain field reference can be mirrored onto a ${targetFieldType} field`,
      };
    }
    // (c) Source kind known via the accessor and different from the target kind
    //     (v1 is strict same-kind). An unknown source kind (accessor gap) passes.
    const sourceObject = bare.kind === 'same' ? hostObject : bare.ref.object;
    const sourceField = bare.kind === 'same' ? bare.field : bare.ref.fieldPath;
    const sourceKind = fieldKinds?.(sourceObject)?.get(sourceField);
    if (sourceKind !== undefined && sourceKind !== targetFieldType) {
      return {
        valid: false,
        error: `Cannot mirror ${sourceKind} field "${sourceField}" onto a ${targetFieldType} field (kinds must match)`,
      };
    }
  }

  // 2. Cycle detection over the full graph (other formulas + candidate).
  const others = otherFormulas
    .map(toValidationTarget)
    .filter((target): target is FormulaTarget => target !== null);

  const graph: FormulaTarget[] = [
    ...others,
    { object: hostObject, field: targetField, dependencies },
  ];

  const cycle = detectCycle(graph);
  if (cycle.hasCycle) {
    return {
      valid: false,
      error: `Dependency cycle detected: ${cycle.cycle.join(' -> ')}`,
      dependencies,
    };
  }

  return { valid: true, ast, dependencies };
};
