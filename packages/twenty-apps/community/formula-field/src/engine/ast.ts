import { type CrossRefValue } from 'src/engine/tokenizer';

// AST for the arithmetic grammar. Deliberately tiny: numbers, variable
// references (same-record field or cross-record), unary +/-, binary + - * / %,
// comparisons (confined to IF conditions by the parser), and IF conditionals.
// There is still no general call node and no member-access node; the one string
// node is inert data confined to = / != comparison operands, never a callable.
// IF is static dispatch over three fixed sub-expressions, not code execution,
// so the grammar still cannot express running arbitrary code.

export type BinaryOperator = '+' | '-' | '*' | '/' | '%';
export type UnaryOperator = '+' | '-';
// '==' is normalized to '=' at parse time, so the AST only carries '='.
export type ComparisonOperator = '>' | '<' | '>=' | '<=' | '=' | '!=';

export type NumberNode = {
  type: 'number';
  value: number;
};

// A double-quoted string literal. The parser only ever produces one as a direct
// operand of an = / != comparison inside an IF condition (enforced structurally,
// see parser.ts), so, like ComparisonNode, it never reaches a numeric value slot.
export type StringNode = {
  type: 'string';
  value: string;
};

export type FieldNode = {
  type: 'field';
  // Dotted same-record path, e.g. "amount.amountMicros".
  path: string;
};

export type CrossRefNode = {
  type: 'crossref';
  ref: CrossRefValue;
};

export type UnaryNode = {
  type: 'unary';
  operator: UnaryOperator;
  operand: AstNode;
};

export type BinaryNode = {
  type: 'binary';
  operator: BinaryOperator;
  left: AstNode;
  right: AstNode;
};

// Transient node: the parser only ever produces a comparison as the direct
// condition of an IfNode, never where a numeric value is expected, so booleans
// can never leak into the engine's public number|null value domain.
export type ComparisonNode = {
  type: 'comparison';
  operator: ComparisonOperator;
  left: AstNode;
  right: AstNode;
};

export type IfNode = {
  type: 'if';
  condition: AstNode;
  then: AstNode;
  else: AstNode;
};

// Nullary function: the current date as an epoch-day number (ADR 0012).
// Carries no data of its own — evaluate() fills in the value from
// EvaluateOptions.todayEpochDay, supplied by the caller, never read from the
// system clock inside the engine.
export type TodayNode = {
  type: 'today';
};

// Variadic function: SUM(expr1, ..., exprN), N >= 1 (ADR 0016). Static dispatch
// over a fixed argument list, like IF — still no general call node, so the
// grammar cannot express code execution. Args are value-context expressions
// (comparisons/strings stay illegal inside them). Evaluation sums the non-null
// args, skipping nulls; all-null yields null (never 0) per the app's
// null-propagation policy.
export type SumNode = {
  type: 'sum';
  args: AstNode[];
};

// Boolean combinators (ADR 0017). AndNode/OrNode/NotNode/IsBlankNode are
// TRANSIENT condition nodes, like ComparisonNode: the parser only ever produces
// them in condition context (inside an IF's first argument, recursively), never
// where a numeric value is expected, so booleans can never leak into the public
// number|null value domain. The evaluator's value switch carries unreachable
// guards for them so a hand-built AST that misplaces one fails loud.
//   - AND/OR args are condition nodes; evaluation is full-evaluation Kleene
//     (evaluate ALL args — errors always fire, no short-circuit; OR any-true ->
//     true, AND any-false -> false, else any-null -> null).
//   - NOT's operand is a condition node.
//   - ISBLANK's operand is a VALUE node (an expression). ISBLANK observes
//     blankness (raw-first for a bare field/crossref) rather than propagating.
export type AndNode = {
  type: 'and';
  args: AstNode[];
};

export type OrNode = {
  type: 'or';
  args: AstNode[];
};

export type NotNode = {
  type: 'not';
  operand: AstNode;
};

export type IsBlankNode = {
  type: 'isblank';
  operand: AstNode;
};

// IFBLANK(value, fallback) (ADR 0017). Unlike the four combinators above this is
// an ordinary VALUE node (like SumNode) — legal anywhere a number is, including
// inside an ISBLANK operand. Returns `value` unless it evaluates to null, else
// `fallback` (which may itself be null); BOTH are always evaluated (SUM
// precedent — errors always fire). Stays purely numeric: a text field inside it
// goes through the numeric resolver, deliberately asymmetric with ISBLANK.
export type IfBlankNode = {
  type: 'ifblank';
  value: AstNode;
  fallback: AstNode;
};

// Parser-internal sentinel (ADR 0018): the else branch of a default-less
// IFS/SWITCH desugar. NO source syntax produces it — only parseIfs/parseSwitch
// synthesize one when the ladder has no trailing default, so an unmatched ladder
// evaluates to null (blank) rather than erroring. evaluate() returns null for it;
// dependency/usesToday/string-comparison walks are all no-ops. It is the single
// AST addition ADR 0018 makes (IFS/SWITCH are otherwise pure desugaring into
// IfNodes), and it adds no grammar surface because nothing in the source
// tokenizes to it.
export type NullNode = {
  type: 'null';
};

export type AstNode =
  | NumberNode
  | NullNode
  | StringNode
  | FieldNode
  | CrossRefNode
  | UnaryNode
  | BinaryNode
  | ComparisonNode
  | IfNode
  | TodayNode
  | SumNode
  | AndNode
  | OrNode
  | NotNode
  | IsBlankNode
  | IfBlankNode;
