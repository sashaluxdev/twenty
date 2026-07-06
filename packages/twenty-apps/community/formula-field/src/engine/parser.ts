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
//   primary    := NUMBER | FIELD | CROSSREF | if | today | '(' expression ')'
//   if         := IF '(' condition ',' expression ',' expression ')'
//   today      := TODAY '(' ')'
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
// `IF` and `TODAY` are reserved words (case-insensitive): a bare same-record
// field named `if` or `today` is no longer expressible; dotted paths like
// `if.x` / `today.x` still are. TODAY() resolves to the current epoch-day
// (ADR 0012, Excel-style current-date value) via a caller-supplied
// evaluator option, not an engine-internal clock read.

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

  // Raised wherever a string literal shows up outside a direct = / != operand —
  // the mirror of comparisonOutsideConditionError for string placement.
  private stringOutsideConditionError(token: Token): FormulaError {
    return new FormulaError(
      'PARSE_ERROR',
      'String literals are only allowed beside = or != inside an IF condition',
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
        // `today` is likewise reserved (ADR 0012): followed by "()" it is the
        // current-date nullary function; bare, or with arguments, is an error.
        if (token.fieldPath!.toLowerCase() === 'today') {
          if (this.tokens[this.position + 1].type === 'LPAREN') {
            return this.parseToday();
          }
          throw new FormulaError(
            'PARSE_ERROR',
            '"TODAY" is a reserved word — expected TODAY()',
            token.position,
          );
        }
        this.advance();
        return { type: 'field', path: token.fieldPath! };
      }

      case 'CROSSREF':
        this.advance();
        return { type: 'crossref', ref: token.crossRef! };

      // A STRING in a value position (parens, arithmetic, IF branch, bare, or a
      // function argument) always routes here and always rejects: string
      // literals are legal ONLY when parseCondition consumes them directly as an
      // = / != operand, so this case makes "direct operand only" structural.
      case 'STRING':
        throw this.stringOutsideConditionError(token);

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

  // TODAY() — a reserved nullary function (ADR 0012). No arguments, no parse
  // depth to guard (unlike IF, it recurses into nothing).
  private parseToday(): AstNode {
    this.advance(); // the TODAY identifier
    this.advance(); // the '(' (presence checked by the caller)

    const closing = this.peek();
    if (closing.type !== 'RPAREN') {
      throw new FormulaError(
        'PARSE_ERROR',
        'TODAY takes no arguments — expected TODAY()',
        closing.position,
      );
    }
    this.advance();

    return { type: 'today' };
  }

  // A comparison operand at the top of an IF condition. This is the ONLY place a
  // string literal is legal: a leading STRING is consumed directly here, so it
  // never reaches parsePrimary (which always rejects strings). Anything else is
  // a plain arithmetic expression as before.
  private parseConditionOperand(): AstNode {
    const token = this.peek();

    if (token.type === 'STRING') {
      this.advance();
      return { type: 'string', value: token.stringValue! };
    }

    return this.parseExpression();
  }

  // The ONLY place a comparison may appear: the top level of IF's first
  // argument. Operands are plain arithmetic expressions (or a bare string
  // literal); a second comparison operator after a complete comparison is a
  // chained comparison, rejected.
  private parseCondition(): AstNode {
    this.enter();
    const left = this.parseConditionOperand();

    const operatorToken = this.peek();
    const operator = COMPARISON_TOKEN_TO_OPERATOR[operatorToken.type];

    if (operator === undefined) {
      // Numeric condition (Excel truthiness): 0 = false, nonzero = true. A lone
      // string here is not beside = / != (e.g. IF("a", 1, 2)), so it is illegal.
      if (left.type === 'string') {
        throw this.stringOutsideConditionError(operatorToken);
      }
      this.leave();
      return left;
    }

    this.advance();
    const right = this.parseConditionOperand();

    // Strings compare only for (in)equality: an ordering operator with a string
    // operand is a type error surfaced at the operator itself.
    if (
      operator !== '=' &&
      operator !== '!=' &&
      (left.type === 'string' || right.type === 'string')
    ) {
      throw new FormulaError(
        'PARSE_ERROR',
        'Strings support only = and != comparisons',
        operatorToken.position,
      );
    }

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
