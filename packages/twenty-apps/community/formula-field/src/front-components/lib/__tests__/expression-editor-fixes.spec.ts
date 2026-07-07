import { describe, expect, it } from 'vitest';

import {
  computeSuggestions,
  rowsForValue,
  shouldSuppressReopen,
  SUGGESTION_LIMIT,
  type FieldOption,
} from 'src/front-components/lib/formula-field-input';

// Builds N distinct fields whose API names all start with `sta` so a single
// query matches every one — used to prove the cap no longer truncates at 8.
const buildMatchingFields = (count: number): FieldOption[] =>
  Array.from({ length: count }, (_unused, index) => ({
    name: `sta${index}`,
    label: `Stage ${index}`,
    type: 'NUMBER',
  }));

describe('Bug 1 — suggestion cap raised beyond the old 8-item truncation', () => {
  it('exposes a single raised named cap (>= 50)', () => {
    expect(SUGGESTION_LIMIT).toBeGreaterThanOrEqual(50);
  });

  it('returns all matches when under the cap (20 fields, no 8-item truncation)', () => {
    const fields = buildMatchingFields(20);
    const suggestions = computeSuggestions('sta', 3, fields);
    expect(suggestions).toHaveLength(20);
  });

  it('bounds pathological lists to the cap', () => {
    const fields = buildMatchingFields(SUGGESTION_LIMIT + 25);
    const suggestions = computeSuggestions('sta', 3, fields);
    expect(suggestions).toHaveLength(SUGGESTION_LIMIT);
  });
});

describe('Bug 2 — suppress dropdown reopen for the just-accepted state', () => {
  it('suppresses when current value+caret equals the accepted record', () => {
    expect(
      shouldSuppressReopen(
        { value: 'IF(stage', caret: 8 },
        { value: 'IF(stage', caret: 8 },
      ),
    ).toBe(true);
  });

  it('does not suppress once one more character is typed (partial extends)', () => {
    // Typing extends the value past the accepted record -> reopen allowed.
    expect(
      shouldSuppressReopen(
        { value: 'IF(stagex', caret: 9 },
        { value: 'IF(stage', caret: 8 },
      ),
    ).toBe(false);
    // And the extended partial still has live field completion to reopen with.
    const suggestions = computeSuggestions('sta', 3, [
      { name: 'stage', label: 'Stage', type: 'SELECT' },
    ]);
    expect(suggestions.map((option) => option.name)).toContain('stage');
  });

  it('does not suppress when the caret moved off the accepted position', () => {
    expect(
      shouldSuppressReopen(
        { value: 'IF(stage', caret: 6 },
        { value: 'IF(stage', caret: 8 },
      ),
    ).toBe(false);
  });

  it('never suppresses with no accepted record', () => {
    expect(shouldSuppressReopen({ value: 'sta', caret: 3 }, null)).toBe(false);
  });
});

describe('Bug 3 — rows derived from content (auto-growing textarea)', () => {
  it('is 2 for empty content', () => {
    expect(rowsForValue('')).toBe(2);
  });

  it('is 2 for a single line (min floor)', () => {
    expect(rowsForValue('amount + tax')).toBe(2);
  });

  it('is newlineCount + 1 in the growth band', () => {
    expect(rowsForValue('a\nb\nc')).toBe(3);
    expect(rowsForValue('a\nb\nc\nd\ne')).toBe(5);
  });

  it('caps at 10 rows', () => {
    const manyLines = Array.from({ length: 40 }, () => 'x').join('\n');
    expect(rowsForValue(manyLines)).toBe(10);
  });
});
