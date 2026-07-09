import { describe, expect, it } from 'vitest';

import { type AstNode } from 'src/engine/ast';
import { FormulaError } from 'src/engine/errors';
import { parse } from 'src/engine/parser';

// Fully evaluate a constant AST so precedence can be asserted by result rather
// than by matching node shapes. Variable-free, so no resolver is needed.
const evalConst = (node: AstNode): number => {
  switch (node.type) {
    case 'number':
      return node.value;
    case 'unary':
      return node.operator === '-'
        ? -evalConst(node.operand)
        : evalConst(node.operand);
    case 'binary': {
      const left = evalConst(node.left);
      const right = evalConst(node.right);
      switch (node.operator) {
        case '+':
          return left + right;
        case '-':
          return left - right;
        case '*':
          return left * right;
        case '/':
          return left / right;
        case '%':
          return left % right;
      }
    }
    // eslint-disable-next-line no-fallthrough
    default:
      throw new Error('variable in constant expression');
  }
};

describe('parser precedence & associativity', () => {
  it('multiplies before adding', () => {
    expect(evalConst(parse('1 + 2 * 3'))).toBe(7);
  });

  it('honors parentheses', () => {
    expect(evalConst(parse('(1 + 2) * 3'))).toBe(9);
  });

  it('is left-associative for subtraction', () => {
    expect(evalConst(parse('10 - 3 - 2'))).toBe(5);
  });

  it('is left-associative for division', () => {
    expect(evalConst(parse('100 / 5 / 2'))).toBe(10);
  });

  it('handles modulo at multiplicative precedence', () => {
    expect(evalConst(parse('10 + 7 % 3'))).toBe(11);
  });

  it('applies unary minus', () => {
    expect(evalConst(parse('-5 + 3'))).toBe(-2);
    expect(evalConst(parse('3 * -2'))).toBe(-6);
    expect(evalConst(parse('--5'))).toBe(5);
  });

  it('handles deep nesting', () => {
    expect(evalConst(parse('((((1 + 1))))'))).toBe(2);
  });

  it('builds field and crossref nodes', () => {
    const uuid = '20202020-1c25-4d02-bf25-6aeccf7ea419';
    const ast = parse(`inputA + [company:${uuid}:employees]`);
    expect(ast.type).toBe('binary');
    if (ast.type === 'binary') {
      expect(ast.left).toEqual({ type: 'field', path: 'inputA' });
      expect(ast.right).toEqual({
        type: 'crossref',
        ref: { object: 'company', recordId: uuid, fieldPath: 'employees' },
      });
    }
  });

  it('builds a crossref node when the field segment is a reserved word like "today"', () => {
    const uuid = '20202020-1c25-4d02-bf25-6aeccf7ea419';
    const ast = parse(`[company:${uuid}:today]`);
    expect(ast).toEqual({
      type: 'crossref',
      ref: { object: 'company', recordId: uuid, fieldPath: 'today' },
    });
  });
});

describe('parser IF conditionals', () => {
  it('should parse IF(condition, then, else) into an if node when the condition is a comparison', () => {
    const ast = parse('IF(inputA > 9, inputA + inputB, inputA)');
    expect(ast.type).toBe('if');
    if (ast.type === 'if') {
      expect(ast.condition).toEqual({
        type: 'comparison',
        operator: '>',
        left: { type: 'field', path: 'inputA' },
        right: { type: 'number', value: 9 },
      });
      expect(ast.then.type).toBe('binary');
      expect(ast.else).toEqual({ type: 'field', path: 'inputA' });
    }
  });

  it('should accept the keyword case-insensitively when written as if or If', () => {
    expect(parse('if(1, 2, 3)').type).toBe('if');
    expect(parse('If(1, 2, 3)').type).toBe('if');
    expect(parse('IF(1, 2, 3)').type).toBe('if');
  });

  it('should normalize == to = when building the comparison node', () => {
    const ast = parse('IF(a == b, 1, 0)');
    if (ast.type === 'if' && ast.condition.type === 'comparison') {
      expect(ast.condition.operator).toBe('=');
    } else {
      throw new Error('expected an if node with a comparison condition');
    }
  });

  it('should accept a plain numeric condition when no comparison is written', () => {
    const ast = parse('IF(inputA, 1, 2)');
    if (ast.type === 'if') {
      expect(ast.condition).toEqual({ type: 'field', path: 'inputA' });
    } else {
      throw new Error('expected an if node');
    }
  });

  it('should parse nested IF in branches and in the condition operands', () => {
    const nestedInBranch = parse('IF(a > 1, IF(b > 2, 1, 2), IF(c > 3, 3, 4))');
    expect(nestedInBranch.type).toBe('if');

    // A nested IF is a primary, so it is legal INSIDE a comparison operand.
    const nestedInCondition = parse('IF(IF(a > 1, 1, 0) = 1, 10, 20)');
    expect(nestedInCondition.type).toBe('if');
  });

  it('should give arithmetic precedence over comparison so a + b > c * 2 groups as (a+b) > (c*2)', () => {
    const ast = parse('IF(a + b > c * 2, 1, 0)');
    if (ast.type === 'if' && ast.condition.type === 'comparison') {
      expect(ast.condition.left).toMatchObject({ type: 'binary', operator: '+' });
      expect(ast.condition.right).toMatchObject({ type: 'binary', operator: '*' });
    } else {
      throw new Error('expected an if node with a comparison condition');
    }
  });

  it('should reject IF with 2 arguments when the else branch is missing', () => {
    expect(() => parse('IF(a > 1, 2)')).toThrowError(/exactly 3 arguments/);
  });

  it('should reject IF with 4 arguments when an extra argument is supplied', () => {
    expect(() => parse('IF(a > 1, 2, 3, 4)')).toThrowError(/exactly 3 arguments/);
  });

  it('should reject a bare "if" when it is not followed by parentheses', () => {
    expect(() => parse('if + 1')).toThrowError(/reserved word/);
    expect(() => parse('if')).toThrowError(/reserved word/);
  });

  it('should reject an unterminated IF when the closing parenthesis is missing', () => {
    expect(() => parse('IF(1, 2, 3')).toThrowError(/closing parenthesis/);
  });
});

