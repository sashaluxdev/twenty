# Field mirroring (pure-mirror formulas) — design

Approved decisions (user, 2026-07-06 chat): pure mirror only (single bare
reference, no operators); type coverage "everything including composites";
relations excluded. Companion spec: `2026-07-06-string-literals-design.md`
(independent feature; mirroring does NOT depend on it — a pure mirror
bypasses expression evaluation entirely).

## Problem

Users want a formula field that simply copies another field — same record or
a specific other record — verbatim: date→date, numeric→numeric,
select→select, links→links. The engine's numeric value domain already covers
numeric/currency/date sources onto numeric-family targets, but no string,
option, boolean, or composite value can flow through a formula today.

## Core concept: mirror mode

A definition is a **mirror** when BOTH hold:

1. Its expression is exactly ONE bare whole-field reference — same-record
   (`status`) or cross-record (`[company:<uuid>:status]`) — with **no
   subpath** (`amount.amountMicros` is NOT a mirror; it's an engine
   expression) and no operators/functions/literals.
2. Its target field's kind is OUTSIDE the engine family
   (engine family = NUMBER, CURRENCY, DATE, DATE_TIME — those keep today's
   engine path unchanged, byte-for-byte, to avoid any behavior shift on
   existing formulas right before a live deploy).

Mirror-mode recompute performs **typed raw passthrough**: fetch the source
field's raw value (with the correct sub-selection for composite kinds —
the `fieldKinds` machinery already does this for CURRENCY), and write it to
the target field verbatim. No coercion, no evaluation, no engine involvement.

## v1 kind allowlist (source kind MUST equal target kind)

TEXT, SELECT, MULTI_SELECT, BOOLEAN, RATING, LINKS, FULL_NAME, ADDRESS,
EMAILS, PHONES, ARRAY, RAW_JSON.

- Same-kind rule is strict in v1: select→select, links→links, etc. Any
  cross-kind pair is rejected at save with a message naming both kinds.
- Everything else (RELATION, ACTOR, RICH_TEXT/RICH_TEXT_V2, POSITION,
  TS_VECTOR, system kinds) is rejected at save: "field kind X cannot be
  mirrored". The allowlist is a single constant so later expansion is a
  one-line change + tests.
- Engine-family kinds are NOT in mirror mode (rule 2 above); a bare ref onto
  a NUMBER target keeps working exactly as today via the engine.

## Semantics

- Null/absent source value → write null (clears the target), consistent with
  engine null-propagation.
- Source record missing (cross-record ref to a deleted/purged record) →
  treated like a null source: write null, no error recorded (exact parity
  with current cross-ref behavior, where a missing record resolves to null
  silently — resolution 2026-07-06 after internals research).
- No-op suppression: deep JSON equality between current target value and
  source value → zero writes (write-avoidance invariant).
- Recompute triggers, hourly sweep, dependency extraction, cycle detection,
  OFFLINE/UPSTREAM status, trash-dead liveness: all reuse the existing
  machinery untouched — a mirror's dependency set is its single ref, which
  the existing extractor already produces from the parsed AST. (The parser
  already accepts a bare ref as a complete expression; mirror detection is a
  pure function over the AST + target kind: `isMirrorDefinition(ast,
  targetFieldKind)`.)
- `usesToday` is false for mirrors; TODAY staleness machinery never fires.

## Overrides and bookkeeping (the two schema touches)

Both the override-restore feature and the heartbeat store values in
NUMBER-typed columns today. Mirrors need non-numeric storage:

- New TEXT field `overrideValueText` on FormulaOverride (system-managed):
  JSON-stringified raw value for mirror targets; existing `overrideValue`
  NUMBER stays authoritative for engine-family targets. Toggle-ON restore
  parses it back.
- New TEXT field `lastValueText` on FormulaDefinition (system-managed,
  `isUIEditable: false`, added to the lockdown list): JSON-stringified,
  truncated to 500 chars (display/heartbeat only, never read back for
  computation). `lastValue` NUMBER stays null for mirrors.
- Human-edit override detection compares deep JSON equality of the written
  value vs the mirrored source value (same value → app echo, ignored;
  different → human override), mirroring the existing compare-value-not-actor
  rule.

## Wizard: "Mirror another field" path

New wizard branch alongside the existing format picker: pick source object →
pick source field (any allowlisted kind) → optionally pick a specific source
record (cross-record mirror; omit = same-record mirror, only offered when
source object == target object). The wizard **clones the source field's
type + settings + options** for the created target field (SELECT/MULTI_SELECT
option sets copied verbatim — value, label, color, position), then seeds the
expression automatically. Cloned-not-linked: later edits to the source
field's options do NOT propagate (documented in README; the save-validation
of literal option values is not involved since mirrors don't use literals).
All selections persist on the definition record for wizard resumability
(existing `targetFieldSettings` pattern).

## Save-time validation (extends existing save pipeline)

- Mirror candidates (bare whole-field ref + non-engine target kind) validate:
  source field exists + kind allowlisted + kinds equal. Failures disable the
  definition with a specific `lastError` (existing validation posture).
- A subpath ref or any operator with a non-engine target kind → NEW
  save-time rejection introduced by this feature. (No such validation exists
  today: `targetFieldKind()` silently defaults unknown kinds to NUMBER and
  failures surface only at write time — this feature closes that latent gap
  for non-engine target kinds.)

## Testing

- `isMirrorDefinition` detection matrix (bare ref × target kinds; subpath,
  operator, literal all non-mirror).
- Passthrough recompute per kind: scalar (TEXT/SELECT/BOOLEAN/RATING), array
  (MULTI_SELECT/ARRAY), composite (LINKS/FULL_NAME/ADDRESS/EMAILS/PHONES,
  RAW_JSON) — fake-client fixtures with realistic composite shapes; no-op
  suppression via deep-equal; null source; missing record.
- Same-kind rejection matrix + allowlist rejection.
- Override detection/restore round trip through `overrideValueText`.
- Heartbeat truncation.
- Wizard clone: option set copied verbatim; resumability seeding.
- Integration (live verify): select→select and links→links mirrors on real
  records, cross-record update propagation, override toggle.

## Out of scope (explicit)

RELATION/ACTOR/RICH_TEXT mirroring; cross-kind coercion (text→select);
option-set sync after clone; mirror + IF branching (rejected in scoping);
per-record source records (the cross-record source is one fixed record ID
per definition, as with existing cross-refs).
