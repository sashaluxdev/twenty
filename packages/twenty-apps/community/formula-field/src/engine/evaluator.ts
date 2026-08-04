import { type AstNode } from 'src/engine/ast';
import { FormulaError } from 'src/engine/errors';
import {
  formatNumberAsText,
  MAX_COMPUTED_TEXT_LENGTH,
} from 'src/engine/text-format';
import { type CrossRefValue } from 'src/engine/tokenizer';

// Pure interpreter over the AST. It knows NOTHING about the Twenty API — all
// data access is delegated to a `VariableResolver` supplied by the caller. This
// keeps the interpreter 100% unit-testable and guarantees there is no I/O, no
// eval, and no dynamic code path.
//
// Value semantics (documented policy, exercised by unit tests):
//   - The value domain is `number | string | null` (ADR 0026). Text enters it
//     from a resolver (a TEXT/SELECT field resolves verbatim) or a string
//     literal, and flows through IF branches and IFBLANK. A
//     NUMERIC context (arithmetic, unary, SUM, ordering, truthiness) coerces
//     text at POINT OF USE via `toNumber`, which fails loud with
//     NON_NUMERIC_VALUE on text that is not numeric-shaped — including the
//     empty string, since `Number('')` is 0 and a blank field must never behave
//     like a zero.
//   - A resolver returning `undefined` means the variable does not exist ->
//     UNKNOWN_VARIABLE error (fail loud; likely a typo in the formula).
//   - A resolver returning `null` means the field exists but is empty. Null
//     PROPAGATES: any sub-expression touching a null yields null, and the whole
//     formula result is null (the value field is cleared). This distinguishes
//     "not computed yet / missing input" from "computed as 0".
//   - Division or modulo by zero -> DIVISION_BY_ZERO error (value left
//     unchanged by the engine, error surfaced on lastError).
//   - Non-finite NUMERIC results (Infinity/NaN) -> NON_NUMERIC_VALUE error.
//   - `=` / `!=` are TYPED and non-coercing (ADR 0026): a cross-type pair is
//     simply unequal, so `42 = "42"` is false and `42 != "42"` is true. Text
//     compares to text, numbers compare to numbers, and a null on either side
//     still null-propagates. Ordering (`< <= > >=`) is numeric-only and coerces
//     both operands.
//   - IF(condition, then, else): the condition is always evaluated; only the
//     TAKEN branch is (lazy — an error in the untaken branch cannot fire).
//     A comparison condition yields an internal boolean that never escapes
//     this module; a numeric condition uses Excel truthiness (0 = false,
//     nonzero = true). A null condition — including null in either comparison
//     operand — makes the whole IF result null, consistent with the app's
//     null-propagation policy (a deliberate deviation from Excel's blank=0).
//   - AND/OR/NOT/ISBLANK (ADR 0017) are condition-only combinators handled in
//     evaluateConditionTruth. AND/OR use full-evaluation Kleene three-valued
//     logic with NO short-circuit: every argument is always evaluated (errors
//     always fire), then AND is false if any argument is false else null if any
//     is null else true, and OR is true if any is true else null if any is null
//     else false (a determined truth dominates a null). NOT negates its
//     argument (null stays null). ISBLANK is the one exception to null handling
//     — it OBSERVES blankness (null, or text that is empty/whitespace-only) and
//     returns a boolean, never null, for a successfully evaluated argument.
//   - IFBLANK(value, fallback) (ADR 0017) is a value node: returns value unless
//     it is BLANK (null, or empty/whitespace-only text — ADR 0026 widened this
//     from null alone), else fallback; both are always evaluated (SUM
//     precedent). It now agrees with ISBLANK on what blank means.
//   - `&` (concat, ADR 0026 delta D2) is the single exception to null
//     propagation: a null part contributes '' instead of nulling the result, so
//     an all-null concat is ''. Numbers render via formatNumberAsText (dates
//     arrive as serials and render as such). The concatenated result is capped
//     at MAX_COMPUTED_TEXT_LENGTH -> TEXT_TOO_LONG; nothing else is capped.

export type VariableReference =
  | { kind: 'same'; path: string }
  | { kind: 'cross'; ref: CrossRefValue };

// The engine's runtime value domain (ADR 0026).
export type EngineValue = number | string | null;

export type VariableResolver = (
  reference: VariableReference,
) => EngineValue | undefined;

export const DEFAULT_MAX_DEPTH = 64;

export type EvaluateOptions = {
  maxDepth?: number;
  // Current date as a whole epoch-day (ADR 0012), supplied by the caller —
  // never read from the system clock inside the engine, so evaluate() stays a
  // pure function of its arguments. Required only when the AST contains a
  // TODAY() node.
  todayEpochDay?: number;
};