describe('parser TODAY()', () => {
  it('should parse TODAY() into a today node', () => {
    expect(parse('TODAY()')).toEqual({ type: 'today' });
  });

  it('should accept the keyword case-insensitively when written as today or Today', () => {
    expect(parse('today()')).toEqual({ type: 'today' });
    expect(parse('Today()')).toEqual({ type: 'today' });
  });

  it('should tolerate whitespace between TODAY and its parentheses', () => {
    expect(parse('TODAY ()')).toEqual({ type: 'today' });
  });

  it('should compose with arithmetic and comparisons', () => {
    const ast = parse('TODAY() + 100');
    expect(ast).toEqual({
      type: 'binary',
      operator: '+',
      left: { type: 'today' },
      right: { type: 'number', value: 100 },
    });

    const ifAst = parse('IF(startDate > TODAY() + 100, 1, 0)');
    expect(ifAst.type).toBe('if');
    if (ifAst.type === 'if' && ifAst.condition.type === 'comparison') {
      expect(ifAst.condition.right).toEqual({
        type: 'binary',
        operator: '+',
        left: { type: 'today' },
        right: { type: 'number', value: 100 },
      });
    } else {
      throw new Error('expected an if node with a comparison condition');
    }
  });

  it('should still allow a dotted field path starting with "today"', () => {
    expect(parse('today.value')).toEqual({ type: 'field', path: 'today.value' });
  });

  it('should reject a bare "today" when it is not followed by parentheses', () => {
    expect(() => parse('today + 1')).toThrowError(/reserved word/);
    expect(() => parse('today')).toThrowError(/reserved word/);
  });

  it('should reject TODAY called with arguments', () => {
    expect(() => parse('TODAY(1)')).toThrowError(/takes no arguments/);
  });

  it('should reject an unterminated TODAY when the closing parenthesis is missing', () => {
    expect(() => parse('TODAY(')).toThrowError(/takes no arguments/);
  });
});

describe('parser SUM()', () => {
  it('should parse a single-argument SUM into a sum node (arity >= 1)', () => {
    expect(parse('SUM(a)')).toEqual({
      type: 'sum',
      args: [{ type: 'field', path: 'a' }],
    });
  });

  it('should parse a multi-argument SUM preserving argument order', () => {
    expect(parse('SUM(a, b, 3)')).toEqual({
      type: 'sum',
      args: [
        { type: 'field', path: 'a' },
        { type: 'field', path: 'b' },
        { type: 'number', value: 3 },
      ],
    });
  });

  it('should accept the keyword case-insensitively when written as sum or Sum', () => {
    expect(parse('sum(1)')).toEqual({ type: 'sum', args: [{ type: 'number', value: 1 }] });
    expect(parse('Sum(1)')).toEqual({ type: 'sum', args: [{ type: 'number', value: 1 }] });
  });

  it('should tolerate whitespace between SUM and its parentheses', () => {
    expect(parse('SUM (1)')).toEqual({ type: 'sum', args: [{ type: 'number', value: 1 }] });
  });

  it('should allow value-context expressions as arguments', () => {
    expect(parse('SUM(a + 1, b * 2)')).toEqual({
      type: 'sum',
      args: [
        {
          type: 'binary',
          operator: '+',
          left: { type: 'field', path: 'a' },
          right: { type: 'number', value: 1 },
        },
        {
          type: 'binary',
          operator: '*',
          left: { type: 'field', path: 'b' },
          right: { type: 'number', value: 2 },
        },
      ],
    });
  });

  it('should reject SUM with zero arguments', () => {
    expect(() => parse('SUM()')).toThrowError(/at least one argument/);
  });

  it('should reject a bare "sum" when it is not followed by parentheses', () => {
    expect(() => parse('sum + 1')).toThrowError(/reserved word/);
    expect(() => parse('sum')).toThrowError(/reserved word/);
  });

  it('should still allow a dotted field path starting with "sum"', () => {
    expect(parse('sum.value')).toEqual({ type: 'field', path: 'sum.value' });
  });

  it('should treat "sum" inside a cross-record reference as a plain field path', () => {
    const uuid = '20202020-1c25-4d02-bf25-6aeccf7ea419';
    expect(parse(`[company:${uuid}:sum]`)).toEqual({
      type: 'crossref',
      ref: { object: 'company', recordId: uuid, fieldPath: 'sum' },
    });
  });

  it('should reject an unterminated SUM when the closing parenthesis is missing', () => {
    expect(() => parse('SUM(1')).toThrowError(/closing parenthesis/);
  });

  it('should nest SUM inside and around IF', () => {
    const outer = parse('SUM(IF(a > 1, b, c), d)');
    expect(outer.type).toBe('sum');

    const inner = parse('IF(a > 1, SUM(b, c), 0)');
    expect(inner.type).toBe('if');
    if (inner.type === 'if') {
      expect(inner.then.type).toBe('sum');
    }
  });

  it('should reject a comparison inside a SUM argument (value context, not a condition)', () => {
    expect(() => parse('SUM(a > b)')).toThrowError(/only allowed in the condition/);
    expect(() => parse('SUM(1, a = 2)')).toThrowError(/only allowed in the condition/);
  });

  it('should reject a bare string literal inside a SUM argument', () => {
    expect(() => parse('SUM("x")')).toThrowError(/String literals are only allowed/);
  });
});

