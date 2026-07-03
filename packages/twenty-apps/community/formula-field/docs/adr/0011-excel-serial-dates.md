# ADR 0011 — Dates as Excel serial numbers (epoch-days)

- Status: Accepted
- Date: 2026-07-03

## Context

Formulas need to work with DATE and DATE_TIME fields — both as inputs
(`closeDate + 30`, `IF(signedDate > closeDate, …)`) and as output targets (a
formula whose value field is a date). The earlier recommendation was a
tagged-union value domain (a `date` value distinct from `number`), which would
have rippled through the whole stack the way ADR 0010 was careful to avoid: the
engine's public domain, value-io, both convergence comparison sites, and the
override detector all assume `number | null`.

The user decided on 2026-07-03 to adopt the **Excel serial-number model**
instead, superseding the tagged-union recommendation: a date simply **is** a
number. This keeps the engine (`src/engine/`) entirely untouched — no new value
kind, no new node type, no new coercion inside the interpreter — and confines
all date handling to the resolver/value-io boundary that already normalizes
CURRENCY micros.

## Decision

- **Internal representation: fractional days since the Unix epoch**
  (1970-01-01 UTC — NOT Excel's 1900 epoch). A DATE is a whole epoch-day
  integer; a DATE_TIME is fractional (`epochMs / 86_400_000`). All arithmetic is
  plain number math: `+ 1` is one day, `+ 1/24` is one hour,
  `dateA - dateB` is a day count.
- **All conversion is UTC-only** (`Date.UTC` / `getTime` / `toISOString`), never
  local-`Date` component math. This is a hard rule: local math is a DST hazard
  (an hour that repeats or vanishes) and would make results depend on the
  server's timezone. `src/logic-functions/lib/date-serial.ts` is the single
  conversion chokepoint.
- **Read path (`coercion.ts`)**: `coerceToNumber` recognizes date strings by
  PATTERN, kind-agnostic (consistent with its existing leniency where a numeric
  string already parses). A string matching `^\d{4}-\d{2}-\d{2}$` parses as
  whole UTC epoch-days; a string matching an ISO 8601 datetime (with `T`,
  optional milliseconds, `Z` or a `±hh:mm` offset) parses via `Date.parse` to
  fractional epoch-days. An impossible date (`2026-13-45`, `2026-02-30`) throws
  `NON_NUMERIC_VALUE` rather than silently producing NaN — day-only strings are
  validated by round-tripping the parsed UTC components. Because the pattern is
  kind-agnostic, a formula reads a date the same way whether the reference is
  typed DATE or arrives as a date-shaped string.
- **Write path (`value-io.ts`)**: `TargetFieldKind` widens to
  `NUMBER | CURRENCY | DATE | DATE_TIME`. For a DATE target,
  `normalizeComputedValue` **floors** to a whole epoch-day and
  `buildTargetWriteData` serializes back to `"yyyy-MM-dd"` (UTC). For a
  DATE_TIME target it rounds to a whole millisecond and serializes to an ISO UTC
  string. `normalizeStoredValue` parses the stored scalar back to epoch-days
  (via `coerceToNumber`) so stored and computed values always compare in one
  representation.
- **The rewrite-forever trap is closed at BOTH comparison sites.** As with the
  CURRENCY-micros precedent, a value that is compared in one representation but
  stored in another would never converge (recompute would rewrite forever) and
  the app's own write would look like a human override. Both sites already
  funnel their operands through the normalize functions, so no new comparison
  wiring was needed: `recompute.ts` compares
  `normalizeStoredValue(currentRaw)` against
  `normalizeComputedValue(targetFieldType, computed.value)` (exact `===`);
  `handle-record-update.ts` compares `normalizeComputedValue(…)` against
  `normalizeStoredValue(after[field])` (1e-9-epsilon `numbersEqual`). For DATE
  both operands are whole epoch-days; for DATE_TIME both are millisecond-rounded
  epoch-days, and the store→parse→normalize round-trip is float-stable.
- **`FieldMetadataType` scalars**: DATE serializes as the timezone-free
  `"yyyy-MM-dd"` scalar; DATE_TIME as an ISO UTC datetime. Neither is a
  composite field, so — unlike CURRENCY — dependency fetching needs no
  sub-selection (`selectionEntryForFieldKind` returns `true` for both).
- **Wizard formats**: two new output formats, `date` (creates a DATE field) and
  `datetime` (creates a DATE_TIME field). Like CURRENCY, neither needs field
  `settings` or a `defaultValue` — the server validator for DATE / DATE_TIME is
  `DEFAULT_NO_VALIDATION`.
- **Overrides**: `overrideValue` stays a NUMBER column and stores the normalized
  epoch-days value unchanged. The restore path re-serializes through
  `buildTargetWriteData`, so a restored date is written as its scalar, never as a
  raw day count into a DATE field.
- **`lastValue` heartbeat stays numeric epoch-days** — no change. It is a
  diagnostic; showing the serial number there is acceptable.

## Consequences

- **The engine is untouched.** No new value kind means value-io, both
  convergence comparison sites, no-op suppression, override detection, and cycle
  detection all keep comparing plain numbers.
- **Excel-identical ergonomics.** `closeDate + 30` is 30 days later;
  `renewal - closeDate` is a day count; `IF(signedDate > closeDate, …, …)` works
  because dates compare as numbers at an IF condition's top level (ADR 0010).
- **Silently-wrong-type tradeoff (deliberate, Excel-style).** Because a date is
  just a number, nonsensical operations are not rejected: `birthDate * 2`
  computes a meaningless serial number and, on a DATE target, floors and writes
  it as some far-future date. There is no type system to catch this — the same
  tradeoff Excel makes. Documented in the README; the price of keeping the
  engine number-only.
- **DATE flooring loses the time component** on a DATE target: a formula that
  produces a fractional day writes only the calendar day. Use a DATE_TIME target
  to keep the time. This matches the DATE scalar, which has no time.
- **UTC semantics can surprise near midnight.** A DATE_TIME at
  `2026-07-03T23:30:00Z` and a wall-clock `2026-07-04T01:30:00+02:00` are the
  same instant and floor to the same UTC DATE (the 3rd), even though one local
  date reads as the 4th. This is intentional and DST-immune; there is no
  per-workspace timezone applied.
