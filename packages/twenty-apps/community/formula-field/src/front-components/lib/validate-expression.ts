import {
  collectStringComparisonRefs,
  detectCycle,
  extractDependenciesFromAst,
  type FormulaTarget,
  isFormulaError,
  parse,
} from 'src/engine';

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