describe('parser boolean condition functions (ADR 0017)', () => {
  const UUID = '20202020-1c25-4d02-bf25-6aeccf7ea419';

  it('should parse AND with two comparison arguments into an and node', () => {
    expect(parse('IF(AND(a > 1, b < 2), 1, 0)')).toEqual({
      type: 'if',
      condition: {
        type: 'and',
        args: [
          {
            type: 'comparison',
            operator: '>',
            left: { type: 'field', path: 'a' },
            right: { type: 'number', value: 1 },
          },
          {
            type: 'comparison',
            operator: '<',
            left: { type: 'field', path: 'b' },
            right: { type: 'number', value: 2 },
          },
        ],
      },
      then: { type: 'number', value: 1 },
      else: { type: 'number', value: 0 },
    });
  });

  it('should parse variadic AND/OR with three or more arguments', () => {
    const and = parse('IF(AND(a > 1, b > 1, c > 1), 1, 0)');
    if (and.type === 'if' && and.condition.type === 'and') {
      expect(and.condition.args).toHaveLength(3);
    } else {
      throw new Error('expected AND node with 3 args');
    }
    const or = parse('IF(OR(a > 1, b > 1, c > 1), 1, 0)');
    if (or.type === 'if' && or.condition.type === 'or') {
      expect(or.condition.args).toHaveLength(3);
    } else {
      throw new Error('expected OR node with 3 args');
    }
  });

  it('should parse NOT with exactly one condition argument', () => {
    expect(parse('IF(NOT(a > 1), 1, 0)')).toEqual({
      type: 'if',
      condition: {
        type: 'not',
        operand: {
          type: 'comparison',
          operator: '>',
          left: { type: 'field', path: 'a' },
          right: { type: 'number', value: 1 },
        },
      },
      then: { type: 'number', value: 1 },
      else: { type: 'number', value: 0 },
    });
  });

  it('should parse ISBLANK with a value-context field argument', () => {
    expect(parse('IF(ISBLANK(email), 1, 0)')).toEqual({
      type: 'if',
      condition: {
        type: 'isblank',
        operand: { type: 'field', path: 'email' },
      },
      then: { type: 'number', value: 1 },
      else: { type: 'number', value: 0 },
    });
  });

  it('should allow an arithmetic expression as the ISBLANK argument', () => {
    const node = parse('IF(ISBLANK(a + b), 1, 0)');
    if (node.type === 'if' && node.condition.type === 'isblank') {
      expect(node.condition.operand.type).toBe('binary');
    } else {
      throw new Error('expected ISBLANK over a binary node');
    }
  });

  it('should nest combinators arbitrarily (AND(OR(...), NOT(...)))', () => {
    const node = parse('IF(AND(OR(a > 1, b > 2), NOT(c = 0)), 1, 0)');
    expect(node.type).toBe('if');
    if (node.type === 'if') {
      expect(node.condition.type).toBe('and');
      if (node.condition.type === 'and') {
        expect(node.condition.args[0].type).toBe('or');
        expect(node.condition.args[1].type).toBe('not');
      }
    }
  });

  it('should accept the keywords case-insensitively', () => {
    expect(() => parse('IF(and(a > 1, b > 2), 1, 0)')).not.toThrow();
    expect(() => parse('IF(Or(a > 1, b > 2), 1, 0)')).not.toThrow();
    expect(() => parse('IF(Not(a > 1), 1, 0)')).not.toThrow();
    expect(() => parse('IF(isblank(a), 1, 0)')).not.toThrow();
  });

  it('should tolerate whitespace between the keyword and its parentheses', () => {
    expect(() => parse('IF(AND (a > 1, b > 2), 1, 0)')).not.toThrow();
    expect(() => parse('IF(NOT (a > 1), 1, 0)')).not.toThrow();
  });

  it('should reject AND/OR with fewer than 2 arguments', () => {
    expect(() => parse('IF(AND(a > 1), 1, 0)')).toThrowError(
      /AND requires at least 2 arguments/,
    );
    expect(() => parse('IF(OR(a > 1), 1, 0)')).toThrowError(
      /OR requires at least 2 arguments/,
    );
  });

  it('should reject AND/OR with ZERO arguments with the same friendly arity message', () => {
    // The empty-argument case must report the arity requirement, not a generic
    // "Unexpected token )" from trying to parse a condition off the RPAREN.
    expect(() => parse('IF(AND(), 1, 0)')).toThrowError(
      /AND requires at least 2 arguments/,
    );
    expect(() => parse('IF(OR(), 1, 0)')).toThrowError(
      /OR requires at least 2 arguments/,
    );
  });

  it('should reject NOT with zero or more than one argument', () => {
    expect(() => parse('IF(NOT(), 1, 0)')).toThrowError(/PARSE_ERROR|Unexpected/);
    expect(() => parse('IF(NOT(a > 1, b > 2), 1, 0)')).toThrowError(
      /NOT requires exactly 1 argument/,
    );
  });

  it('should reject ISBLANK with zero or more than one argument', () => {
    expect(() => parse('IF(ISBLANK(), 1, 0)')).toThrowError(/PARSE_ERROR|Unexpected/);
    expect(() => parse('IF(ISBLANK(a, b), 1, 0)')).toThrowError(
      /ISBLANK requires exactly 1 argument/,
    );
  });

  it('should reject the condition functions in a value context (not inside an IF condition)', () => {
    expect(() => parse('AND(a > 1, b > 2)')).toThrowError(
      /AND\(\.\.\.\) is only allowed inside an IF condition/,
    );
    expect(() => parse('OR(a > 1, b > 2)')).toThrowError(
      /OR\(\.\.\.\) is only allowed inside an IF condition/,
    );
    expect(() => parse('NOT(a > 1)')).toThrowError(
      /NOT\(\.\.\.\) is only allowed inside an IF condition/,
    );
    expect(() => parse('ISBLANK(a)')).toThrowError(
      /ISBLANK\(\.\.\.\) is only allowed inside an IF condition/,
    );
    // Also inside an IF branch (a value context), not just at top level.
    expect(() => parse('IF(a > 1, NOT(b > 1), 0)')).toThrowError(
      /NOT\(\.\.\.\) is only allowed inside an IF condition/,
    );
    // And nested inside SUM (value context).
    expect(() => parse('SUM(AND(a > 1, b > 2))')).toThrowError(
      /AND\(\.\.\.\) is only allowed inside an IF condition/,
    );
  });

  it('should reject a bare condition keyword used as a value with the value-context message', () => {
    expect(() => parse('and + 1')).toThrowError(
      /AND\(\.\.\.\) is only allowed inside an IF condition/,
    );
  });

  it('should reject a bare condition keyword inside an IF condition with the reserved-word message', () => {
    expect(() => parse('IF(and, 1, 0)')).toThrowError(
      /"AND" is a reserved word/,
    );
    expect(() => parse('IF(isblank, 1, 0)')).toThrowError(
      /"ISBLANK" is a reserved word/,
    );
  });

  it('should keep dotted paths starting with a reserved keyword as plain field references', () => {
    expect(parse('and.total')).toEqual({ type: 'field', path: 'and.total' });
    expect(parse('not.x + 1')).toEqual({
      type: 'binary',
      operator: '+',
      left: { type: 'field', path: 'not.x' },
      right: { type: 'number', value: 1 },
    });
    expect(parse(`[company:${UUID}:and]`)).toEqual({
      type: 'crossref',
      ref: { object: 'company', recordId: UUID, fieldPath: 'and' },
    });
  });

  it('should reject an unterminated combinator (missing closing parenthesis)', () => {
    expect(() => parse('IF(AND(a > 1, b > 2, 1, 0')).toThrowError(
      /closing parenthesis/,
    );
  });

  it('should bound deeply nested combinators with the parse-depth guard', () => {
    const deep =
      'IF(' + 'NOT('.repeat(300) + 'a > 1' + ')'.repeat(300) + ', 1, 0)';
    expect(() => parse(deep)).toThrowError(/max depth/);
  });
});

