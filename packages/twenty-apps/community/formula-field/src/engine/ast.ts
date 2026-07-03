import { type CrossRefValue } from 'src/engine/tokenizer';

// AST for the arithmetic grammar. Deliberately tiny: numbers, variable
// references (same-record field or cross-record), unary +/-, binary + - * / %,
// comparisons (confined to IF conditions by the parser), and IF conditionals.
// There is still no general call node, no member-access node, no string node —
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

export type AstNode =
  | NumberNode
  | FieldNode
  | CrossRefNode
  | UnaryNode
  | BinaryNode
  | ComparisonNode
  | IfNode;
