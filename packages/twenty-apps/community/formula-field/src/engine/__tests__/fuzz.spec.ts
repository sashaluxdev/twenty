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
  ...'+-*/%()[]',
  ...'abcABC._: ',
  ...';{}$`"\'\\=!&|^<>~#@?',
  String.fromCharCode(0x2212), // unicode minus
  String.fromCharCode(0xff0b), // fullwidth plus
  String.fromCharCode(0x00a0), // non-breaking space
];

describe('tokenizer fuzzing', () => {
  it('never throws a non-FormulaError and always terminates', () => {
    const rng = makeRng(0xc0ffee);

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
        // If it parsed, evaluating with an all-null resolver must also be safe.
        evaluate(ast, () => null);
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
    const forbidden = ';{}$`"\'\\=!&|^<>~#@?';

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
    // (integer literals only, no division -> no divide-by-zero, no nulls).
    const genNumber = () => String(1 + Math.floor(rng() * 9));
    const genExpr = (depth: number): string => {
      if (depth <= 0 || rng() < 0.4) {
        return genNumber();
      }
      const op = ['+', '-', '*'][Math.floor(rng() * 3)];
      const left = genExpr(depth - 1);
      const right = genExpr(depth - 1);
      return rng() < 0.5 ? `(${left} ${op} ${right})` : `${left} ${op} ${right}`;
    };

    for (let iteration = 0; iteration < 2000; iteration += 1) {
      const source = genExpr(5);
      const result = evaluate(parse(source), () => 0);
      expect(Number.isFinite(result as number)).toBe(true);
    }
  });
});
