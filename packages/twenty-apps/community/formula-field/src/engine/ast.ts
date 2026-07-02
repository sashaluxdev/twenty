import { type CrossRefValue } from 'src/engine/tokenizer';

// AST for the arithmetic grammar. Deliberately tiny: numbers, variable
// references (same-record field or cross-record), unary +/-, and binary
// + - * / %. There is no call node, no member-access node, no string node —
// the grammar simply cannot express code execution.

export type BinaryOperator = '+' | '-' | '*' | '/' | '%';
export type UnaryOperator = '+' | '-';

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

export type AstNode =
  | NumberNode
  | FieldNode
  | CrossRefNode
  | UnaryNode
  | BinaryNode;
