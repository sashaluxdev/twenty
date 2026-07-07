import {
  bareReferenceOf,
  collectStringComparisonRefs,
  detectCycle,
  extractDependenciesFromAst,
  type FormulaTarget,
  isFormulaError,
  parse,
} from 'src/engine';
import {
  ENGINE_FAMILY_KINDS,
  isMirrorTargetKind,
} from 'src/logic-functions/lib/mirror-kinds';

// Live pre-save validation for the record-page editor: parse the draft
// expression and check that adding it to the current set of formulas introduces
// no dependency cycle. Mirrors the server-side save-validation graph exactly —
// nodes are keyed on object+field (see findCyclicTargets' `${object}.${field}`),
// so the candidate must be excluded by BOTH targetObject and targetField.
// Excluding by field alone would let two objects with same-named fields mask a
// cross-object cycle, wrongly enabling Save.

export type ValidatableDefinition = {
  targetObject: string;
  targetField: string;
  expression: string;
};

export const validateExpression = (
  expression: string,
  hostObject: string,
  targetField: string,
  allDefinitions: ValidatableDefinition[],
  // Sync accessor over caller-preloaded field-kind maps: objectName -> (field
  // name -> metadata type), or undefined when not preloaded. The editors close
  // it over their single host-object map. When it resolves the host object, a
  // string comparison against a same-record field that cannot hold a string is
  // rejected (parity with the server save-validation). Omitted, or a miss on the
  // host object, degrades gracefully — the check is skipped.
  fieldKinds?: (objectName: string) => Map<string, string> | undefined,
  // The candidate value field's metadata kind. A non-engine-family kind puts the
  // definition in "mirror mode": the same three mirror checks the server runs at
  // save time are applied here (allowlist, bare-ref-only, same-kind). Trailing +
  // optional so the many existing call sites/tests stay source-compatible.
  targetFieldType?: string,
): string | null => {
  let ast;
  let dependencies;
  try {
    ast = parse(expression);
    dependencies = extractDependenciesFromAst(ast);
  } catch (error) {
    return isFormulaError(error)
      ? `${error.code}: ${error.message}`
      : String(error);
  }

  // String-comparison field-kind check — mirrors validateFormula's step 1b.
  const targetObjectFieldKinds = fieldKinds?.(hostObject);
  if (targetObjectFieldKinds) {
    for (const path of collectStringComparisonRefs(ast).sameRecordPaths) {
      const rootField = path.split('.')[0];
      const kind = targetObjectFieldKinds.get(rootField);
      if (kind !== undefined && kind !== 'SELECT' && kind !== 'TEXT') {
        return `String comparison against "${rootField}" is not supported (field type ${kind}; only SELECT and TEXT fields)`;
      }
    }
  }

  // Mirror validation — parity with save-validation.ts step 1c (messages
  // verbatim). A non-engine-family target kind is in mirror mode; a null/blank or
  // engine-family kind keeps today's engine path and skips these checks.
  if (
    targetFieldType != null &&
    targetFieldType !== '' &&
    !ENGINE_FAMILY_KINDS.has(targetFieldType)
  ) {
    // (a) The target kind is not mirrorable at all.
    if (!isMirrorTargetKind(targetFieldType)) {
      return `Field kind ${targetFieldType} cannot be mirrored`;
    }
    // (b) Mirrorable target, but the expression is not a bare whole-field ref.
    const bare = bareReferenceOf(ast);
    if (bare === null) {
      return `Only a plain field reference can be mirrored onto a ${targetFieldType} field`;
    }
    // (c) Source kind known via the accessor and different from the target kind
    //     (v1 is strict same-kind). An unknown source kind (accessor gap) passes.
    const sourceObject = bare.kind === 'same' ? hostObject : bare.ref.object;
    const sourceField = bare.kind === 'same' ? bare.field : bare.ref.fieldPath;
    const sourceKind = fieldKinds?.(sourceObject)?.get(sourceField);
    if (sourceKind !== undefined && sourceKind !== targetFieldType) {
      return `Cannot mirror ${sourceKind} field "${sourceField}" onto a ${targetFieldType} field (kinds must match)`;
    }
  }

  const others: FormulaTarget[] = allDefinitions
    .filter(
      (definition) =>
        !(
          definition.targetObject === hostObject &&
          definition.targetField === targetField
        ),
    )
    .map((definition) => {
      try {
        return {
          object: definition.targetObject,
          field: definition.targetField,
          dependencies: extractDependenciesFromAst(parse(definition.expression)),
        };
      } catch {
        return null;
      }
    })
    .filter((target): target is FormulaTarget => target !== null);

  const cycle = detectCycle([
    ...others,
    { object: hostObject, field: targetField, dependencies },
  ]);
  return cycle.hasCycle ? `Dependency cycle: ${cycle.cycle.join(' -> ')}` : null;
};