describe('parser IFBLANK (ADR 0017)', () => {
  const UUID = '20202020-1c25-4d02-bf25-6aeccf7ea419';

  it('should parse IFBLANK into an ifblank value node', () => {
    expect(parse('IFBLANK(amount, 0)')).toEqual({
      type: 'ifblank',
      value: { type: 'field', path: 'amount' },
      fallback: { type: 'number', value: 0 },
    });
  });

  it('should allow IFBLANK anywhere a value is legal (inside arithmetic)', () => {
    expect(parse('revenue + IFBLANK(upsell, 0)')).toEqual({
      type: 'binary',
      operator: '+',
      left: { type: 'field', path: 'revenue' },
      right: {
        type: 'ifblank',
        value: { type: 'field', path: 'upsell' },
        fallback: { type: 'number', value: 0 },
      },
    });
  });

  it('should allow IFBLANK inside an ISBLANK operand', () => {
    const node = parse('IF(ISBLANK(IFBLANK(x, 0)), 1, 0)');
    if (node.type === 'if' && node.condition.type === 'isblank') {
      expect(node.condition.operand.type).toBe('ifblank');
    } else {
      throw new Error('expected ISBLANK over an IFBLANK node');
    }
  });

  it('should accept the keyword case-insensitively and tolerate whitespace', () => {
    expect(parse('ifblank(a, 0)')).toEqual({
      type: 'ifblank',
      value: { type: 'field', path: 'a' },
      fallback: { type: 'number', value: 0 },
    });
    expect(parse('IFBLANK (a, 0)')).toEqual({
      type: 'ifblank',
      value: { type: 'field', path: 'a' },
      fallback: { type: 'number', value: 0 },
    });
  });

  it('should reject IFBLANK with one or three arguments', () => {
    expect(() => parse('IFBLANK(a)')).toThrowError(
      /IFBLANK requires exactly 2 arguments/,
    );
    expect(() => parse('IFBLANK(a, b, c)')).toThrowError(
      /IFBLANK requires exactly 2 arguments/,
    );
  });

  it('should reject a bare "ifblank" not followed by parentheses', () => {
    expect(() => parse('ifblank + 1')).toThrowError(/"IFBLANK" is a reserved word/);
  });

  it('should keep a dotted path starting with "ifblank" as a plain field', () => {
    expect(parse('ifblank.y')).toEqual({ type: 'field', path: 'ifblank.y' });
    expect(parse(`[company:${UUID}:ifblank]`)).toEqual({
      type: 'crossref',
      ref: { object: 'company', recordId: UUID, fieldPath: 'ifblank' },
    });
  });

  it('should reject a comparison or string literal inside an IFBLANK argument (value context)', () => {
    expect(() => parse('IFBLANK(a > b, 0)')).toThrowError(
      /only allowed in the condition/,
    );
    expect(() => parse('IFBLANK("x", 0)')).toThrowError(
      /String literals are only allowed/,
    );
  });
});