// Point-of-use numeric coercion for the text domain. Date-shaped strings were
// already coerced to serials at resolve time, so only Number() applies here.
const toNumber = (value: number | string): number => {
  if (typeof value === 'number') {
    return value;
  }
  const trimmed = value.trim();
  if (trimmed !== '') {
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  throw new FormulaError(
    'NON_NUMERIC_VALUE',
    `Text value is not numeric (${JSON.stringify(value)})`,
  );
};

// Blankness in the value domain: an empty field, or text with nothing in it.
const isBlankValue = (value: EngineValue): boolean =>
  value === null || (typeof value === 'string' && value.trim() === '');

// Comparison truth, internal only: booleans stay confined to IF's condition
// slot; the public evaluate() signature remains number | string | null. Null in
// either operand yields null (propagation), never false.
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
      // Ordering is numeric-only — the parser already rejects a string literal
      // beside one, and a text FIELD coerces at point of use like anywhere else.
      case '>':
        return toNumber(left) > toNumber(right);
      case '<':
        return toNumber(left) < toNumber(right);
      case '>=':
        return toNumber(left) >= toNumber(right);
      case '<=':
        return toNumber(left) <= toNumber(right);
      // Typed and non-coercing (ADR 0026 delta B1): `===` already makes a
      // cross-type pair unequal, so `42 = "42"` is false and `42 != "42"` true
      // without a separate typeof branch.
      case '=':
        return left === right;
      case '!=':
        return left !== right;
    }
  }

  // ADR 0017 combinators: full-evaluation Kleene three-valued logic, NO
  // short-circuit. EVERY argument is still evaluated (so an error in any of them
  // always fires, matching SUM) — evaluate-everything is the invariant, and it
  // is deliberately decoupled from the truth combination below. Kleene rule:
  // AND is false if any argument is false, else null if any is null, else true;
  // OR is true if any argument is true, else null if any is null, else false.
  // So AND(false, null) = false and OR(true, null) = true — a determined truth
  // dominates a null, which is what makes OR(ISBLANK(x), x > 10) and
  // AND(NOT(ISBLANK(x)), x > 10) behave as the null-tolerance idioms advertise.
  if (node.type === 'and' || node.type === 'or') {
    let anyNull = false;
    let anyTrue = false;
    let anyFalse = false;
    for (const arg of node.args) {
      const truth = evaluateConditionTruth(
        arg,
        resolve,
        depth + 1,
        maxDepth,
        todayEpochDay,
      );
      if (truth === null) {
        anyNull = true;
      } else if (truth) {
        anyTrue = true;
      } else {
        anyFalse = true;
      }
    }
    if (node.type === 'and') {
      if (anyFalse) {
        return false;
      }
      return anyNull ? null : true;
    }
    if (anyTrue) {
      return true;
    }
    return anyNull ? null : false;
  }

  if (node.type === 'not') {
    const truth = evaluateConditionTruth(
      node.operand,
      resolve,
      depth + 1,
      maxDepth,
      todayEpochDay,
    );
    return truth === null ? null : !truth;
  }

  // ISBLANK observes blankness instead of propagating null: it never RETURNS
  // null for a successfully evaluated argument (a typo'd field still throws
  // UNKNOWN_VARIABLE). Now that text lives in the value domain, one evaluation
  // covers both lanes — an empty field is blank, and so is text that is empty or
  // whitespace-only, so ISBLANK(email) still works on TEXT/SELECT.
  if (node.type === 'isblank') {
    const value = evaluateNode(
      node.operand,
      resolve,
      depth + 1,
      maxDepth,
      todayEpochDay,
    );
    return isBlankValue(value);
  }

  const value = evaluateNode(node, resolve, depth, maxDepth, todayEpochDay);

  if (value === null) {
    return null;
  }

  // Excel truthiness for numeric conditions: 0 is false, anything else true.
  return toNumber(value) !== 0;
};

