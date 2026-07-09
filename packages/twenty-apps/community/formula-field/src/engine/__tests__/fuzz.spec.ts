import { describe, expect, it } from 'vitest';

import { FormulaError } from 'src/engine/errors';
import { evaluate } from 'src/engine/evaluator';
import { parse } from 'src/engine/parser';
import { tokenize } from 'src/engine/tokenizer';

// Deterministic PRNG (mulberry32) so fuzz runs are reproducible in CI. Date.now
// / Math.random are avoided intentionally — a failing seed must be repeatable.
const makeRng = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

// The full byte range the fuzzer draws from — includes every operator, digits,
// letters, brackets, and a pile of characters the tokenizer must reject
// (quotes, semicolons, unicode homoglyphs, control chars).
const ALPHABET = [
  ...'0123456789',
  ...'+-*/%()[],',
  ...'abcABC._: ',
  ...'IF=!<>',
  ...';{}$`"\'\\&|^~#@?',
  String.fromCharCode(0x2212), // unicode minus
  String.fromCharCode(0xff0b), // fullwidth plus
  String.fromCharCode(0x00a0), // non-breaking space
];

describe('tokenizer fuzzing', () => {
  it('never throws a non-FormulaError and always terminates', () => {
    const rng = makeRng(0xc0ffee);
    // Deterministic raw resolver on a SEPARATE stream, so the source-generation
    // sequence above is byte-identical to before. String-mode comparisons in a
    // parsed AST resolve through a mix of strings, numbers, and null — exercising
    // the string resolution paths under fuzz without touching seeds/determinism.
    const rawRng = makeRng(0x5eed5);
    const resolveRaw = () => {
      const draw = rawRng();
      if (draw < 0.34) return 'active';
      if (draw < 0.67) return draw * 100;
      return null;
    };

    for (let iteration = 0; iteration < 5000; iteration += 1) {
      const length = Math.floor(rng() * 40);
      let source = '';
      for (let i = 0; i < length; i += 1) {
        source += ALPHABET[Math.floor(rng() * ALPHABET.length)];
      }

      try {
        // The whole pipeline must be safe on arbitrary input: either it parses
        // to an AST or it throws a typed FormulaError. Nothing else, ever.
        const ast = parse(source);
        // If it parsed, evaluating with an all-null resolver (plus a mixed raw
        // resolver for string comparisons) must also be safe.
        evaluate(ast, () => null, { resolveRaw });
      } catch (error) {
        expect(
          error,
          `unexpected error type for input ${JSON.stringify(source)}`,
        ).toBeInstanceOf(FormulaError);
      }
    }
  });

  it('never lets a forbidden character survive tokenization', () => {
    const rng = makeRng(0x1234);
    // '=', '<', '>' left this list when comparisons landed; '"' left when string
    // literals landed (a lone '"' now opens a string and dies as "unterminated",
    // still a FormulaError). A lone '!' is still forbidden (only "!=" is legal).
    const forbidden = ";{}$`'\\!&|^~#@?";

    for (let iteration = 0; iteration < 2000; iteration += 1) {
      const bad = forbidden[Math.floor(rng() * forbidden.length)];
      const source = `1 + ${bad} 2`;
      expect(() => tokenize(source)).toThrow(FormulaError);
    }
  });

  it('round-trips randomly generated VALID expressions', () => {
    const rng = makeRng(0x99);

    // Grammar-directed generator: only ever emits well-formed expressions, so
    // parse() must always succeed and evaluate() must return a finite number
    // (integer literals only, no division -> no divide-by-zero, no nulls; IF
    // branches are themselves generated expressions, so both are finite).
    const genNumber = () => String(1 + Math.floor(rng() * 9));
    const COMPARE_OPS = ['>', '<', '>=', '<=', '=', '==', '!='];
    // String literals are legal ONLY as a direct operand of = / != inside an IF
    // condition, so quoted operands are produced only here in genCondition.
    const STRING_CHARS = [...'abcXYZ 0129._[]'];
    const genString = (): string => {
      const length = Math.floor(rng() * 6);
      let content = '';
      for (let i = 0; i < length; i += 1) {
        content += STRING_CHARS[Math.floor(rng() * STRING_CHARS.length)];
      }
      return `"${content}"`;
    };
    const genCondition = (depth: number): string => {
      // Boolean combinators (ADR 0017) — legal only in condition context, so
      // produced here. Each argument recurses into genCondition (AND/OR/NOT) or
      // genExpr (ISBLANK), matching the grammar the parser accepts.
      if (depth > 0 && rng() < 0.18) {
        const pick = rng();
        if (pick < 0.35) {
          return `AND(${genCondition(depth - 1)}, ${genCondition(depth - 1)})`;
        }
        if (pick < 0.7) {
          return `OR(${genCondition(depth - 1)}, ${genCondition(depth - 1)})`;
        }
        if (pick < 0.85) {
          return `NOT(${genCondition(depth - 1)})`;
        }
        return `ISBLANK(${genExpr(depth - 1)})`;
      }
      // Numeric condition or a single (never chained) comparison.
      if (rng() < 0.3) {
        return genExpr(depth - 1);
      }
      // Sometimes a (in)equality with a quoted operand on one or both sides.
      if (rng() < 0.25) {
        const op = rng() < 0.5 ? '=' : '!=';
        const left = rng() < 0.5 ? genString() : genExpr(depth - 1);
        const right = rng() < 0.5 ? genString() : genExpr(depth - 1);
        return `${left} ${op} ${right}`;
      }
      const op = COMPARE_OPS[Math.floor(rng() * COMPARE_OPS.length)];
      return `${genExpr(depth - 1)} ${op} ${genExpr(depth - 1)}`;
    };
    const genExpr = (depth: number): string => {
      if (depth <= 0 || rng() < 0.4) {
        return genNumber();
      }
      if (rng() < 0.2) {
        return `IF(${genCondition(depth)}, ${genExpr(depth - 1)}, ${genExpr(depth - 1)})`;
      }
      // IFBLANK(value, fallback) (ADR 0017) — a value-context function, so it is
      // produced in genExpr like a nested IF.
      if (rng() < 0.15) {
        return `IFBLANK(${genExpr(depth - 1)}, ${genExpr(depth - 1)})`;
      }
      const op = ['+', '-', '*'][Math.floor(rng() * 3)];
      const left = genExpr(depth - 1);
      const right = genExpr(depth - 1);
      return rng() < 0.5 ? `(${left} ${op} ${right})` : `${left} ${op} ${right}`;
    };

    for (let iteration = 0; iteration < 2000; iteration += 1) {
      const source = genExpr(5);
      // String literals are grammar-only in this task (evaluation lands later),
      // so a string-bearing expression is asserted to PARSE; a purely numeric
      // one must also evaluate to a finite number as before.
      if (source.includes('"')) {
        expect(() => parse(source)).not.toThrow();
      } else {
        const result = evaluate(parse(source), () => 0);
        expect(Number.isFinite(result as number)).toBe(true);
      }
    }
  });
});
