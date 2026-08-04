import { describe, expect, it } from 'vitest';

import {
  overrideSlotKind,
  pinnedEngineOverrideValue,
  pinnedOverrideDisplayValue,
} from 'src/front-components/lib/override-slot';

describe('overrideSlotKind', () => {
  it('routes a mirror row to the raw slot whatever its target kind', () => {
    expect(overrideSlotKind('SELECT', true)).toBe('raw');
    expect(overrideSlotKind('LINKS', true)).toBe('raw');
  });

  it('routes an engine row by its target kind — TEXT included', () => {
    expect(overrideSlotKind('TEXT', false)).toBe('TEXT');
    expect(overrideSlotKind('NUMBER', false)).toBe('NUMBER');
    expect(overrideSlotKind('CURRENCY', false)).toBe('CURRENCY');
    expect(overrideSlotKind('DATE_TIME', false)).toBe('DATE_TIME');
  });

  it('falls back to NUMBER for an unknown engine kind', () => {
    expect(overrideSlotKind('WHATEVER', false)).toBe('NUMBER');
  });
});

describe('pinnedOverrideDisplayValue', () => {
  it('reads a TEXT pin out of the TEXT slot, never the numeric column', () => {
    // The numeric column is always null for a TEXT target — reading it is the
    // silent-blank bug this exists to prevent.
    expect(
      pinnedOverrideDisplayValue('TEXT', {
        overrideValue: null,
        overrideValueText: '"pinned text"',
      }),
    ).toBe('pinned text');
  });

  it('reads an engine numeric pin out of the numeric column', () => {
    expect(
      pinnedOverrideDisplayValue('CURRENCY', {
        overrideValue: 1_500_000,
        overrideValueText: null,
      }),
    ).toBe(1_500_000);
    expect(
      pinnedOverrideDisplayValue('NUMBER', {
        overrideValue: null,
        overrideValueText: null,
      }),
    ).toBeNull();
  });

  it('reads a mirror pin as its decoded raw value', () => {
    expect(
      pinnedOverrideDisplayValue('raw', {
        overrideValue: null,
        overrideValueText: '{"primaryLinkUrl":"https://x.dev"}',
      }),
    ).toEqual({ primaryLinkUrl: 'https://x.dev' });
  });

  it('degrades an absent or corrupt text pin to null', () => {
    expect(
      pinnedOverrideDisplayValue('TEXT', {
        overrideValue: null,
        overrideValueText: null,
      }),
    ).toBeNull();
    expect(
      pinnedOverrideDisplayValue('raw', {
        overrideValue: null,
        overrideValueText: '{oops',
      }),
    ).toBeNull();
  });
});

describe('pinnedEngineOverrideValue', () => {
  it('restores a TEXT pin from the text slot', () => {
    expect(
      pinnedEngineOverrideValue('TEXT', {
        overrideValue: null,
        overrideValueText: '"ACME-42"',
      }),
    ).toEqual({ restorable: true, value: 'ACME-42' });
  });

  it('restores an empty-string TEXT pin (an empty string is a real value)', () => {
    expect(
      pinnedEngineOverrideValue('TEXT', {
        overrideValue: null,
        overrideValueText: '""',
      }),
    ).toEqual({ restorable: true, value: '' });
  });

  it('restores a null TEXT pin as null, matching the backend read path', () => {
    expect(
      pinnedEngineOverrideValue('TEXT', {
        overrideValue: null,
        overrideValueText: 'null',
      }),
    ).toEqual({ restorable: true, value: null });
  });

  it('normalizes a non-string TEXT pin to null rather than writing a number', () => {
    expect(
      pinnedEngineOverrideValue('TEXT', {
        overrideValue: null,
        overrideValueText: '42',
      }),
    ).toEqual({ restorable: true, value: null });
  });

  it('reports an absent or corrupt TEXT pin as unrestorable', () => {
    expect(
      pinnedEngineOverrideValue('TEXT', {
        overrideValue: null,
        overrideValueText: null,
      }),
    ).toEqual({ restorable: false, value: null });
    expect(
      pinnedEngineOverrideValue('TEXT', {
        overrideValue: null,
        overrideValueText: 'not json',
      }),
    ).toEqual({ restorable: false, value: null });
  });

  it('keeps the numeric slot always restorable (a null pin clears the field)', () => {
    expect(
      pinnedEngineOverrideValue('NUMBER', {
        overrideValue: 7,
        overrideValueText: null,
      }),
    ).toEqual({ restorable: true, value: 7 });
    expect(
      pinnedEngineOverrideValue('DATE', {
        overrideValue: null,
        overrideValueText: null,
      }),
    ).toEqual({ restorable: true, value: null });
  });
});
