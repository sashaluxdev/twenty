import {
  type AstNode,
  type BinaryOperator,
  type ComparisonOperator,
} from 'src/engine/ast';
import { parseDateOnlyToEpochDays } from 'src/engine/date-serial';
import { FormulaError } from 'src/engine/errors';
import { type Token, type TokenType, tokenize } from 'src/engine/tokenizer';

// Recursive-descent parser. Precedence, loosest value tier first:
//
//   concat       := expression ('&' expression)*
//   expression   := term (('+' | '-') term)*
//   term         := unary (('*' | '/' | '%') unary)*
//   unary        := ('+' | '-') unary | primary
//   primary      := NUMBER | STRING | FIELD | CROSSREF | if | today | sum
//                 | ifblank | ifs | switch | numbercast | textcast
//                 | dateliteral | '(' concat ')'
//   if           := IF '(' condition ',' concat ',' concat ')'
//   today        := TODAY '(' ')'
//   sum          := SUM '(' concat (',' concat)* ')'
//   ifblank      := IFBLANK '(' concat ',' concat ')'
//   ifs          := IFS '(' condition ',' concat
//                       (',' condition ',' concat)* (',' concat)? ')'
//   switch       := SWITCH '(' concat (',' concat ',' concat)+
//                       (',' concat)? ')'
//   numbercast   := NUMBER '(' concat ')'
//   textcast     := TEXT '(' concat ')'
//   dateliteral  := DATE '(' STRING ')'
//   condition    := boolFunction | concat (compareOp concat)?
//   boolFunction := AND '(' condition (',' condition)+ ')'
//                 | OR  '(' condition (',' condition)+ ')'
//                 | NOT '(' condition ')'
//                 | ISBLANK '(' concat ')'
//   compareOp    := '>' | '<' | '>=' | '<=' | '=' | '==' | '!='
//
// Left-associative binary operators; unary binds tighter than binary but looser
// than parentheses; '&' is looser than every arithmetic operator but tighter
// than a comparison, so `a & "-" = code` compares the concatenation. Any
// leftover tokens after a complete expression are an error (rejects trailing
// garbage like "1 2" or "a)").
//
// Comparisons and the AND/OR/NOT/ISBLANK combinators are TRANSIENT: `condition`
// is reachable ONLY as IF's first argument (and recursively inside a combinator's
// arguments), so none of them can appear where a value is expected (top level,
// arithmetic, then/else branches, a comparison operand, or a SUM/IFBLANK
// argument). That keeps booleans out of the engine's public value domain.
// Chained comparisons (`a > b > c`) are rejected — comparison is not associative
// here. A STRING literal is a legal primary anywhere a value is, EXCEPT beside
// an ordering operator, where it could only ever be a type error.
// `IF`, `TODAY`, `SUM`, `IFBLANK`, `AND`, `OR`, `NOT`, `ISBLANK`, `IFS` and
// `SWITCH` are reserved words (case-insensitive): a bare same-record field with
// one of those names is no longer expressible; dotted paths like `if.x` /
// `sum.x` / `and.x` / `ifs.x` / `switch.x` still are.
// TODAY() resolves to the current epoch-day (ADR 0012) via a caller-supplied
// evaluator option, not an engine-internal clock read. SUM(...) (ADR 0016)
// totals its non-null arguments. IFBLANK(value, fallback) (ADR 0017) substitutes
// a fallback for a BLANK value — null, or empty/whitespace-only text after ADR
// 0026 widened it; AND/OR/NOT/ISBLANK (ADR 0017) are condition-only
// combinators — used in a value context they raise a dedicated error. IFS and
// SWITCH (ADR 0018) are pure value-context sugar: they desugar during parsing
// into nested IfNodes (a NullNode else when no default is given), so the AST the
// evaluator, dependency walker, and save-time validator see is just IFs — no
// IFS/SWITCH node type exists at runtime.
// `NUMBER`, `TEXT` and `DATE` (strict-typing arc) are reserved ONLY by
// lookahead (case-insensitive): followed immediately by "(" they dispatch as
// the cast/literal function; bare, or dotted (`date.x`), they remain ordinary
// field references — unlike every other reserved word above, which errors on
// bare use. DATE("YYYY-MM-DD") constant-folds to a DateLiteralNode at parse
// time; NUMBER(x)/TEXT(x) produce cast nodes resolved at evaluation.

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
    const node = this.parseConcat();

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

  // The loosest value tier: every value context enters the grammar here, so a
  // concatenation is expressible wherever a number is. A chain flattens into one
  // ConcatNode rather than nesting, keeping `a & b & c & ...` at constant AST
  // depth; a lone operand is returned unchanged so ASTs without '&' are
  // byte-identical to what the pre-concat grammar produced.
  private parseConcat(): AstNode {
    this.enter();
    const first = this.parseExpression();

    if (this.peek().type !== 'AMPERSAND') {
      this.leave();
      return first;
    }

    const parts: AstNode[] = [first];
    while (this.peek().type === 'AMPERSAND') {
      this.advance();
      parts.push(this.parseExpression());
    }

    this.leave();
    return { type: 'concat', parts };
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
        // `number` / `text` / `date` (strict-typing arc) dispatch as functions
        // ONLY when immediately followed by "(" — a LOOKAHEAD-ONLY reservation,
        // deliberately different from IF/TODAY/SUM/IFS/SWITCH above, which are
        // hard-reserved (bare use is always an error). These three names are
        // common field names in real workspaces (a "date" or "text" field is
        // unremarkable), so a bare reference falls through to the ordinary
        // field-reference path below instead of erroring.
        if (token.fieldPath!.toLowerCase() === 'number') {
          if (this.tokens[this.position + 1].type === 'LPAREN') {
            return this.parseNumberCast();
          }
        } else if (token.fieldPath!.toLowerCase() === 'text') {
          if (this.tokens[this.position + 1].type === 'LPAREN') {
            return this.parseTextCast();
          }
        } else if (token.fieldPath!.toLowerCase() === 'date') {
          if (this.tokens[this.position + 1].type === 'LPAREN') {
            return this.parseDateLiteral();
          }
        }
        // `ifs` / `switch` (ADR 0018) are reserved value-context functions,
        // dispatched from parsePrimary exactly like SUM/IFBLANK: a ladder
        // produces a number. Bare, they are reserved; dotted paths (`ifs.x`)
        // escape because the token's fieldPath is not the bare lexeme.
        if (token.fieldPath!.toLowerCase() === 'ifs') {
          if (this.tokens[this.position + 1].type === 'LPAREN') {
            return this.parseIfs();
          }
          throw new FormulaError(
            'PARSE_ERROR',
            '"IFS" is a reserved word — expected IFS(cond1, value1, ..., [default])',
            token.position,
          );
        }
        if (token.fieldPath!.toLowerCase() === 'switch') {
          if (this.tokens[this.position + 1].type === 'LPAREN') {
            return this.parseSwitch();
          }
          throw new FormulaError(
            'PARSE_ERROR',
            '"SWITCH" is a reserved word — expected SWITCH(expr, key1, value1, ..., [default])',
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

      case 'STRING':
        this.advance();
        // An empty literal ("") carries stringValue '' — the ?? guards a token
        // built without one, never a legitimately empty literal.
        return { type: 'string', value: token.stringValue ?? '' };

      case 'LPAREN': {
        this.advance();
        // Parenthesised sub-expression: recurse through parseConcat (parens are
        // a full value context, so `("a" & b) * 2` parses), which increments the
        // parse-depth guard so nested "(((...)))" is bounded.
        const inner = this.parseConcat();
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
    // IF arguments nest through parseConcat/parseCondition, but the IF frame
    // itself must also count against parse depth so a chain of nested IFs is
    // bounded the same way nested parentheses are.
    this.enter();
    this.advance(); // the IF identifier
    this.advance(); // the '(' (presence checked by the caller)

    const condition = this.parseCondition();
    this.expectIfArgumentComma();
    const thenBranch = this.parseConcat();
    this.expectIfArgumentComma();
    const elseBranch = this.parseConcat();

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
  // value-context expression parsed through parseConcat, so a comparison inside
  // an argument routes to the same condition-only rejection it hits anywhere but
  // an IF condition's top level. The SUM frame counts against MAX_PARSE_DEPTH
  // like IF, so nested SUMs are bounded.
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

    const args: AstNode[] = [this.parseConcat()];
    while (this.peek().type === 'COMMA') {
      this.advance();
      args.push(this.parseConcat());
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

  // NUMBER(value) — a lookahead-reserved cast (strict-typing arc), single
  // value-context argument. Mirrors parseIsBlank's single-argument structure.
  private parseNumberCast(): AstNode {
    this.enter();
    this.advance(); // the NUMBER identifier
    this.advance(); // the '(' (presence checked by the caller)

    const operand = this.parseConcat();

    const closing = this.peek();
    if (closing.type !== 'RPAREN') {
      if (closing.type === 'COMMA') {
        throw new FormulaError(
          'PARSE_ERROR',
          'NUMBER requires exactly 1 argument: NUMBER(value)',
          closing.position,
        );
      }
      if (isComparisonToken(closing)) {
        throw this.comparisonOutsideConditionError(closing);
      }
      throw new FormulaError(
        'PARSE_ERROR',
        'Missing closing parenthesis ")" after NUMBER argument',
        closing.position,
      );
    }
    this.advance();

    this.leave();
    return { type: 'numbercast', operand };
  }

  // TEXT(value) — a lookahead-reserved cast (strict-typing arc), single
  // value-context argument. `renderAs` is left unset here; kind inference
  // (Task 2) stamps it once the operand's kind is known statically.
  private parseTextCast(): AstNode {
    this.enter();
    this.advance(); // the TEXT identifier
    this.advance(); // the '(' (presence checked by the caller)

    const operand = this.parseConcat();

    const closing = this.peek();
    if (closing.type !== 'RPAREN') {
      if (closing.type === 'COMMA') {
        throw new FormulaError(
          'PARSE_ERROR',
          'TEXT requires exactly 1 argument: TEXT(value)',
          closing.position,
        );
      }
      if (isComparisonToken(closing)) {
        throw this.comparisonOutsideConditionError(closing);
      }
      throw new FormulaError(
        'PARSE_ERROR',
        'Missing closing parenthesis ")" after TEXT argument',
        closing.position,
      );
    }
    this.advance();

    this.leave();
    return { type: 'textcast', operand };
  }

  // DATE("YYYY-MM-DD") — a lookahead-reserved literal (strict-typing arc) that
  // constant-folds at parse time (IFS/SWITCH foldLadder precedent: as much
  // semantics as possible is resolved here, not at evaluation). Unlike
  // NUMBER/TEXT, the argument is not a general expression — it must be a
  // literal STRING token — so there is nothing to recurse into and no depth
  // frame to guard (TODAY() precedent).
  private parseDateLiteral(): AstNode {
    this.advance(); // the DATE identifier
    this.advance(); // the '(' (presence checked by the caller)

    const invalidLiteralError = (position?: number): FormulaError =>
      new FormulaError(
        'PARSE_ERROR',
        'DATE() requires a literal "YYYY-MM-DD" date',
        position,
      );

    const literalToken = this.peek();
    if (literalToken.type !== 'STRING') {
      throw invalidLiteralError(literalToken.position);
    }
    this.advance();

    const literal = literalToken.stringValue ?? '';
    let value: number;
    try {
      value = parseDateOnlyToEpochDays(literal);
    } catch {
      throw invalidLiteralError(literalToken.position);
    }

    const closing = this.peek();
    if (closing.type !== 'RPAREN') {
      throw invalidLiteralError(closing.position);
    }
    this.advance();

    return { type: 'dateliteral', value, literal };
  }

  // IFBLANK(value, fallback) — a reserved value-context function (ADR 0017),
  // dispatched from parsePrimary exactly like SUM. Exactly two value-context
  // arguments; the arity errors mirror IF's "exactly 3 arguments" style.
  private parseIfBlank(): AstNode {
    this.enter();
    this.advance(); // the IFBLANK identifier
    this.advance(); // the '(' (presence checked by the caller)

    const value = this.parseConcat();

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

    const fallback = this.parseConcat();

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

  // A condition-only node (comparison or an ADR 0017 combinator). Used to reject
  // one in the trailing-default slot of an IFS ladder: the default is a VALUE,
  // but it is collected via parseCondition (the loop cannot know in advance
  // whether an arg is a rung condition or the default), so a comparison /
  // AND/OR/NOT/ISBLANK landing there means the user wrote a condition where a
  // value is required — the same illegality every other value context enforces.
  private isConditionOnlyNode(node: AstNode): boolean {
    return (
      node.type === 'comparison' ||
      node.type === 'and' ||
      node.type === 'or' ||
      node.type === 'not' ||
      node.type === 'isblank'
    );
  }

  // Right-folds collected (condition/key -> value) rungs into nested IfNodes,
  // innermost else being the default (or a NullNode when none was given). This
  // IS the whole of IFS/SWITCH semantics — every property (lazy short-circuit,
  // null propagation, eager dependencies, save-time validation) is inherited
  // from IfNode, so the engine needs no IFS/SWITCH-specific evaluation rule.
  private foldLadder(
    rungs: { condition: AstNode; value: AstNode }[],
    defaultNode: AstNode | null,
  ): AstNode {
    let node: AstNode = defaultNode ?? { type: 'null' };
    for (let i = rungs.length - 1; i >= 0; i -= 1) {
      node = {
        type: 'if',
        condition: rungs[i].condition,
        then: rungs[i].value,
        else: node,
      };
    }
    return node;
  }

  // IFS(cond1, value1, ..., [default]) — reserved value-context sugar (ADR 0018)
  // desugared entirely here into nested IfNodes. Each rung's condition parses via
  // parseCondition (so ADR 0017 AND/OR/NOT/ISBLANK work), each value via
  // parseConcat. N even -> no default; N odd -> the last arg is the default.
  // One enter() per rung mirrors the desugared nested-IF frames, so a long ladder
  // trips MAX_PARSE_DEPTH exactly as the equivalent hand-written IF chain would.
  private parseIfs(): AstNode {
    this.advance(); // the IFS identifier
    this.advance(); // the '(' (presence checked by the caller)

    const pairMessage = 'IFS requires at least one condition/value pair';

    if (this.peek().type === 'RPAREN') {
      throw new FormulaError('PARSE_ERROR', pairMessage, this.peek().position);
    }

    const rungs: { condition: AstNode; value: AstNode }[] = [];
    let defaultNode: AstNode | null = null;
    let frames = 0;

    for (;;) {
      const argToken = this.peek();
      const condition = this.parseCondition();

      if (this.peek().type === 'COMMA') {
        this.advance();
        const value = this.parseConcat();
        this.enter();
        frames += 1;
        rungs.push({ condition, value });
      } else {
        // No comma after this arg: it is the trailing default (a value slot).
        // A comparison/combinator here is a condition in a value slot — reject.
        if (this.isConditionOnlyNode(condition)) {
          throw this.comparisonOutsideConditionError(argToken);
        }
        defaultNode = condition;
        break;
      }

      if (this.peek().type !== 'COMMA') {
        break;
      }
      this.advance();
    }

    if (rungs.length === 0) {
      throw new FormulaError('PARSE_ERROR', pairMessage, this.peek().position);
    }

    const closing = this.peek();
    if (closing.type !== 'RPAREN') {
      if (isComparisonToken(closing)) {
        throw this.comparisonOutsideConditionError(closing);
      }
      throw new FormulaError(
        'PARSE_ERROR',
        'Missing closing parenthesis ")" after IFS arguments',
        closing.position,
      );
    }
    this.advance();

    for (let i = 0; i < frames; i += 1) {
      this.leave();
    }

    return this.foldLadder(rungs, defaultNode);
  }

  // SWITCH(expr, key1, value1, ..., [default]) — reserved value-context sugar
  // (ADR 0018) desugared into nested `IF(expr = key, value, ...)` IfNodes. Every
  // slot — `expr`, each `key`, each value, the default — parses via parseConcat,
  // the same value grammar every other value context uses. N even ->
  // the last arg is the default; N odd -> no default. `expr` is shared by
  // reference across every rung's comparison (pure, so re-evaluation is harmless;
  // dependency extraction dedupes) — see ADR 0018 caveat 1.
  private parseSwitch(): AstNode {
    this.advance(); // the SWITCH identifier
    this.advance(); // the '(' (presence checked by the caller)

    const pairMessage =
      'SWITCH requires an expression and at least one key/value pair';

    if (this.peek().type === 'RPAREN') {
      throw new FormulaError('PARSE_ERROR', pairMessage, this.peek().position);
    }

    const subject = this.parseConcat();

    if (this.peek().type !== 'COMMA') {
      throw new FormulaError('PARSE_ERROR', pairMessage, this.peek().position);
    }

    const rungs: { condition: AstNode; value: AstNode }[] = [];
    let defaultNode: AstNode | null = null;
    let frames = 0;

    for (;;) {
      this.advance(); // the comma before a key or the trailing default
      const key = this.parseConcat();

      if (this.peek().type === 'COMMA') {
        this.advance();
        const value = this.parseConcat();
        this.enter();
        frames += 1;
        rungs.push({
          condition: { type: 'comparison', operator: '=', left: subject, right: key },
          value,
        });
      } else {
        // No comma after this arg: it is the trailing default (a value slot).
        defaultNode = key;
        break;
      }

      if (this.peek().type !== 'COMMA') {
        break;
      }
    }

    if (rungs.length === 0) {
      throw new FormulaError('PARSE_ERROR', pairMessage, this.peek().position);
    }

    const closing = this.peek();
    if (closing.type !== 'RPAREN') {
      if (isComparisonToken(closing)) {
        throw this.comparisonOutsideConditionError(closing);
      }
      throw new FormulaError(
        'PARSE_ERROR',
        'Missing closing parenthesis ")" after SWITCH arguments',
        closing.position,
      );
    }
    this.advance();

    for (let i = 0; i < frames; i += 1) {
      this.leave();
    }

    return this.foldLadder(rungs, defaultNode);
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

    // Zero arguments: report the arity requirement directly instead of letting
    // parseCondition trip over the RPAREN with a generic "Unexpected token )".
    // Mirrors the friendly message the 1-argument case gets below.
    if (this.peek().type === 'RPAREN') {
      throw new FormulaError(
        'PARSE_ERROR',
        `${name} requires at least 2 arguments: ${name}(cond1, ..., condN)`,
        this.peek().position,
      );
    }

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
  // VALUE-context argument (parsed through parseConcat), so a comparison inside
  // it hits the same condition-only rejection as anywhere but an IF condition's
  // top level. Blankness is resolved in the evaluator.
  private parseIsBlank(): AstNode {
    this.enter();
    this.advance(); // the ISBLANK identifier
    this.advance(); // the '('

    const operand = this.parseConcat();

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

  // The ONLY place a comparison may appear: the top level of IF's first
  // argument. Operands are full value expressions (parseConcat), so a string
  // literal or a concatenation is a legal operand; a second comparison operator
  // after a complete comparison is a chained comparison, rejected.
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

    const left = this.parseConcat();

    const operatorToken = this.peek();
    const operator = COMPARISON_TOKEN_TO_OPERATOR[operatorToken.type];

    if (operator === undefined) {
      // No operator: the value itself is the condition (Excel truthiness).
      this.leave();
      return left;
    }

    this.advance();
    const right = this.parseConcat();

    // Strings compare only for (in)equality: an ordering operator with a
    // syntactic string operand is a type error surfaced at the operator itself.
    // Only a DIRECT literal is provably text at parse time — a concat result or
    // a field can be anything, so those are left to the evaluator.
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