const evaluateNode = (
  node: AstNode,
  resolve: VariableResolver,
  depth: number,
  maxDepth: number,
  todayEpochDay: number | undefined,
): EngineValue => {
  if (depth > maxDepth) {
    throw new FormulaError(
      'MAX_DEPTH_EXCEEDED',
      `Expression nesting exceeded max depth of ${maxDepth}`,
    );
  }

  switch (node.type) {
    case 'number':
      return node.value;

    // ADR 0018: a default-less IFS/SWITCH ladder desugars to a NullNode else,
    // so an unmatched ladder evaluates to null (blank). Trivial by construction.
    case 'null':
      return null;

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
      const numeric = toNumber(operand);
      return node.operator === '-' ? -numeric : numeric;
    }

    case 'binary': {
      const leftValue = evaluateNode(node.left, resolve, depth + 1, maxDepth, todayEpochDay);
      const rightValue = evaluateNode(node.right, resolve, depth + 1, maxDepth, todayEpochDay);

      // Null propagation: any null operand makes the result null.
      if (leftValue === null || rightValue === null) {
        return null;
      }

      // Arithmetic is a numeric context: text coerces here, at point of use.
      const left = toNumber(leftValue);
      const right = toNumber(rightValue);

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

    // ADR 0016: evaluate ALL arguments (never lazy), summing the non-null ones.
    // A null argument is SKIPPED (not treated as 0); if every argument is null
    // the result is null (deliberate deviation from Excel's 0, so "no data"
    // still renders blank). Errors in any argument (division by zero, etc.)
    // propagate as usual because the argument is always evaluated.
    case 'sum': {
      let total = 0;
      let anyNonNull = false;
      for (const arg of node.args) {
        const value = evaluateNode(arg, resolve, depth + 1, maxDepth, todayEpochDay);
        if (value === null) {
          continue;
        }
        anyNonNull = true;
        total += toNumber(value);
      }

      if (!anyNonNull) {
        return null;
      }

      if (!Number.isFinite(total)) {
        throw new FormulaError(
          'NON_NUMERIC_VALUE',
          `Expression produced a non-finite value (${total})`,
        );
      }

      return total;
    }

    // ADR 0026 delta D2: `&` is the ONE place null coerces to '' instead of
    // propagating — a name-plus-optional-suffix template must not blank out the
    // whole result because one part is empty. Kleene propagation everywhere else
    // is untouched, so an all-null concat is '' (a determined text), not null.
    // All parts are ALWAYS evaluated (SUM precedent: an error in any part fires).
    case 'concat': {
      let result = '';
      for (const part of node.parts) {
        const value = evaluateNode(part, resolve, depth + 1, maxDepth, todayEpochDay);
        if (value !== null) {
          result += typeof value === 'number' ? formatNumberAsText(value) : value;
        }
        // Checked per part so a runaway chain cannot build an unbounded string
        // before failing. The cap is a CONCAT-only guard: a long TEXT field
        // flowing through a one-term formula or an IF branch is never capped,
        // keeping mirror parity with the source field.
        if (result.length > MAX_COMPUTED_TEXT_LENGTH) {
          throw new FormulaError(
            'TEXT_TOO_LONG',
            `Computed text exceeds ${MAX_COMPUTED_TEXT_LENGTH} characters`,
          );
        }
      }
      return result;
    }

    // ADR 0017, generalized by ADR 0026: substitute the fallback whenever the
    // value is BLANK — null, or text that is empty/whitespace-only — so IFBLANK
    // and ISBLANK now agree on what "blank" means. BOTH operands are always
    // evaluated (SUM precedent — an error in the fallback fires even when the
    // value is non-blank).
    case 'ifblank': {
      const value = evaluateNode(node.value, resolve, depth + 1, maxDepth, todayEpochDay);
      const fallback = evaluateNode(node.fallback, resolve, depth + 1, maxDepth, todayEpochDay);
      return isBlankValue(value) ? fallback : value;
    }

    // ADR 0017: AND/OR/NOT/ISBLANK are transient condition nodes handled inside
    // evaluateConditionTruth (IF's condition slot). Reaching a value slot is
    // impossible via parse() — guard for hand-built ASTs, mirroring 'comparison'.
    case 'and':
    case 'or':
    case 'not':
    case 'isblank':
      // Wording matches the parser-reachable
      // conditionFunctionOutsideConditionError verbatim, so the guard and the
      // real user-facing error read identically.
      throw new FormulaError(
        'PARSE_ERROR',
        `${node.type.toUpperCase()}(...) is only allowed inside an IF condition`,
      );

    case 'string':
      return node.value;

    case 'comparison':
      // Unreachable via parse(): the parser confines comparisons to IF's
      // condition slot, which is handled above. Guard for hand-built ASTs.
      throw new FormulaError(
        'PARSE_ERROR',
        'Comparison is only allowed in the condition of IF(condition, then, else)',
      );

    default:
      // Exhaustiveness guard: every known node type is handled above, so a
      // ComparisonNode in a value slot fails loud rather than returning
      // undefined. A future node type lands here for the same reason.
      throw new FormulaError(
        'NON_NUMERIC_VALUE',
        `Unsupported node type "${(node as AstNode).type}"`,
      );
  }
};

export const evaluate = (
  node: AstNode,
  resolve: VariableResolver,
  options: EvaluateOptions = {},
): EngineValue => {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const result = evaluateNode(node, resolve, 0, maxDepth, options.todayEpochDay);

  // Finiteness is a NUMERIC invariant — text results pass through untouched.
  if (typeof result === 'number' && !Number.isFinite(result)) {
    throw new FormulaError(
      'NON_NUMERIC_VALUE',
      `Expression produced a non-finite value (${result})`,
    );
  }

  return result;
};
