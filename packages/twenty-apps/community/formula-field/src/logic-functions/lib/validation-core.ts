import {
  type AstNode,
  bareReferenceOf,
  detectCycle,
  extractDependenciesFromAst,
  type FormulaDependencies,
  type FormulaTarget,
  isFormulaError,
  parse,
} from 'src/engine';
import {
  buildTargetSelectOptions,
  type KindLookup,
  selectMembershipGateError,
  type SelectOption,
  strictKindGateError,
} from 'src/logic-functions/lib/kind-inference';
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
  targetOptions,
  otherFormulas,
}: {
  expression: string;
  hostObject: string;
  targetField: string;
  targetFieldType?: string;
  fieldKinds?: KindLookup;
  // The candidate's target SELECT option set, as plain data — this module never
  // loads it itself (the async fetch is the caller's seam).
  targetOptions?: ReadonlyArray<SelectOption> | null;
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

  // 1b. Strict kind gate (Task 3, strict-typing arc). Infers the whole
  //     expression's output kind and checks it against the target field's kind —
  //     one general rule reached by every save path, replacing the old
  //     string-comparison-only check (1b) and the TEXT-target bare-ref guard
  //     (1d). The helper's own predicate is authoritative for when it applies
  //     (mirror-lane / blank targets skip, never reject) — this call site does
  //     not duplicate that predicate.
  const kindGateError = strictKindGateError({
    ast,
    hostObject,
    targetFieldType,
    fieldKinds,
  });
  if (kindGateError !== null) {
    return { valid: false, error: kindGateError, dependencies };
  }

  // 1b'. SELECT membership gate, static tier (ADR 0029 D3): only for SELECT
  //      targets with a resolvable option set. Open literal sets pass — the
  //      per-record runtime check owns them; missing options skip, never
  //      reject (the recompute gates re-check with resolved options).
  const membershipError = selectMembershipGateError({
    ast,
    targetFieldType,
    targetOptions: buildTargetSelectOptions(targetOptions),
  });
  if (membershipError !== null) {
    return { valid: false, error: membershipError };
  }

  // 1c. Mirror validation. A target field the engine family does not cover is in
  //     "mirror mode": its value is a typed raw passthrough of a single bare
  //     whole-field ref, not an engine expression. A null/blank target kind
  //     defaults to NUMBER (engine family, same rule as value-io's
  //     targetFieldKind), so it keeps today's engine path and skips these checks.
  //     The MIRRORABLE arm of the condition makes the two sets' membership
  //     authoritative rather than the engine family alone; with TEXT now
  //     engine-only (ADR 0026) a TEXT target skips these checks entirely, so any
  //     engine expression — `code & "-" & 1` — validates onto it; the strict
  //     kind gate above (1b) now covers the one piece a TEXT target still needs
  //     (the bare-ref source kind, via its output-kind check).
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
