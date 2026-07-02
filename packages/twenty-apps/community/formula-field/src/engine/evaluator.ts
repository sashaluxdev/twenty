import { type AstNode } from 'src/engine/ast';
import { FormulaError } from 'src/engine/errors';
import { type CrossRefValue } from 'src/engine/tokenizer';

// Pure interpreter over the AST. It knows NOTHING about the Twenty API — all
// data access is delegated to a `VariableResolver` supplied by the caller. This
// keeps the interpreter 100% unit-testable and guarantees there is no I/O, no
// eval, and no dynamic code path.
//
// Value semantics (documented policy, exercised by unit tests):
//   - A resolver returning `undefined` means the variable does not exist ->
//     UNKNOWN_VARIABLE error (fail loud; likely a typo in the formula).
//   - A resolver returning `null` means the field exists but is empty. Null
//     PROPAGATES: any sub-expression touching a null yields null, and the whole
//     formula result is null (the value field is cleared). This distinguishes
//     "not computed yet / missing input" from "computed as 0".
//   - Division or modulo by zero -> DIVISION_BY_ZERO error (value left
//     unchanged by the engine, error surfaced on lastError).
//   - Non-finite results (Infinity/NaN) -> NON_NUMERIC_VALUE error.

export type VariableReference =
  | { kind: 'same'; path: string }
  | { kind: 'cross'; ref: CrossRefValue };

export type VariableResolver = (
  reference: VariableReference,
) => number | null | undefined;

const DEFAULT_MAX_DEPTH = 64;

export type EvaluateOptions = {
  maxDepth?: number;
};

const evaluateNode = (
  node: AstNode,
  resolve: VariableResolver,
  depth: number,
  maxDepth: number,
): number | null => {
  if (depth > maxDepth) {
    throw new FormulaError(
      'MAX_DEPTH_EXCEEDED',
      `Expression nesting exceeded max depth of ${maxDepth}`,
    );
  }

  switch (node.type) {
    case 'number':
      return node.value;

    case 'field': {
      const value = resolve({ kind: 'same', path: node.path });
      if (value === undefined) {
        throw new FormulaError(
          'UNKNOWN_VARIABLE',
          `Unknown field "${node.path}"`,
        );
      }
      return value;
    }

    case 'crossref': {
      const value = resolve({ kind: 'cross', ref: node.ref });
      if (value === undefined) {
        throw new FormulaError(
          'UNKNOWN_VARIABLE',
          `Unknown cross-record reference [${node.ref.object}:${node.ref.recordId}:${node.ref.fieldPath}]`,
        );
      }
      return value;
    }

    case 'unary': {
      const operand = evaluateNode(node.operand, resolve, depth + 1, maxDepth);
      if (operand === null) {
        return null;
      }
      return node.operator === '-' ? -operand : operand;
    }

    case 'binary': {
      const left = evaluateNode(node.left, resolve, depth + 1, maxDepth);
      const right = evaluateNode(node.right, resolve, depth + 1, maxDepth);

      // Null propagation: any null operand makes the result null.
      if (left === null || right === null) {
        return null;
      }

      let result: number;
      switch (node.operator) {
        case '+':
          result = left + right;
          break;
        case '-':
          result = left - right;
          break;
        case '*':
          result = left * right;
          break;
        case '/':
          if (right === 0) {
            throw new FormulaError('DIVISION_BY_ZERO', 'Division by zero');
          }
          result = left / right;
          break;
        case '%':
          if (right === 0) {
            throw new FormulaError('DIVISION_BY_ZERO', 'Modulo by zero');
          }
          result = left % right;
          break;
      }

      if (!Number.isFinite(result)) {
        throw new FormulaError(
          'NON_NUMERIC_VALUE',
          `Expression produced a non-finite value (${result})`,
        );
      }

      return result;
    }
  }
};

export const evaluate = (
  node: AstNode,
  resolve: VariableResolver,
  options: EvaluateOptions = {},
): number | null => {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const result = evaluateNode(node, resolve, 0, maxDepth);

  if (result !== null && !Number.isFinite(result)) {
    throw new FormulaError(
      'NON_NUMERIC_VALUE',
      `Expression produced a non-finite value (${result})`,
    );
  }

  return result;
};
