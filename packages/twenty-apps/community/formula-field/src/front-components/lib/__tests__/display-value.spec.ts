import { describe, expect, it } from 'vitest';

import {
  displayHeartbeatValue,
  displayValue,
} from 'src/front-components/lib/display-value';

describe('displayValue', () => {
  it('renders a string verbatim, whatever the target kind', () => {
    // The string branch runs BEFORE any mirror check: a TEXT target is an engine
    // target now, and its values are strings.
    expect(displayValue({ targetFieldType: 'TEXT' }, 'ACME-42')).toBe('ACME-42');
    expect(displayValue({ targetFieldType: 'SELECT' }, 'ACTIVE')).toBe('ACTIVE');
    expect(displayValue({ targetFieldType: 'TEXT' }, '')).toBe('');
  });

  it('renders a missing value as an em dash', () => {
    expect(displayValue({ targetFieldType: 'TEXT' }, null)).toBe('—');
    expect(displayValue({ targetFieldType: 'NUMBER' }, undefined)).toBe('—');
  });

  it('divides a CURRENCY value out of micros', () => {
    expect(displayValue({ targetFieldType: 'CURRENCY' }, 1_500_000)).toBe('1.50');
  });

  it('stringifies a number on a TEXT target', () => {
    // A TEXT target can transiently hold a number (a just-computed value not yet
    // normalized to text); it must not fall through the date/currency branches.
    expect(displayValue({ targetFieldType: 'TEXT' }, 42)).toBe('42');
  });

  it('renders DATE / DATE_TIME epoch-days as their scalars', () => {
    expect(displayValue({ targetFieldType: 'DATE' }, 0)).toBe('1970-01-01');
    expect(displayValue({ targetFieldType: 'DATE_TIME' }, 0)).toBe(
      '1970-01-01T00:00:00.000Z',
    );
  });

  it('renders mirror composites as compact JSON', () => {
    expect(
      displayValue({ targetFieldType: 'FULL_NAME' }, { firstName: 'Ada' }),
    ).toBe('{"firstName":"Ada"}');
    expect(displayValue({ targetFieldType: 'BOOLEAN' }, true)).toBe('true');
  });
});

describe('displayHeartbeatValue', () => {
  it('shows the numeric heartbeat when there is one', () => {
    expect(
      displayHeartbeatValue({ lastValue: 42, lastValueText: null }),
    ).toBe('42');
  });

  it('falls back to the JSON-encoded text heartbeat', () => {
    expect(
      displayHeartbeatValue({ lastValue: null, lastValueText: '"ACME-42"' }),
    ).toBe('ACME-42');
  });

  it('renders a non-string decoded heartbeat readably', () => {
    expect(
      displayHeartbeatValue({ lastValue: null, lastValueText: '{"a":1}' }),
    ).toBe('{"a":1}');
    expect(
      displayHeartbeatValue({ lastValue: null, lastValueText: 'true' }),
    ).toBe('true');
  });

  it('dashes on no heartbeat at all, a null text or corrupt text', () => {
    expect(displayHeartbeatValue({ lastValue: null, lastValueText: null })).toBe(
      '—',
    );
    expect(
      displayHeartbeatValue({ lastValue: null, lastValueText: '' }),
    ).toBe('—');
    expect(
      displayHeartbeatValue({ lastValue: null, lastValueText: 'null' }),
    ).toBe('—');
    expect(
      displayHeartbeatValue({ lastValue: null, lastValueText: '[unserializ' }),
    ).toBe('—');
  });
});
