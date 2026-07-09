import { describe, expect, it } from 'vitest';

import { detectCycle, type FormulaTarget } from 'src/engine/cycle-detection';
import { extractDependencies } from 'src/engine/dependencies';

const UUID = '20202020-1c25-4d02-bf25-6aeccf7ea419';

const formula = (
  object: string,
  field: string,
  expression: string,
): FormulaTarget => ({
  object,
  field,
  dependencies: extractDependencies(expression),
});

describe('cycle detection', () => {
  it('accepts an acyclic set', () => {
    const result = detectCycle([
      formula('opportunity', 'score', 'inputA + inputB'),
      formula('opportunity', 'grade', 'score * 10'),
    ]);
    expect(result.hasCycle).toBe(false);
  });

  it('detects a direct self-reference', () => {
    const result = detectCycle([
      formula('opportunity', 'score', 'score + 1'),
    ]);
    expect(result.hasCycle).toBe(true);
  });

  it('detects a two-node cycle', () => {
    const result = detectCycle([
      formula('opportunity', 'a', 'b + 1'),
      formula('opportunity', 'b', 'a + 1'),
    ]);
    expect(result.hasCycle).toBe(true);
    if (result.hasCycle) {
      expect(result.cycle).toContain('opportunity.a');
      expect(result.cycle).toContain('opportunity.b');
    }
  });

  it('detects a three-node cycle', () => {
    const result = detectCycle([
      formula('opportunity', 'a', 'b'),
      formula('opportunity', 'b', 'c'),
      formula('opportunity', 'c', 'a'),
    ]);
    expect(result.hasCycle).toBe(true);
  });

  it('detects a cross-object cycle', () => {
    // opportunity.score reads company.rank; company.rank reads opportunity.score
    // (on a fixed record) -> field-level cycle across objects.
    const result = detectCycle([
      formula('opportunity', 'score', `[company:${UUID}:rank]`),
      formula('company', 'rank', `[opportunity:${UUID}:score]`),
    ]);
    expect(result.hasCycle).toBe(true);
  });

  it('does not flag a diamond (shared dependency, no cycle)', () => {
    const result = detectCycle([
      formula('opportunity', 'top', 'left + right'),
      formula('opportunity', 'left', 'base'),
      formula('opportunity', 'right', 'base'),
      formula('opportunity', 'base', 'inputA'),
    ]);
    expect(result.hasCycle).toBe(false);
  });

  it('rejects a cycle that runs through an ISBLANK edge (ADR 0017)', () => {
    // a = IF(ISBLANK(b), 1, 2) reads b; b = a + 1 reads a -> cycle through the
    // ISBLANK operand dependency.
    const result = detectCycle([
      formula('opportunity', 'a', 'IF(ISBLANK(b), 1, 2)'),
      formula('opportunity', 'b', 'a + 1'),
    ]);
    expect(result.hasCycle).toBe(true);
  });

  it('ignores dependencies on non-formula fields', () => {
    // "inputA" is a plain field, not a formula target -> no edge, no cycle.
    const result = detectCycle([
      formula('opportunity', 'score', 'inputA + inputB'),
    ]);
    expect(result.hasCycle).toBe(false);
  });
});
