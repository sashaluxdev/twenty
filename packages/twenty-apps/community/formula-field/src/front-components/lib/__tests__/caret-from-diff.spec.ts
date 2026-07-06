import { describe, expect, it } from 'vitest';

import { caretFromDiff } from 'src/front-components/lib/caret-from-diff';
import {
  computeSuggestions,
  type FieldOption,
} from 'src/front-components/lib/formula-field-input';

describe('caretFromDiff', () => {
  it('returns the index after a mid-string insert', () => {
    expect(caretFromDiff('money1 * 0.2', 'monney1 * 0.2')).toBe(3);
  });

  it('returns the index after an append at end', () => {
    expect(caretFromDiff('money1', 'money1i')).toBe(7);
  });

  it('returns the index after a mid-string delete', () => {
    expect(caretFromDiff('money1 * 0.2', 'mony1 * 0.2')).toBe(3);
  });

  it('guards prefix/suffix overlap on a repeated-character run', () => {
    expect(caretFromDiff('aaa', 'aaaa')).toBe(4);
  });

  it('falls back to end on a no-op change', () => {
    expect(caretFromDiff('money1', 'money1')).toBe(6);
  });

  it('handles inserting the first character', () => {
    expect(caretFromDiff('', 'a')).toBe(1);
  });

  it('handles clearing all text', () => {
    expect(caretFromDiff('abc', '')).toBe(0);
  });
});

describe('computeSuggestions (mid-string caret)', () => {
  const money1: FieldOption = { name: 'money1', label: 'Money 1', type: 'NUMBER' };

  it('suggests a field for an identifier at a mid-string caret', () => {
    const suggestions = computeSuggestions('monney1 * 0.2', 3, [money1]);
    expect(suggestions.map((option) => option.name)).toContain('money1');
  });

  it('suggests the IF function when its identifier is being typed at the end', () => {
    const suggestions = computeSuggestions('money1 + i', 10, [money1]);
    expect(suggestions.map((option) => option.insertText)).toContain('IF(');
  });

  it('suppresses suggestions inside a cross-record reference', () => {
    expect(computeSuggestions('[company:abc', 12, [money1])).toEqual([]);
  });
});
