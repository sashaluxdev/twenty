import {
  type AstNode,
  type BinaryOperator,
  type ComparisonOperator,
} from 'src/engine/ast';
import { FormulaError } from 'src/engine/errors';
import { type Token, type TokenType, tokenize } from 'src/engine/tokenizer';

// Recursive-descent parser implementing standard arithmetic precedence:
//
//   expression   := term (('+' | '-') term)*
//   term         := unary (('*' | '/' | '%') unary)*
//   unary        := ('+' | '-') unary | primary
//   primary      := NUMBER | FIELD | CROSSREF | if | today | sum | ifblank
//                 | '(' expression ')'
//   if           := IF '(' condition ',' expression ',' expression ')'
//   today        := TODAY '(' ')'
//   sum          := SUM '(' expression (',' expression)* ')'
//   ifblank      := IFBLANK '(' expression ',' expression ')'
//   condition    := boolFunction | operand (compareOp operand)?
//   boolFunction := AND '(' condition (',' condition)+ ')'
//                 | OR  '(' condition (',' condition)+ ')'
//                 | NOT '(' condition ')'
//                 | ISBLANK '(' expression ')'
//   operand      := STRING | expression        // STRING only as a =/!= operand
//   compareOp    := '>' | '<' | '>=' | '<=' | '=' | '==' | '!='
//
// Left-associative binary operators; unary binds tighter than binary but looser
// than parentheses. Any leftover tokens after a complete expression are an error
// (rejects trailing garbage like "1 2" or "a)").
//
// Comparisons and the AND/OR/NOT/ISBLANK combinators are TRANSIENT: `condition`
// is reachable ONLY as IF's first argument (and recursively inside a combinator's
// arguments), so none of them can appear where a numeric value is expected (top
// level, arithmetic, then/else branches, a comparison operand, or a SUM/IFBLANK
// argument). That keeps booleans out of the engine's public number|null value
// domain. Chained comparisons (`a > b > c`) are rejected — comparison is not
// associative here. A STRING literal is legal ONLY as a direct =/!= operand at
// the top of an IF condition (`operand := STRING | expression`); everywhere else
// it is rejected.
// `IF`, `TODAY`, `SUM`, `IFBLANK`, `AND`, `OR`, `NOT` and `ISBLANK` are reserved
// words (case-insensitive): a bare same-record field with one of those names is
// no longer expressible; dotted paths like `if.x` / `sum.x` / `and.x` still are.
// TODAY() resolves to the current epoch-day (ADR 0012) via a caller-supplied
// evaluator option, not an engine-internal clock read. SUM(...) (ADR 0016)
// totals its non-null arguments. IFBLANK(value, fallback) (ADR 0017) substitutes
// a fallback for a null value; AND/OR/NOT/ISBLANK (ADR 0017) are condition-only
// combinators — used in a value context they raise a dedicated error.

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

  // Raised when a condition-only combinator (AND/OR/NOT/ISBLANK) appears in a
  // value context — the error users hit most while learning, e.g. AND(a>1, b>2)
  // at the top level or IF(x>1, NOT(y), 0). Mirrors comparisonOutsideConditionError.
  private conditionFunctionOutsideConditionError(token: Token): FormulaError {
    return new FormulaError(
      'PARSE_ERROR',
      `${token.fieldPath!.toUpperCase()}(...) is only allowed inside an IF condition`,
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
        // `sum` is likewise reserved (ADR 0016): followed by "(" it opens the
        // variadic SUM function; bare, it is no longer a legal field reference.
        if (token.fieldPath!.toLowerCase() === 'sum') {
          if (this.tokens[this.position + 1].type === 'LPAREN') {
            return this.parseSum();
          }
          throw new FormulaError(
            'PARSE_ERROR',
            '"SUM" is a reserved word — expected SUM(expr1, ..., exprN)',
            token.position,
          );
        }
        // AND/OR/NOT/ISBLANK (ADR 0017) are condition-only: reaching parsePrimary
        // means they are in a value context (top level, arithmetic, an IF branch,
        // a SUM/IFBLANK argument), which is always illegal — regardless of a
        // trailing "(" — so raise the dedicated condition-only error.
        {
          const lowered = token.fieldPath!.toLowerCase();
          if (
            lowered === 'and' ||
            lowered === 'or' ||
            lowered === 'not' ||
            lowered === 'isblank'
          ) {
            throw this.conditionFunctionOutsideConditionError(token);
          }
          // `ifblank` (ADR 0017) is a value-context function like SUM: followed
          // by "(" it opens IFBLANK(value, fallback); bare, it is reserved.
          if (lowered === 'ifblank') {
            if (this.tokens[this.position + 1].type === 'LPAREN') {
              return this.parseIfBlank();
            }
            throw new FormulaError(
              'PARSE_ERROR',
              '"IFBLANK" is a reserved word — expected IFBLANK(value, fallback)',
              token.position,
            );
          }
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

  // SUM(expr1, ..., exprN) — a reserved variadic function (ADR 0016). Requires
  // at least one argument (zero args is a PARSE_ERROR). Each argument is a
  // value-context expression parsed through parseExpression, so a comparison or
  // string literal inside an argument routes to the same condition-only
  // rejection it hits anywhere but an IF condition's top level. The SUM frame
  // counts against MAX_PARSE_DEPTH like IF, so nested SUMs are bounded.
  private parseSum(): AstNode {
    this.enter();
    this.advance(); // the SUM identifier
    this.advance(); // the '(' (presence checked by the caller)

    if (this.peek().type === 'RPAREN') {
      throw new FormulaError(
        'PARSE_ERROR',
        'SUM requires at least one argument: SUM(expr1, ..., exprN)',
        this.peek().position,
      );
    }

    const args: AstNode[] = [this.parseExpression()];
    while (this.peek().type === 'COMMA') {
      this.advance();
      args.push(this.parseExpression());
    }

    const closing = this.peek();
    if (closing.type !== 'RPAREN') {
      // A comparison stranded in an argument gets the condition-only message;
      // anything else is a missing closing parenthesis.
      if (isComparisonToken(closing)) {
        throw this.comparisonOutsideConditionError(closing);
      }
      throw new FormulaError(
        'PARSE_ERROR',
        'Missing closing parenthesis ")" after SUM arguments',
        closing.position,
      );
    }
    this.advance();

    this.leave();
    return { type: 'sum', args };
  }

  // IFBLANK(value, fallback) — a reserved value-context function (ADR 0017),
  // dispatched from parsePrimary exactly like SUM. Exactly two value-context
  // arguments; the arity errors mirror IF's "exactly 3 arguments" style.
  private parseIfBlank(): AstNode {
    this.enter();
    this.advance(); // the IFBLANK identifier
    this.advance(); // the '(' (presence checked by the caller)

    const value = this.parseExpression();

    const comma = this.peek();
    if (comma.type !== 'COMMA') {
      if (isComparisonToken(comma)) {
        throw this.comparisonOutsideConditionError(comma);
      }
      throw new FormulaError(
        'PARSE_ERROR',
        'IFBLANK requires exactly 2 arguments: IFBLANK(value, fallback)',
        comma.position,
      );
    }
    this.advance();

    const fallback = this.parseExpression();

    const closing = this.peek();
    if (closing.type !== 'RPAREN') {
      if (isComparisonToken(closing)) {
        throw this.comparisonOutsideConditionError(closing);
      }
      throw new FormulaError(
        'PARSE_ERROR',
        closing.type === 'COMMA'
          ? 'IFBLANK requires exactly 2 arguments: IFBLANK(value, fallback)'
          : 'Missing closing parenthesis ")" after IFBLANK arguments',
        closing.position,
      );
    }
    this.advance();

    this.leave();
    return { type: 'ifblank', value, fallback };
  }

  // AND(cond1, ..., condN) / OR(cond1, ..., condN) — reserved condition-only
  // combinators (ADR 0017), N >= 2. Each argument recurses into parseCondition,
  // so nesting (AND(OR(...), NOT(...))) and string comparisons as arguments both
  // work. The frame counts against MAX_PARSE_DEPTH like IF/SUM.
  private parseAndOr(type: 'and' | 'or'): AstNode {
    const name = type === 'and' ? 'AND' : 'OR';
    this.enter();
    this.advance(); // the AND/OR identifier
    this.advance(); // the '(' (presence checked by the caller)

    const args: AstNode[] = [this.parseCondition()];
    while (this.peek().type === 'COMMA') {
      this.advance();
      args.push(this.parseCondition());
    }

    if (args.length < 2) {
      throw new FormulaError(
        'PARSE_ERROR',
        `${name} requires at least 2 arguments: ${name}(cond1, ..., condN)`,
        this.peek().position,
      );
    }

    const closing = this.peek();
    if (closing.type !== 'RPAREN') {
      if (isComparisonToken(closing)) {
        throw this.comparisonOutsideConditionError(closing);
      }
      throw new FormulaError(
        'PARSE_ERROR',
        `Missing closing parenthesis ")" after ${name} arguments`,
        closing.position,
      );
    }
    this.advance();

    this.leave();
    return { type, args };
  }

  // NOT(cond) — reserved condition-only combinator (ADR 0017), exactly 1 arg.
  private parseNot(): AstNode {
    this.enter();
    this.advance(); // the NOT identifier
    this.advance(); // the '('

    const operand = this.parseCondition();

    const closing = this.peek();
    if (closing.type !== 'RPAREN') {
      if (closing.type === 'COMMA') {
        throw new FormulaError(
          'PARSE_ERROR',
          'NOT requires exactly 1 argument: NOT(cond)',
          closing.position,
        );
      }
      if (isComparisonToken(closing)) {
        throw this.comparisonOutsideConditionError(closing);
      }
      throw new FormulaError(
        'PARSE_ERROR',
        'Missing closing parenthesis ")" after NOT argument',
        closing.position,
      );
    }
    this.advance();

    this.leave();
    return { type: 'not', operand };
  }

  // ISBLANK(expr) — reserved condition-only function (ADR 0017), exactly 1
  // VALUE-context argument (parsed through parseExpression), so a comparison or
  // string literal inside it hits the same condition-only rejection as anywhere
  // but an IF condition's top level. Blankness is resolved in the evaluator.
  private parseIsBlank(): AstNode {
    this.enter();
    this.advance(); // the ISBLANK identifier
    this.advance(); // the '('

    const operand = this.parseExpression();

    const closing = this.peek();
    if (closing.type !== 'RPAREN') {
      if (closing.type === 'COMMA') {
        throw new FormulaError(
          'PARSE_ERROR',
          'ISBLANK requires exactly 1 argument: ISBLANK(value)',
          closing.position,
        );
      }
      if (isComparisonToken(closing)) {
        throw this.comparisonOutsideConditionError(closing);
      }
      throw new FormulaError(
        'PARSE_ERROR',
        'Missing closing parenthesis ")" after ISBLANK argument',
        closing.position,
      );
    }
    this.advance();

    this.leave();
    return { type: 'isblank', operand };
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

    // Condition-only combinators (ADR 0017) dispatch here at the top of a
    // condition. Bare use (`IF(and, 1, 0)`) is a reserved-word error distinct
    // from the value-context message parsePrimary raises. Dotted paths
    // (`and.total`) escape — the token's fieldPath is not the bare lexeme.
    const dispatch = this.peek();
    if (dispatch.type === 'FIELD') {
      const lowered = dispatch.fieldPath!.toLowerCase();
      if (
        lowered === 'and' ||
        lowered === 'or' ||
        lowered === 'not' ||
        lowered === 'isblank'
      ) {
        if (this.tokens[this.position + 1].type === 'LPAREN') {
          const node =
            lowered === 'and' || lowered === 'or'
              ? this.parseAndOr(lowered)
              : lowered === 'not'
                ? this.parseNot()
                : this.parseIsBlank();
          this.leave();
          return node;
        }
        const expected =
          lowered === 'not'
            ? 'NOT(cond)'
            : lowered === 'isblank'
              ? 'ISBLANK(value)'
              : `${lowered.toUpperCase()}(cond1, ..., condN)`;
        throw new FormulaError(
          'PARSE_ERROR',
          `"${lowered.toUpperCase()}" is a reserved word — expected ${expected}`,
          dispatch.position,
        );
      }
    }

    // A string operand is exactly one token, so if `left` comes back as a
    // StringNode this peeked token IS the literal — kept for error positions.
    const leftToken = this.peek();
    const left = this.parseConditionOperand();

    const operatorToken = this.peek();
    const operator = COMPARISON_TOKEN_TO_OPERATOR[operatorToken.type];

    if (operator === undefined) {
      // Numeric condition (Excel truthiness): 0 = false, nonzero = true. A lone
      // string here is not beside = / != (e.g. IF("a", 1, 2)), so it is
      // illegal, reported at the literal's opening quote.
      if (left.type === 'string') {
        throw this.stringOutsideConditionError(leftToken);
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
