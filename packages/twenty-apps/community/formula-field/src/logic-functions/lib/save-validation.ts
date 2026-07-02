import {
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

export type ValidateArgs = {
  candidate: Pick<
    FormulaDefinitionRecord,
    'id' | 'targetObject' | 'targetField' | 'expression'
  >;
  // All OTHER enabled formulas (the candidate is added on top).
  existingFormulas: FormulaDefinitionRecord[];
};

export const validateFormula = ({
  candidate,
  existingFormulas,
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

  // 1. Parse + dependency extraction.
  let dependencies: FormulaDependencies;
  try {
    dependencies = extractDependenciesFromAst(parse(expression));
  } catch (error) {
    return {
      valid: false,
      error: isFormulaError(error)
        ? `${error.code}: ${error.message}`
        : String(error),
    };
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