describe('parser IFS sugar (ADR 0018)', () => {
  const UUID = '20202020-1c25-4d02-bf25-6aeccf7ea419';

  it('desugars a multi-rung IFS to the exact hand-built nested IFs (with default)', () => {
    expect(parse('IFS(a > 1, 2, b > 3, 4, 0)')).toEqual(
      parse('IF(a > 1, 2, IF(b > 3, 4, 0))'),
    );
  });

  it('desugars a single-rung IFS with a default', () => {
    expect(parse('IFS(a > 1, 2, 0)')).toEqual(parse('IF(a > 1, 2, 0)'));
  });

  it('uses a NullNode else when no default is given (even arg count)', () => {
    expect(parse('IFS(a > 1, 2)')).toEqual({
      type: 'if',
      condition: {
        type: 'comparison',
        operator: '>',
        left: { type: 'field', path: 'a' },
        right: { type: 'number', value: 1 },
      },
      then: { type: 'number', value: 2 },
      else: { type: 'null' },
    });
  });

  it('puts a NullNode at the innermost else for a default-less multi-rung ladder', () => {
    expect(parse('IFS(a > 1, 2, b > 3, 4)')).toEqual({
      type: 'if',
      condition: {
        type: 'comparison',
        operator: '>',
        left: { type: 'field', path: 'a' },
        right: { type: 'number', value: 1 },
      },
      then: { type: 'number', value: 2 },
      else: {
        type: 'if',
        condition: {
          type: 'comparison',
          operator: '>',
          left: { type: 'field', path: 'b' },
          right: { type: 'number', value: 3 },
        },
        then: { type: 'number', value: 4 },
        else: { type: 'null' },
      },
    });
  });

  it('detects odd arg count as "has default" and even as "no default"', () => {
    // Odd (3) -> last arg is the default.
    expect(parse('IFS(a > 1, 2, 9)').type).toBe('if');
    expect((parse('IFS(a > 1, 2, 9)') as { else: AstNode }).else).toEqual({
      type: 'number',
      value: 9,
    });
    // Even (2) -> no default, NullNode else.
    expect((parse('IFS(a > 1, 2)') as { else: AstNode }).else).toEqual({
      type: 'null',
    });
  });

  it('allows an ADR 0017 boolean combinator as a rung condition', () => {
    const node = parse('IFS(AND(a > 1, ISBLANK(b)), 2, OR(c > 3, d < 4), 5, 0)');
    if (node.type !== 'if' || node.condition.type !== 'and') {
      throw new Error('expected first rung condition to be an AND node');
    }
    if (node.else.type !== 'if' || node.else.condition.type !== 'or') {
      throw new Error('expected second rung condition to be an OR node');
    }
  });

  it('accepts the keyword case-insensitively and tolerates whitespace', () => {
    const expected = parse('IF(a > 1, 2, 0)');
    expect(parse('ifs(a > 1, 2, 0)')).toEqual(expected);
    expect(parse('Ifs(a > 1, 2, 0)')).toEqual(expected);
    expect(parse('IFS (a > 1, 2, 0)')).toEqual(expected);
  });

  it('rejects IFS with zero or one argument (no complete pair)', () => {
    expect(() => parse('IFS()')).toThrowError(
      /IFS requires at least one condition\/value pair/,
    );
    expect(() => parse('IFS(a)')).toThrowError(
      /IFS requires at least one condition\/value pair/,
    );
  });

  it('rejects a bare "ifs" not followed by parentheses', () => {
    expect(() => parse('ifs + 1')).toThrowError(/"IFS" is a reserved word/);
    expect(() => parse('ifs')).toThrowError(/"IFS" is a reserved word/);
  });

  it('keeps a dotted path starting with "ifs" as a plain field', () => {
    expect(parse('ifs.total')).toEqual({ type: 'field', path: 'ifs.total' });
    expect(parse(`[company:${UUID}:ifs]`)).toEqual({
      type: 'crossref',
      ref: { object: 'company', recordId: UUID, fieldPath: 'ifs' },
    });
  });

  it('rejects a string literal in a value slot (IFS values are value context)', () => {
    expect(() => parse('IFS(a > 1, "x", 0)')).toThrowError(
      /String literals are only allowed/,
    );
    expect(() => parse('IFS(a > 1, 2, "x")')).toThrowError(
      /String literals are only allowed/,
    );
  });

  it('rejects an unterminated IFS when the closing parenthesis is missing', () => {
    expect(() => parse('IFS(a > 1, 2')).toThrowError(/closing parenthesis/);
  });

  it('bounds ladder length by the parse-depth guard (one IF frame per rung)', () => {
    const rungs = 240;
    // Numeric-truthiness rungs (`1, 1`) keep the source short enough to stay
    // under MAX_EXPRESSION_LENGTH while still exceeding MAX_PARSE_DEPTH (200).
    const source =
      'IFS(' + Array.from({ length: rungs }, () => '1, 1').join(', ') + ', 0)';
    expect(source.length).toBeLessThan(2000);
    expect(() => parse(source)).toThrowError(/max depth/);
  });
});

