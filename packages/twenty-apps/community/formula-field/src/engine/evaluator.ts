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
//   - IF(condition, then, else): the condition is always evaluated; only the
//     TAKEN branch is (lazy — an error in the untaken branch cannot fire).
//     A comparison condition yields an internal boolean that never escapes
//     this module; a numeric condition uses Excel truthiness (0 = false,
//     nonzero = true). A null condition — including null in either comparison
//     operand — makes the whole IF result null, consistent with the app's
//     null-propagation policy (a deliberate deviation from Excel's blank=0).

export type VariableReference =
  | { kind: 'same'; path: string }
  | { kind: 'cross'; ref: CrossRefValue };

export type VariableResolver = (
  reference: VariableReference,
) => number | null | undefined;

const DEFAULT_MAX_DEPTH = 64;

export type EvaluateOptions = {
  maxDepth?: number;
  // Current date as a whole epoch-day (ADR 0012), supplied by the caller —
  // never read from the system clock inside the engine, so evaluate() stays a
  // pure function of its arguments. Required only when the AST contains a
  // TODAY() node.
  todayEpochDay?: number;
};

// Comparison truth, internal only: booleans stay confined to IF's condition
// slot; the public evaluate() signature remains number | null. Null in either
// operand yields null (propagation), never false.
const evaluateConditionTruth = (
  node: AstNode,
  resolve: VariableResolver,
  depth: number,
  maxDepth: number,
  todayEpochDay: number | undefined,
): boolean | null => {
  if (node.type === 'comparison') {
    const left = evaluateNode(node.left, resolve, depth + 1, maxDepth, todayEpochDay);
    const right = evaluateNode(node.right, resolve, depth + 1, maxDepth, todayEpochDay);

    if (left === null || right === null) {
      return null;
    }

    switch (node.operator) {
      case '>':
        return left > right;
      case '<':
        return left < right;
      case '>=':
        return left >= right;
      case '<=':
        return left <= right;
      case '=':
        return left === right;
      case '!=':
        return left !== right;
    }
  }

  const value = evaluateNode(node, resolve, depth, maxDepth, todayEpochDay);

  if (value === null) {
    return null;
  }

  // Excel truthiness for numeric conditions: 0 is false, anything else true.
  return value !== 0;
};

const evaluateNode = (
  node: AstNode,
  resolve: VariableResolver,
  depth: number,
  maxDepth: number,
  todayEpochDay: number | undefined,
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

    // ADR 0012: the value is a caller-supplied input, never a system-clock
    // read inside the engine — same UNKNOWN_VARIABLE failure mode as an
    // unresolved field when the caller forgot to supply it.
    case 'today': {
      if (todayEpochDay === undefined) {
        throw new FormulaError(
          'UNKNOWN_VARIABLE',
          'TODAY() requires todayEpochDay to be supplied in EvaluateOptions',
        );
      }
      return todayEpochDay;
    }

    case 'unary': {
      const operand = evaluateNode(node.operand, resolve, depth + 1, maxDepth, todayEpochDay);
      if (operand === null) {
        return null;
      }
      return node.operator === '-' ? -operand : operand;
    }

    case 'binary': {
      const left = evaluateNode(node.left, resolve, depth + 1, maxDepth, todayEpochDay);
      const right = evaluateNode(node.right, resolve, depth + 1, maxDepth, todayEpochDay);

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

    case 'if': {
      const truth = evaluateConditionTruth(
        node.condition,
        resolve,
        depth + 1,
        maxDepth,
        todayEpochDay,
      );

      // Null condition (or null in a comparison operand) nulls the whole IF.
      if (truth === null) {
        return null;
      }

      // Lazy: only the taken branch runs, so an error (e.g. division by zero)
      // in the untaken branch can never fire.
      return evaluateNode(
        truth ? node.then : node.else,
        resolve,
        depth + 1,
        maxDepth,
        todayEpochDay,
      );
    }

    case 'comparison':
      // Unreachable via parse(): the parser confines comparisons to IF's
      // condition slot, which is handled above. Guard for hand-built ASTs.
      throw new FormulaError(
        'PARSE_ERROR',
        'Comparison is only allowed in the condition of IF(condition, then, else)',
      );
  }
};

export const evaluate = (
  node: AstNode,
  resolve: VariableResolver,
  options: EvaluateOptions = {},
): number | null => {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const result = evaluateNode(node, resolve, 0, maxDepth, options.todayEpochDay);

  if (result !== null && !Number.isFinite(result)) {
    throw new FormulaError(
      'NON_NUMERIC_VALUE',
      `Expression produced a non-finite value (${result})`,
    );
  }

  return result;
};
