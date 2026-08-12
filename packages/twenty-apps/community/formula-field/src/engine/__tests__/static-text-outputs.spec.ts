import { describe, expect, it } from 'vitest';

import { parse } from 'src/engine/parser';
import { staticTextOutputs } from 'src/engine/static-text-outputs';

const outputsOf = (expression: string): string[] | null => {
  const result = staticTextOutputs(parse(expression));
  return result === null ? null : [...result].sort();
};

describe('staticTextOutputs', () => {
  it('a bare string literal is a singleton set', () => {
    expect(outputsOf('"HOT"')).toEqual(['HOT']);
  });

  it('IF unions both branches; the condition never contributes', () => {
    expect(outputsOf('IF(amount > 5, "HOT", "COLD")')).toEqual(['COLD', 'HOT']);
  });

  it('SWITCH keys sit in condition position and never contribute', () => {
    expect(outputsOf('SWITCH(stage, "won", "CLOSED", "OPEN")')).toEqual([
      'CLOSED',
      'OPEN',
    ]);
  });

  it('a defaultless ladder contributes nothing for the missing default', () => {
    expect(outputsOf('IFS(amount > 100, "HOT", amount > 10, "WARM")')).toEqual([
      'HOT',
      'WARM',
    ]);
  });

  it('IFBLANK unions both arguments', () => {
    expect(outputsOf('IFBLANK("", "NEW")')).toEqual(['', 'NEW']);
  });

  it('blank literals stay in the set (membership exempts them, not the walker)', () => {
    expect(outputsOf('IF(amount > 5, "HOT", "")')).toEqual(['', 'HOT']);
  });

  it('nested ladders union transitively', () => {
    expect(outputsOf('IF(amount > 1, IF(amount > 2, "X", "Y"), "Z")')).toEqual([
      'X',
      'Y',
      'Z',
    ]);
  });

  it('field refs, concat, TEXT(), numbers and open IFBLANK poison to null', () => {
    expect(outputsOf('stage')).toBeNull();
    expect(outputsOf('IF(amount > 5, "HOT", stage)')).toBeNull();
    expect(outputsOf('"A" & "B"')).toBeNull();
    expect(outputsOf('TEXT(amount)')).toBeNull();
    expect(outputsOf('IFBLANK(stage, "NEW")')).toBeNull();
    expect(outputsOf('42')).toBeNull();
  });
});