describe('parser SWITCH sugar (ADR 0018)', () => {
  const UUID = '20202020-1c25-4d02-bf25-6aeccf7ea419';

  it('desugars a string-keyed SWITCH to nested "expr = key" IFs (with default)', () => {
    expect(parse('SWITCH(stage, "lead", 1, "won", 2, 0)')).toEqual(
      parse('IF(stage = "lead", 1, IF(stage = "won", 2, 0))'),
    );
  });

  it('desugars a numeric-keyed SWITCH', () => {
    expect(parse('SWITCH(tier, 1, 10, 2, 20, 0)')).toEqual(
      parse('IF(tier = 1, 10, IF(tier = 2, 20, 0))'),
    );
  });

  it('uses a NullNode else when no default is given (odd arg count)', () => {
    expect(parse('SWITCH(stage, "lead", 1)')).toEqual({
      type: 'if',
      condition: {
        type: 'comparison',
        operator: '=',
        left: { type: 'field', path: 'stage' },
        right: { type: 'string', value: 'lead' },
      },
      then: { type: 'number', value: 1 },
      else: { type: 'null' },
    });
  });

  it('detects even arg count as "has default" and odd as "no default"', () => {
    // Even (4) -> last arg is the default.
    expect((parse('SWITCH(s, "a", 1, 9)') as { else: AstNode }).else).toEqual({
      type: 'number',
      value: 9,
    });
    // Odd (3) -> no default, NullNode else.
    expect((parse('SWITCH(s, "a", 1)') as { else: AstNode }).else).toEqual({
      type: 'null',
    });
  });

  it('allows string keys and numeric keys to mix per rung', () => {
    expect(parse('SWITCH(x, "a", 1, 2, 20, 0)')).toEqual(
      parse('IF(x = "a", 1, IF(x = 2, 20, 0))'),
    );
  });

  it('allows an expression as the switch subject', () => {
    expect(parse('SWITCH(a + b, 1, 10, 0)')).toEqual(
      parse('IF(a + b = 1, 10, 0)'),
    );
  });

  it('accepts the keyword case-insensitively and tolerates whitespace', () => {
    const expected = parse('IF(s = "a", 1, 0)');
    expect(parse('switch(s, "a", 1, 0)')).toEqual(expected);
    expect(parse('Switch(s, "a", 1, 0)')).toEqual(expected);
    expect(parse('SWITCH (s, "a", 1, 0)')).toEqual(expected);
  });

  it('rejects SWITCH with fewer than three arguments (no complete key/value pair)', () => {
    expect(() => parse('SWITCH()')).toThrowError(
      /SWITCH requires an expression and at least one key\/value pair/,
    );
    expect(() => parse('SWITCH(a)')).toThrowError(
      /SWITCH requires an expression and at least one key\/value pair/,
    );
    expect(() => parse('SWITCH(a, b)')).toThrowError(
      /SWITCH requires an expression and at least one key\/value pair/,
    );
  });

  it('rejects a bare "switch" not followed by parentheses', () => {
    expect(() => parse('switch + 1')).toThrowError(/"SWITCH" is a reserved word/);
    expect(() => parse('switch')).toThrowError(/"SWITCH" is a reserved word/);
  });

  it('keeps a dotted path starting with "switch" as a plain field', () => {
    expect(parse('switch.total')).toEqual({
      type: 'field',
      path: 'switch.total',
    });
    expect(parse(`[company:${UUID}:switch]`)).toEqual({
      type: 'crossref',
      ref: { object: 'company', recordId: UUID, fieldPath: 'switch' },
    });
  });

  it('rejects a string literal in a value slot (SWITCH values are value context)', () => {
    expect(() => parse('SWITCH(s, "a", "x", 0)')).toThrowError(
      /String literals are only allowed/,
    );
    expect(() => parse('SWITCH(s, "a", 1, "x")')).toThrowError(
      /String literals are only allowed/,
    );
  });

  it('rejects an unterminated SWITCH when the closing parenthesis is missing', () => {
    expect(() => parse('SWITCH(s, "a", 1')).toThrowError(/closing parenthesis/);
  });

  it('bounds ladder length by the parse-depth guard (one IF frame per rung)', () => {
    const rungs = 240;
    const source =
      'SWITCH(x, ' +
      Array.from({ length: rungs }, () => '1, 1').join(', ') +
      ', 0)';
    expect(source.length).toBeLessThan(2000);
    expect(() => parse(source)).toThrowError(/max depth/);
  });
});

