import { describe, expect, it } from 'vitest';
import {
  computeMarkerValue,
  MARKER_FIELD_NAME,
} from 'src/logic-functions/lib/override-marker';
import { type FormulaDefinitionRecord } from 'src/logic-functions/lib/types';

const definition = (
  overrides: Partial<FormulaDefinitionRecord> = {},
): FormulaDefinitionRecord => ({
  id: 'f1',
  name: 'Deal Score',
  targetObject: 'opportunity',
  targetField: 'dealScore',
  enabled: true,
  allowOverride: true,
  order: 1,
  ...overrides,
});

describe('computeMarkerValue', () => {
  it('lists the labels of active-pinned fields, joined by ", "', () => {
    const defs = [
      definition(),
      definition({ id: 'f2', name: 'Tier', targetField: 'tier', order: 2 }),
    ];
    expect(
      computeMarkerValue('opportunity', defs, new Set(['dealScore', 'tier'])),
    ).toBe('Deal Score, Tier');
  });

  it('returns empty string when nothing is pinned', () => {
    expect(computeMarkerValue('opportunity', [definition()], new Set())).toBe('');
  });

  it('sorts by order asc nulls-last, then label', () => {
    const defs = [
      definition({ id: 'a', name: 'Zeta', targetField: 'zeta', order: null }),
      definition({ id: 'b', name: 'Beta', targetField: 'beta', order: 5 }),
      definition({ id: 'c', name: 'Alpha', targetField: 'alpha', order: null }),
    ];
    expect(
      computeMarkerValue('opportunity', defs, new Set(['zeta', 'beta', 'alpha'])),
    ).toBe('Beta, Alpha, Zeta');
  });

  it('falls back to targetField when name is blank (app-wide label rule)', () => {
    const defs = [definition({ name: '' })];
    expect(computeMarkerValue('opportunity', defs, new Set(['dealScore']))).toBe(
      'dealScore',
    );
  });

  it('excludes locked definitions even when a stray pin exists (ADR 0028 D2)', () => {
    const defs = [definition({ allowOverride: false })];
    expect(computeMarkerValue('opportunity', defs, new Set(['dealScore']))).toBe('');
  });

  it('excludes disabled definitions (spec §4 step 1)', () => {
    const defs = [definition({ enabled: false })];
    expect(computeMarkerValue('opportunity', defs, new Set(['dealScore']))).toBe('');
  });

  it('treats legacy null allowOverride as allowed', () => {
    const defs = [definition({ allowOverride: null })];
    expect(computeMarkerValue('opportunity', defs, new Set(['dealScore']))).toBe(
      'Deal Score',
    );
  });

  it('ignores pins with no backing definition (variation-sync pins)', () => {
    expect(
      computeMarkerValue('opportunity', [definition()], new Set(['someSyncedField'])),
    ).toBe('');
  });

  it('ignores definitions for other objects', () => {
    const defs = [definition({ targetObject: 'company' })];
    expect(computeMarkerValue('opportunity', defs, new Set(['dealScore']))).toBe('');
  });

  it('dedupes two definitions sharing a targetField (first in sort order wins)', () => {
    const defs = [
      definition({ id: 'f1', name: 'New Score', order: 1 }),
      definition({ id: 'f2', name: 'Old Score', order: 2 }),
    ];
    expect(computeMarkerValue('opportunity', defs, new Set(['dealScore']))).toBe(
      'New Score',
    );
  });

  it('exports the marker field name', () => {
    expect(MARKER_FIELD_NAME).toBe('fxOverrides');
  });
});
