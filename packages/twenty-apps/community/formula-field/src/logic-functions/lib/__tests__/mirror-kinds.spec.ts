import { describe, expect, it } from 'vitest';

import { parse } from 'src/engine';
import {
  ENGINE_FAMILY_KINDS,
  isMirrorDefinition,
  isMirrorTargetKind,
  MIRRORABLE_KINDS,
  selectionEntryForMirrorKind,
} from 'src/logic-functions/lib/mirror-kinds';

const UUID = '20202020-1c25-4d02-bf25-6aeccf7ea419';

describe('MIRRORABLE_KINDS allowlist', () => {
  const allowed = [
    'TEXT',
    'SELECT',
    'MULTI_SELECT',
    'BOOLEAN',
    'RATING',
    'LINKS',
    'FULL_NAME',
    'ADDRESS',
    'EMAILS',
    'PHONES',
    'ARRAY',
    'RAW_JSON',
  ];

  it.each(allowed)('accepts %s as a mirror target kind', (kind) => {
    expect(MIRRORABLE_KINDS.has(kind)).toBe(true);
    expect(isMirrorTargetKind(kind)).toBe(true);
  });

  it.each(['NUMBER', 'CURRENCY', 'DATE', 'DATE_TIME', 'RELATION', 'ACTOR', 'RICH_TEXT'])(
    'rejects %s as a mirror target kind',
    (kind) => {
      expect(isMirrorTargetKind(kind)).toBe(false);
    },
  );
});

describe('ENGINE_FAMILY_KINDS', () => {
  it('is exactly value-io TargetFieldKind family', () => {
    expect([...ENGINE_FAMILY_KINDS].sort()).toEqual([
      'CURRENCY',
      'DATE',
      'DATE_TIME',
      'NUMBER',
    ]);
  });
});

describe('selectionEntryForMirrorKind', () => {
  it.each(['TEXT', 'SELECT', 'BOOLEAN', 'RATING', 'MULTI_SELECT', 'ARRAY', 'RAW_JSON'])(
    'returns true for scalar/array kind %s',
    (kind) => {
      expect(selectionEntryForMirrorKind(kind)).toBe(true);
    },
  );

  it('returns the LINKS composite sub-selection', () => {
    expect(selectionEntryForMirrorKind('LINKS')).toEqual({
      primaryLinkLabel: true,
      primaryLinkUrl: true,
      secondaryLinks: true,
    });
  });

  it('returns the FULL_NAME composite sub-selection', () => {
    expect(selectionEntryForMirrorKind('FULL_NAME')).toEqual({
      firstName: true,
      lastName: true,
    });
  });

  it('returns the ADDRESS composite sub-selection', () => {
    expect(selectionEntryForMirrorKind('ADDRESS')).toEqual({
      addressStreet1: true,
      addressStreet2: true,
      addressCity: true,
      addressPostcode: true,
      addressState: true,
      addressCountry: true,
      addressLat: true,
      addressLng: true,
    });
  });

  it('returns the EMAILS composite sub-selection', () => {
    expect(selectionEntryForMirrorKind('EMAILS')).toEqual({
      primaryEmail: true,
      additionalEmails: true,
    });
  });

  it('returns the PHONES composite sub-selection', () => {
    expect(selectionEntryForMirrorKind('PHONES')).toEqual({
      primaryPhoneNumber: true,
      primaryPhoneCountryCode: true,
      primaryPhoneCallingCode: true,
      additionalPhones: true,
    });
  });

  it('delegates CURRENCY to value-io existing entry', () => {
    expect(selectionEntryForMirrorKind('CURRENCY')).toEqual({
      amountMicros: true,
      currencyCode: true,
    });
  });
});

describe('isMirrorDefinition', () => {
  it('is a mirror for a bare field onto a mirrorable target', () => {
    expect(isMirrorDefinition(parse('status'), 'SELECT')).toBe(true);
  });

  it('is a mirror for a bare cross-ref onto a mirrorable target', () => {
    expect(isMirrorDefinition(parse(`[company:${UUID}:name]`), 'TEXT')).toBe(true);
  });

  it('is not a mirror when the target kind is engine-family', () => {
    expect(isMirrorDefinition(parse('status'), 'NUMBER')).toBe(false);
  });

  it('is not a mirror for a dotted subpath even onto a mirrorable target', () => {
    expect(isMirrorDefinition(parse('amount.amountMicros'), 'SELECT')).toBe(false);
  });

  it('is not a mirror for an IF expression', () => {
    expect(isMirrorDefinition(parse('IF(status = "x", 1, 0)'), 'SELECT')).toBe(false);
  });

  it('is not a mirror when the target kind is missing', () => {
    expect(isMirrorDefinition(parse('status'), null)).toBe(false);
  });
});
