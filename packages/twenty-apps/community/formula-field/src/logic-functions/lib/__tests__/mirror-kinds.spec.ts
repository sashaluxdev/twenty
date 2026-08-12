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

  it('holds exactly ten kinds — TEXT left the lane (ADR 0026), SELECT joined it (ADR 0029)', () => {
    expect([...MIRRORABLE_KINDS].sort()).toEqual([...allowed].sort());
  });

  // TEXT and SELECT both join the engine family's rejected list: a bare-ref
  // target on either is now a one-term ENGINE formula, not a mirror passthrough.
  it.each([
    'TEXT',
    'SELECT',
    'NUMBER',
    'CURRENCY',
    'DATE',
    'DATE_TIME',
    'RELATION',
    'ACTOR',
    'RICH_TEXT',
  ])('rejects %s as a mirror target kind', (kind) => {
    expect(MIRRORABLE_KINDS.has(kind)).toBe(false);
    expect(isMirrorTargetKind(kind)).toBe(false);
  });
});

describe('ENGINE_FAMILY_KINDS', () => {
  it('is exactly value-io TargetFieldKind family', () => {
    expect([...ENGINE_FAMILY_KINDS].sort()).toEqual([
      'CURRENCY',
      'DATE',
      'DATE_TIME',
      'NUMBER',
      // SELECT joined here too (ADR 0029): the engine expresses text end-to-end
      // and both TEXT and SELECT write through the same string domain.
      'SELECT',
      'TEXT',
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
  // The lane switch (ADR 0029): a bare SELECT ref is now an engine one-term
  // formula, not a mirror — MULTI_SELECT stays mirrorable and covers the
  // bare-ref-onto-mirrorable-target shape instead.
  it('is not a mirror for a bare field onto a SELECT target', () => {
    expect(isMirrorDefinition(parse('status'), 'SELECT')).toBe(false);
  });

  it('is a mirror for a bare field onto a MULTI_SELECT target', () => {
    expect(isMirrorDefinition(parse('status'), 'MULTI_SELECT')).toBe(true);
  });

  it('is not a mirror for a bare cross-ref onto a SELECT target', () => {
    expect(isMirrorDefinition(parse(`[company:${UUID}:select]`), 'SELECT')).toBe(
      false,
    );
  });

  it('is not a mirror when the target kind is engine-family', () => {
    expect(isMirrorDefinition(parse('status'), 'NUMBER')).toBe(false);
  });

  // The lane switch: a deployed TEXT mirror (bare same-record ref or bare
  // cross-ref) is now an engine one-term formula, not a mirror.
  it('is not a mirror for a bare ref onto a TEXT target', () => {
    expect(isMirrorDefinition(parse('name'), 'TEXT')).toBe(false);
    expect(isMirrorDefinition(parse(`[company:${UUID}:name]`), 'TEXT')).toBe(
      false,
    );
  });

  it('is not a mirror for a dotted subpath even onto a mirrorable target', () => {
    expect(isMirrorDefinition(parse('amount.amountMicros'), 'LINKS')).toBe(false);
  });

  it('is not a mirror for an IF expression', () => {
    expect(isMirrorDefinition(parse('IF(status = "x", 1, 0)'), 'LINKS')).toBe(false);
  });

  it('is not a mirror when the target kind is missing', () => {
    expect(isMirrorDefinition(parse('status'), null)).toBe(false);
  });
});

it('SELECT rides the engine family, not the mirror lane (ADR 0029 D1)', () => {
  expect(MIRRORABLE_KINDS.has('SELECT')).toBe(false);
  expect(ENGINE_FAMILY_KINDS.has('SELECT')).toBe(true);
});