describe('parser comparison confinement (transient comparisons)', () => {
  it('should reject a comparison at the top level when no IF wraps it', () => {
    expect(() => parse('a > b')).toThrowError(/only allowed in the condition/);
    expect(() => parse('1 = 1')).toThrowError(/only allowed in the condition/);
  });

  it('should reject a comparison inside arithmetic when a value is expected', () => {
    expect(() => parse('1 + (a > b)')).toThrowError(/only allowed in the condition/);
    expect(() => parse('2 * a > b + 1 - 1')).toThrowError(/only allowed in the condition/);
  });

  it('should reject a comparison in a then or else branch when it is not a condition slot', () => {
    expect(() => parse('IF(a > 1, b > 2, 3)')).toThrowError(/only allowed in the condition/);
    expect(() => parse('IF(a > 1, 2, b > 3)')).toThrowError(/only allowed in the condition/);
  });

  it('should reject a comparison inside a comparison operand when parenthesised', () => {
    expect(() => parse('IF((a > b) > c, 1, 0)')).toThrowError(/only allowed in the condition/);
    expect(() => parse('IF(a > (b > c), 1, 0)')).toThrowError(/only allowed in the condition/);
  });

  it('should reject chained comparisons when written as a > b > c', () => {
    expect(() => parse('IF(a > b > c, 1, 0)')).toThrowError(/Chained comparisons/);
    expect(() => parse('IF(a = b != c, 1, 0)')).toThrowError(/Chained comparisons/);
  });
});

