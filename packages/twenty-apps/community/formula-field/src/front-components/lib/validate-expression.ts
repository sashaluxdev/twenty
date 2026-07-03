import {
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
): string | null => {
  let dependencies;
  try {
    dependencies = extractDependenciesFromAst(parse(expression));
  } catch (error) {
    return isFormulaError(error)
      ? `${error.code}: ${error.message}`
      : String(error);
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
