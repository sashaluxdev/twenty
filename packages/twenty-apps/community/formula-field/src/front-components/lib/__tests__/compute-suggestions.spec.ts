import { describe, expect, it } from 'vitest';

import {
  computeInsertRange,
  computeSuggestions,
  type FieldOption,
} from 'src/front-components/lib/formula-field-input';

// A SELECT field carrying options — the source of quoted option suggestions
// after a `=` / `!=` comparison.
const stage: FieldOption = {
  name: 'stage',
  label: 'Stage',
  type: 'SELECT',
  options: [
    { value: 'QUALIFIED', label: 'Qualified' },
    { value: 'NEW', label: 'New' },
    { value: 'WON', label: 'Won' },
  ],
};
const tier: FieldOption = { name: 'tier', label: 'Tier', type: 'TEXT' };
const amount: FieldOption = { name: 'amount', label: 'Amount', type: 'NUMBER' };

describe('computeSuggestions — SELECT option context', () => {
  it('returns a SELECT field options with quoted insertText after `= `', () => {
    const suggestions = computeSuggestions('stage = ', 8, [stage]);
    expect(suggestions.map((option) => option.name)).toEqual([
      'QUALIFIED',
      'NEW',
      'WON',
    ]);
    expect(suggestions.every((option) => option.type === 'OPTION')).toBe(true);
    expect(suggestions.map((option) => option.insertText)).toContain(
      '"QUALIFIED"',
    );
  });

  it('filters options by a quoted partial (`stage = "QU`)', () => {
    const suggestions = computeSuggestions('stage = "QU', 11, [stage]);
    expect(suggestions.map((option) => option.name)).toEqual(['QUALIFIED']);
    expect(suggestions[0].insertText).toBe('"QUALIFIED"');
  });

  it('filters options by an unquoted partial (`stage = QU`), insertText still fully quoted', () => {
    const suggestions = computeSuggestions('stage = QU', 10, [stage]);
    expect(suggestions.map((option) => option.name)).toEqual(['QUALIFIED']);
    expect(suggestions[0].insertText).toBe('"QUALIFIED"');
  });

  it('works for the `!=` operator', () => {
    const suggestions = computeSuggestions('stage != ', 9, [stage]);
    expect(suggestions.map((option) => option.name)).toEqual([
      'QUALIFIED',
      'NEW',
      'WON',
    ]);
  });

  it('returns nothing for a TEXT field comparison (no options to offer)', () => {
    expect(computeSuggestions('tier = ', 7, [tier])).toEqual([]);
    expect(computeSuggestions('tier = go', 9, [tier])).toEqual([]);
  });

  it('returns nothing when the compared identifier is not a known field', () => {
    expect(computeSuggestions('missing = QU', 12, [stage])).toEqual([]);
  });

  it('returns nothing inside a cross-record reference', () => {
    expect(computeSuggestions('[stage = QU', 11, [stage])).toEqual([]);
  });
});

describe('computeSuggestions — field completion regressions', () => {
  it('still suggests fields for a bare identifier', () => {
    const suggestions = computeSuggestions('sta', 3, [stage, amount]);
    expect(suggestions.map((option) => option.name)).toContain('stage');
  });

  it('surfaces SELECT and TEXT fields with their type in field completion', () => {
    expect(computeSuggestions('sta', 3, [stage])[0].type).toBe('SELECT');
    expect(computeSuggestions('ti', 2, [tier])[0].type).toBe('TEXT');
  });
});

describe('computeInsertRange — replace-range for option accept', () => {
  const qualified: FieldOption = {
    name: 'QUALIFIED',
    label: 'Qualified',
    type: 'OPTION',
    insertText: '"QUALIFIED"',
  };

  it('replaces an unquoted partial from its start', () => {
    // 'stage = ' is 8 chars; the partial 'QU' starts at index 8.
    expect(computeInsertRange('stage = QU', 10, qualified)).toEqual({
      start: 8,
      insertText: '"QUALIFIED"',
    });
  });

  it('replaces an already-typed opening quote so quotes never double', () => {
    // The '"' sits at index 8 — replacing from there yields a single quote pair.
    expect(computeInsertRange('stage = "QU', 11, qualified)).toEqual({
      start: 8,
      insertText: '"QUALIFIED"',
    });
  });

  it('inserts at the caret when there is no partial yet', () => {
    expect(computeInsertRange('stage = ', 8, qualified)).toEqual({
      start: 8,
      insertText: '"QUALIFIED"',
    });
  });

  it('uses identifier-start for a normal field suggestion', () => {
    const field: FieldOption = { name: 'stage', label: 'Stage', type: 'SELECT' };
    expect(computeInsertRange('sta', 3, field)).toEqual({
      start: 0,
      insertText: 'stage',
    });
  });
});
