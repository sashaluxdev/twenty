import { type AstNode, type BinaryOperator } from 'src/engine/ast';
import { FormulaError } from 'src/engine/errors';
import { type Token, tokenize } from 'src/engine/tokenizer';

// Recursive-descent parser implementing standard arithmetic precedence:
//
//   expression := term (('+' | '-') term)*
//   term       := unary (('*' | '/' | '%') unary)*
//   unary      := ('+' | '-') unary | primary
//   primary    := NUMBER | FIELD | CROSSREF | '(' expression ')'
//
// Left-associative binary operators; unary binds tighter than binary but looser
// than parentheses. Any leftover tokens after a complete expression are an error
// (rejects trailing garbage like "1 2" or "a)").

// Guards against pathological input. The recursive-descent parser recurses once
// per nesting level, so unbounded input could overflow the JS call stack before
// the evaluator's own depth guard ever runs. We cap both the raw source length
// and the parse recursion depth and fail with a clean PARSE_ERROR instead.
const MAX_EXPRESSION_LENGTH = 2000;
const MAX_PARSE_DEPTH = 200;

class Parser {
  private position = 0;
  private depth = 0;

  constructor(private readonly tokens: Token[]) {}

  private peek(): Token {
    return this.tokens[this.position];
  }

  private advance(): Token {
    return this.tokens[this.position++];
  }

  private enter(): void {
    this.depth += 1;
    if (this.depth > MAX_PARSE_DEPTH) {
      throw new FormulaError(
        'PARSE_ERROR',
        `Expression nesting exceeded max depth of ${MAX_PARSE_DEPTH}`,
        this.peek().position,
      );
    }
  }

  private leave(): void {
    this.depth -= 1;
  }

  parse(): AstNode {
    const node = this.parseExpression();

    const next = this.peek();
    if (next.type !== 'EOF') {
      throw new FormulaError(
        'PARSE_ERROR',
        `Unexpected token "${next.lexeme}"`,
        next.position,
      );
    }

    return node;
  }

  private parseExpression(): AstNode {
    this.enter();
    let left = this.parseTerm();

    while (this.peek().type === 'PLUS' || this.peek().type === 'MINUS') {
      const operator: BinaryOperator =
        this.advance().type === 'PLUS' ? '+' : '-';
      const right = this.parseTerm();
      left = { type: 'binary', operator, left, right };
    }

    this.leave();
    return left;
  }

  private parseTerm(): AstNode {
    let left = this.parseUnary();

    while (
      this.peek().type === 'STAR' ||
      this.peek().type === 'SLASH' ||
      this.peek().type === 'PERCENT'
    ) {
      const tokenType = this.advance().type;
      const operator: BinaryOperator =
        tokenType === 'STAR' ? '*' : tokenType === 'SLASH' ? '/' : '%';
      const right = this.parseUnary();
      left = { type: 'binary', operator, left, right };
    }

    return left;
  }

  private parseUnary(): AstNode {
    const token = this.peek();

    if (token.type === 'PLUS' || token.type === 'MINUS') {
      this.advance();
      const operand = this.parseUnary();
      return {
        type: 'unary',
        operator: token.type === 'PLUS' ? '+' : '-',
        operand,
      };
    }

    return this.parsePrimary();
  }

  private parsePrimary(): AstNode {
    const token = this.peek();

    switch (token.type) {
      case 'NUMBER':
        this.advance();
        return { type: 'number', value: token.numberValue! };

      case 'FIELD':
        this.advance();
        return { type: 'field', path: token.fieldPath! };

      case 'CROSSREF':
        this.advance();
        return { type: 'crossref', ref: token.crossRef! };

      case 'LPAREN': {
        this.advance();
        // Parenthesised sub-expression: recurse through parseExpression, which
        // increments the parse-depth guard so nested "(((...)))" is bounded.
        const inner = this.parseExpression();
        const closing = this.peek();
        if (closing.type !== 'RPAREN') {
          throw new FormulaError(
            'PARSE_ERROR',
            'Missing closing parenthesis ")"',
            closing.position,
          );
        }
        this.advance();
        return inner;
      }

      case 'EOF':
        throw new FormulaError(
          'PARSE_ERROR',
          'Unexpected end of expression',
          token.position,
        );

      default:
        throw new FormulaError(
          'PARSE_ERROR',
          `Unexpected token "${token.lexeme}"`,
          token.position,
        );
    }
  }
}

export const parse = (source: string): AstNode => {
  if (source.length > MAX_EXPRESSION_LENGTH) {
    throw new FormulaError(
      'PARSE_ERROR',
      `Expression exceeds max length of ${MAX_EXPRESSION_LENGTH} characters`,
    );
  }

  const tokens = tokenize(source);
  return new Parser(tokens).parse();
};
