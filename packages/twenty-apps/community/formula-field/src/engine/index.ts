// Public surface of the pure formula engine. Everything here is I/O-free and
// unit-tested — the recompute engine and front component build on top of it.

export { type AstNode } from 'src/engine/ast';
export {
  detectCycle,
  type CycleResult,
  type FormulaTarget,
} from 'src/engine/cycle-detection';
export {
  extractDependencies,
  extractDependenciesFromAst,
  type CrossRecordDependency,
  type FormulaDependencies,
} from 'src/engine/dependencies';
export { FormulaError, isFormulaError, type FormulaErrorCode } from 'src/engine/errors';
export {
  evaluate,
  type EvaluateOptions,
  type VariableReference,
  type VariableResolver,
} from 'src/engine/evaluator';
export { parse } from 'src/engine/parser';
export { tokenize, type CrossRefValue, type Token } from 'src/engine/tokenizer';

import { type AstNode } from 'src/engine/ast';
import { extractDependenciesFromAst, type FormulaDependencies } from 'src/engine/dependencies';
import { parse } from 'src/engine/parser';

// Parse once, return both the AST and its dependency set — the common shape the
// recompute engine and the save-time validator need.
export const compileFormula = (
  source: string,
): { ast: AstNode; dependencies: FormulaDependencies } => {
  const ast = parse(source);
  return { ast, dependencies: extractDependenciesFromAst(ast) };
};
