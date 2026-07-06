import { type AstNode, bareReferenceOf } from 'src/engine';
import {
  ENGINE_FAMILY,
  selectionEntryForFieldKind,
} from 'src/logic-functions/lib/value-io';

// Mirror mode (design 2026-07-06): a definition whose expression is a single
// bare whole-field reference, written onto a target field OUTSIDE the engine's
// numeric family, performs a typed raw passthrough instead of engine evaluation.
// This module owns the app-domain knowledge that mirroring needs — the kind
// allowlist and the composite sub-selection shapes — which the pure engine
// (bareReferenceOf) deliberately does not carry.

// v1 allowlist: source kind MUST equal target kind (select->select, links->links,
// etc.). A single constant so later expansion is a one-line change + tests.
export const MIRRORABLE_KINDS: ReadonlySet<string> = new Set([
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
]);

// The engine's numeric value family, DERIVED from value-io's ENGINE_FAMILY (the
// single source of truth — FM Task 1 rider) so the two can never drift. A bare
// ref onto one of these keeps today's engine path unchanged — it is NOT mirror
// mode.
export const ENGINE_FAMILY_KINDS: ReadonlySet<string> = new Set(ENGINE_FAMILY);

export const isMirrorTargetKind = (kind: string): boolean =>
  MIRRORABLE_KINDS.has(kind);

// GraphQL sub-selection for reading a mirror source of the given kind. Scalars
// and array-valued scalars (MULTI_SELECT/ARRAY/RAW_JSON) select as `true`;
// composites need their explicit sub-fields (property names transcribed verbatim
// from the server composite-type definitions). CURRENCY reuses value-io's entry.
export const selectionEntryForMirrorKind = (
  kind: string,
): true | Record<string, boolean> => {
  switch (kind) {
    case 'CURRENCY':
      return selectionEntryForFieldKind('CURRENCY');
    case 'LINKS':
      return {
        primaryLinkLabel: true,
        primaryLinkUrl: true,
        secondaryLinks: true,
      };
    case 'FULL_NAME':
      return { firstName: true, lastName: true };
    case 'ADDRESS':
      return {
        addressStreet1: true,
        addressStreet2: true,
        addressCity: true,
        addressPostcode: true,
        addressState: true,
        addressCountry: true,
        addressLat: true,
        addressLng: true,
      };
    case 'EMAILS':
      return { primaryEmail: true, additionalEmails: true };
    case 'PHONES':
      return {
        primaryPhoneNumber: true,
        primaryPhoneCountryCode: true,
        primaryPhoneCallingCode: true,
        additionalPhones: true,
      };
    default:
      return true;
  }
};

// True when this definition is a mirror: the whole expression is a bare
// whole-field ref AND the target kind is in the mirror allowlist (which by
// construction excludes the engine family). A null/unknown target kind is not
// mirrorable.
export const isMirrorDefinition = (
  ast: AstNode,
  targetFieldType: string | null | undefined,
): boolean =>
  bareReferenceOf(ast) !== null && isMirrorTargetKind(targetFieldType ?? '');
