import {
  type AstNode,
  type BinaryOperator,
  type ComparisonOperator,
} from 'src/engine/ast';
import { FormulaError } from 'src/engine/errors';
import { type Token, type TokenType, tokenize } from 'src/engine/tokenizer';

// Recursive-descent parser implementing standard arithmetic precedence:
//
//   expression := term (('+' | '-') term)*
//   term       := unary (('*' | '/' | '%') unary)*
//   unary      := ('+' | '-') unary | primary
//   primary    := NUMBER | FIELD | CROSSREF | if | '(' expression ')'
//   if         := IF '(' condition ',' expression ',' expression ')'
//   condition  := expression (compareOp expression)?
//   compareOp  := '>' | '<' | '>=' | '<=' | '=' | '==' | '!='
//
// Left-associative binary operators; unary binds tighter than binary but looser
// than parentheses. Any leftover tokens after a complete expression are an error
// (rejects trailing garbage like "1 2" or "a)").
//
// Comparisons are TRANSIENT: `condition` is reachable ONLY as IF's first
// argument, so a comparison can never appear where a numeric value is expected
// (top level, arithmetic, then/else branches, or a comparison operand). That
// keeps booleans out of the engine's public number|null value domain. Chained
// comparisons (`a > b > c`) are rejected — comparison is not associative here.
// `IF` is a reserved word (case-insensitive): a bare same-record field named
// `if` is no longer expressible; dotted paths like `if.x` still are.

// Guards against pathological input. The recursive-descent parser recurses once
// per nesting level, so unbounded input could overflow the JS call stack before
// the evaluator's own depth guard ever runs. We cap both the raw source length
// and the parse recursion depth and fail with a clean PARSE_ERROR instead.
const MAX_EXPRESSION_LENGTH = 2000;
const MAX_PARSE_DEPTH = 200;

const COMPARISON_TOKEN_TO_OPERATOR: Partial<
  Record<TokenType, ComparisonOperator>
> = {
  GREATER_THAN: '>',
  GREATER_THAN_OR_EQUAL: '>=',
  LESS_THAN: '<',
  LESS_THAN_OR_EQUAL: '<=',
  // '==' is already normalized to the EQUAL token by the tokenizer.
  EQUAL: '=',
  NOT_EQUAL: '!=',
};

const isComparisonToken = (token: Token): boolean =>
  COMPARISON_TOKEN_TO_OPERATOR[token.type] !== undefined;

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

  // Raised wherever a comparison operator shows up in a value position — the
  // one message users will hit most while learning the condition-only rule.
  private comparisonOutsideConditionError(token: Token): FormulaError {
    return new FormulaError(
      'PARSE_ERROR',
      `Comparison "${token.lexeme}" is only allowed in the condition of IF(condition, then, else)`,
      token.position,
    );
  }

  parse(): AstNode {
    const node = this.parseExpression();

    const next = this.peek();
    if (next.type !== 'EOF') {
      if (isComparisonToken(next)) {
        throw this.comparisonOutsideConditionError(next);
      }
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

      case 'FIELD': {
        // `if` is a reserved word (case-insensitive): followed by "(" it opens
        // a conditional; bare, it is no longer a legal field reference.
        if (token.fieldPath!.toLowerCase() === 'if') {
          if (this.tokens[this.position + 1].type === 'LPAREN') {
            return this.parseIf();
          }
          throw new FormulaError(
            'PARSE_ERROR',
            '"IF" is a reserved word — expected IF(condition, then, else)',
            token.position,
          );
        }
        this.advance();
        return { type: 'field', path: token.fieldPath! };
      }

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
          // Parentheses are a value context, so a comparison here (including a
          // parenthesised comparison operand) gets the condition-only message.
          if (isComparisonToken(closing)) {
            throw this.comparisonOutsideConditionError(closing);
          }
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
        if (isComparisonToken(token)) {
          throw this.comparisonOutsideConditionError(token);
        }
        throw new FormulaError(
          'PARSE_ERROR',
          `Unexpected token "${token.lexeme}"`,
          token.position,
        );
    }
  }

  private expectIfArgumentComma(): void {
    const token = this.peek();
    if (token.type !== 'COMMA') {
      if (isComparisonToken(token)) {
        throw this.comparisonOutsideConditionError(token);
      }
      throw new FormulaError(
        'PARSE_ERROR',
        'IF requires exactly 3 arguments: IF(condition, then, else)',
        token.position,
      );
    }
    this.advance();
  }

  private parseIf(): AstNode {
    // IF arguments nest through parseExpression/parseCondition, but the IF
    // frame itself must also count against parse depth so a chain of nested
    // IFs is bounded the same way nested parentheses are.
    this.enter();
    this.advance(); // the IF identifier
    this.advance(); // the '(' (presence checked by the caller)

    const condition = this.parseCondition();
    this.expectIfArgumentComma();
    const thenBranch = this.parseExpression();
    this.expectIfArgumentComma();
    const elseBranch = this.parseExpression();

    const closing = this.peek();
    if (closing.type !== 'RPAREN') {
      // A comparison stranded in the else branch gets the condition-only
      // message; a comma means a 4th argument (arity error).
      if (isComparisonToken(closing)) {
        throw this.comparisonOutsideConditionError(closing);
      }
      throw new FormulaError(
        'PARSE_ERROR',
        closing.type === 'COMMA'
          ? 'IF requires exactly 3 arguments: IF(condition, then, else)'
          : 'Missing closing parenthesis ")" after IF arguments',
        closing.position,
      );
    }
    this.advance();

    this.leave();
    return { type: 'if', condition, then: thenBranch, else: elseBranch };
  }

  // The ONLY place a comparison may appear: the top level of IF's first
  // argument. Operands are plain arithmetic expressions; a second comparison
  // operator after a complete comparison is a chained comparison, rejected.
  private parseCondition(): AstNode {
    this.enter();
    const left = this.parseExpression();

    const operatorToken = this.peek();
    const operator = COMPARISON_TOKEN_TO_OPERATOR[operatorToken.type];

    if (operator === undefined) {
      // Numeric condition (Excel truthiness): 0 = false, nonzero = true.
      this.leave();
      return left;
    }

    this.advance();
    const right = this.parseExpression();

    const trailing = this.peek();
    if (isComparisonToken(trailing)) {
      throw new FormulaError(
        'PARSE_ERROR',
        `Chained comparisons are not supported ("... ${operatorToken.lexeme} ... ${trailing.lexeme} ...")`,
        trailing.position,
      );
    }

    this.leave();
    return { type: 'comparison', operator, left, right };
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