describe('parser string literals (comparison operands only)', () => {
  it('parses a string on the right of an equality inside an IF condition', () => {
    const ast = parse('IF(stage = "QUALIFIED", 1, 0)');
    if (ast.type === 'if' && ast.condition.type === 'comparison') {
      expect(ast.condition.operator).toBe('=');
      expect(ast.condition.left).toEqual({ type: 'field', path: 'stage' });
      expect(ast.condition.right).toEqual({
        type: 'string',
        value: 'QUALIFIED',
      });
    } else {
      throw new Error('expected an if node with a comparison condition');
    }
  });

  it('parses a string on the left of the comparison', () => {
    const ast = parse('IF("QUALIFIED" = stage, 1, 0)');
    if (ast.type === 'if' && ast.condition.type === 'comparison') {
      expect(ast.condition.left).toEqual({ type: 'string', value: 'QUALIFIED' });
      expect(ast.condition.right).toEqual({ type: 'field', path: 'stage' });
    } else {
      throw new Error('expected an if node with a comparison condition');
    }
  });

  it('parses a string with the != operator', () => {
    const ast = parse('IF(stage != "LOST", 1, 0)');
    if (ast.type === 'if' && ast.condition.type === 'comparison') {
      expect(ast.condition.operator).toBe('!=');
      expect(ast.condition.right).toEqual({ type: 'string', value: 'LOST' });
    } else {
      throw new Error('expected an if node with a comparison condition');
    }
  });

  it('parses a condition with a string literal on both sides', () => {
    const ast = parse('IF("a" = "b", 1, 0)');
    if (ast.type === 'if' && ast.condition.type === 'comparison') {
      expect(ast.condition.left).toEqual({ type: 'string', value: 'a' });
      expect(ast.condition.right).toEqual({ type: 'string', value: 'b' });
    } else {
      throw new Error('expected an if node with a comparison condition');
    }
  });

  it('rejects a string beside an ordering operator', () => {
    try {
      parse('IF(stage < "X", 1, 0)');
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(FormulaError);
      expect((error as FormulaError).code).toBe('PARSE_ERROR');
      expect((error as FormulaError).message).toBe(
        'Strings support only = and != comparisons',
      );
    }
  });

  it('rejects a string used in arithmetic', () => {
    try {
      parse('1 + "a"');
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(FormulaError);
      expect((error as FormulaError).code).toBe('PARSE_ERROR');
      expect((error as FormulaError).message).toBe(
        'String literals are only allowed beside = or != inside an IF condition',
      );
    }
  });

  it('rejects a string in an IF branch', () => {
    try {
      parse('IF(c, "a", 0)');
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(FormulaError);
      expect((error as FormulaError).code).toBe('PARSE_ERROR');
      expect((error as FormulaError).message).toBe(
        'String literals are only allowed beside = or != inside an IF condition',
      );
    }
  });

  it('rejects a bare string at the top level', () => {
    try {
      parse('"a"');
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(FormulaError);
      expect((error as FormulaError).code).toBe('PARSE_ERROR');
      expect((error as FormulaError).message).toBe(
        'String literals are only allowed beside = or != inside an IF condition',
      );
    }
  });

  it('rejects a parenthesised string even beside equality', () => {
    try {
      parse('("a") = stage');
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(FormulaError);
      expect((error as FormulaError).code).toBe('PARSE_ERROR');
      expect((error as FormulaError).message).toBe(
        'String literals are only allowed beside = or != inside an IF condition',
      );
    }
  });

  it('rejects a bare string condition when no comparison operator follows', () => {
    try {
      parse('IF("a", 1, 2)');
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(FormulaError);
      expect((error as FormulaError).code).toBe('PARSE_ERROR');
      expect((error as FormulaError).message).toBe(
        'String literals are only allowed beside = or != inside an IF condition',
      );
      // Deliberate: the error points at the literal's opening quote (index 3),
      // not at the token after it (the comma at index 6).
      expect((error as FormulaError).position).toBe(3);
    }
  });

  it('rejects a parenthesised string operand inside an IF condition', () => {
    try {
      parse('IF(("a") = stage, 1, 0)');
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(FormulaError);
      expect((error as FormulaError).code).toBe('PARSE_ERROR');
      expect((error as FormulaError).message).toBe(
        'String literals are only allowed beside = or != inside an IF condition',
      );
    }
  });
});

describe('parser errors', () => {
  it('rejects trailing tokens', () => {
    expect(() => parse('1 2')).toThrow(FormulaError);
    expect(() => parse('1 +')).toThrowError(/Unexpected end/);
  });

  it('rejects unbalanced parentheses', () => {
    expect(() => parse('(1 + 2')).toThrowError(/closing parenthesis/);
    expect(() => parse('1 + 2)')).toThrow(FormulaError);
  });

  it('rejects an empty expression', () => {
    expect(() => parse('')).toThrowError(/Unexpected end/);
    expect(() => parse('   ')).toThrowError(/Unexpected end/);
  });

  it('rejects a lone operator', () => {
    expect(() => parse('*')).toThrow(FormulaError);
  });

  it('rejects two operators in a row (non-unary)', () => {
    expect(() => parse('1 * / 2')).toThrow(FormulaError);
  });
});

describe('parser hardening (DoS guards)', () => {
  it('rejects an over-long expression before tokenizing', () => {
    const huge = new Array(3000).fill('1').join('+');
    expect(() => parse(huge)).toThrowError(/max length/);
  });

  it('rejects deeply nested parentheses instead of overflowing the stack', () => {
    const deep = '('.repeat(500) + '1' + ')'.repeat(500);
    expect(() => parse(deep)).toThrowError(/max depth/);
  });

  it('should reject deeply nested IF calls when parse depth exceeds the max', () => {
    // 110 nested IFs stay under MAX_EXPRESSION_LENGTH (881 chars) but each
    // level consumes parse-depth frames, so the depth guard must fire.
    const levels = 110;
    const deep = 'IF(0,'.repeat(levels) + '1' + ',0)'.repeat(levels);
    expect(() => parse(deep)).toThrowError(/max depth/);
  });
});
