# ADR 0026: String values and `&` concatenation

**Status: IMPLEMENTED (design approved 2026-07-28; implemented 2026-08-04).**
Design doc: `docs/plans/2026-07-28-string-output-design.md`. Implementation plan:
`docs/plans/2026-07-31-string-output-implementation.md` (9 tasks; execution
ledger `docs/plans/2026-07-31-string-output-execution-ledger.md`).

## Context

Formulas could only ever produce a number (or a number-shaped composite —
CURRENCY micros, DATE/DATE_TIME epoch-days). A field like `AC-INV20665` — a
formula concatenating a prefix, an invoice number, and today's date — was
inexpressible, and so was a label formula like
`IF(amount > 50000, "Hot", "Cold")`. String literals existed only as
`=`/`!=` comparison operands (ADR 0017's `parseConditionOperand`), resolved
through a parallel `resolveRaw: RawVariableResolver` channel that never fed
the public `number | null` value domain.

Separately, "mirror mode" (design 2026-07-06) let a bare field reference copy
a non-numeric field (SELECT, BOOLEAN, LINKS, TEXT, …) verbatim onto a target
of the same kind, bypassing the engine entirely. TEXT sat in that mirror
allowlist, so a TEXT target could only ever be "copy this other TEXT field" —
never a computed value. That split produced eleven separate mirror-vs-engine
forks across the write path (enumerated below), each independently
maintained and each a candidate for the two lanes to drift.

This ADR widens the engine's value domain to `number | string | null`, adds
`&` concatenation, and unifies the write path so any expressible target kind
(NUMBER, CURRENCY, DATE, DATE_TIME, now TEXT) is evaluated by one engine
instead of splitting on "is this a mirror."

## Decision

### D1–D5 (locked in the design doc, adopted as specified)

- **D1 — strings are first-class values.** String literals are legal in any
  value position (IF/IFS/SWITCH branches, `&` operands, `IFBLANK` arguments),
  not just beside `=`/`!=`. No `TEXT()` formatting function ships in this
  version — a date/datetime reaching a text context renders as its serial
  number (see "Not done").
- **D2 — null coerces to `""` inside `&` only.** Kleene null propagation is
  untouched everywhere else; `&` is the one deliberate exception
  (`evaluator.ts`, `case 'concat'`).
- **D3 — dynamic typing, format-driven output.** There is no static type
  inference over the AST. The *target field kind* decides coercion at the
  write boundary (`normalizeComputedValue`, `buildTargetWriteData` in
  `value-io.ts`), exactly as before this ADR for numeric/date targets.
- **D4 — full unification of the write path.** The mirror-vs-engine binary
  dissolves into one tagged-value pipeline (`ComputedValue` — see below); "is
  this target expressible" is now the single fork, decided once per
  definition rather than re-derived at each of the eleven sites.
- **D5 — v1 targets TEXT only.** SELECT output is the explicitly designated
  next-version feature (final section).

### Grammar: the `&` tier

`&` is a new single-character token (`SINGLE_CHAR_TOKENS`, no lookahead — no
`&&`). It introduces the loosest tier of the value grammar,
left-associative: `concat := expression ('&' expression)*`. Full precedence,
tightest to loosest:

```
parens / primaries → unary → * / % → + - → & → comparisons (condition slots only)
```

`&` binds tighter than `=`/`!=`, so `a & "-x" = code` parses as
`(a & "-x") = code` — the concatenation, then the comparison. Every
value-context call site that used to call `parseExpression()` directly now
calls `parseConcat()` (top-level `parse()`, IF/IFS/SWITCH branches and value
slots, SUM/IFBLANK arguments, comparison operands): the parser's single
`private parseConcat()` flattens a chain into one `ConcatNode` with 2+ flat
`parts`, so nesting depth does not grow with the number of `&`s in a chain.
`STRING` is now a legal `parsePrimary` alternative unconditionally (it used
to throw outside `parseConditionOperand`); the string-only special-casing for
comparison operands (`parseConditionOperand`, the lone-string rejections in
`parseCondition`/`parseSwitch`, `stringOutsideConditionError`) is gone —
comparison operands are ordinary `parseConcat()` results now. The syntactic
rejection of a string literal directly beside an ordering operator
(`Strings support only = and != comparisons`) stays, because ordering has no
sensible string semantics; it does not apply to a concat *result*.

### Coercion: `coerceToEngineValue` is semi-eager

The old `coerceToNumber` coerced every string at resolve time: date-shaped →
serial, numeric-shaped → `Number()`, anything else → `NON_NUMERIC_VALUE`
(including `""`). Keeping that fully eager for the new `number | string |
null` domain would destroy the feature (a zip code `"01234"` would render as
`"1234"` inside `&`); going fully lazy would break deployed date comparisons
(`closeDate = TODAY()` would go cross-type false).

`coerceToEngineValue` (`coercion.ts`, beside the still-exported
`coerceToNumber`) resolves the middle ground:

- **Dates stay eager.** A date-only or ISO-datetime-shaped string still
  becomes its epoch-day serial at resolve time, in every context — identical
  to today's behavior.
- **Numeric-shaped and all other strings resolve lazily**, verbatim as text.
  A numeric context (`+ - * / %`, unary, ordering, SUM, condition
  truthiness) coerces via `Number()` at point of use (the evaluator's
  internal `toNumber`), so `zip + 1` still works but `zip` itself renders as
  `"01234"`, leading zeros intact.
- **Empty/whitespace strings resolve as text**, not as a resolve-time throw —
  a blank TEXT field is `""`, not an error.

Behavior deltas this produces (all locked by design or accepted and pinned
by test — see the ledger's 2026-08-03/04 entries for the review trail):

- **B1** (design-locked): `=`/`!=` are typed and non-coercing —
  `42 = "42"` is false, `"42" != 42"` is true; a null operand still
  null-propagates.
- **B2** (accepted edge): a TEXT field whose content is exactly date-shaped
  (`YYYY-MM-DD` or ISO datetime) coerces to its serial in *every* context,
  including `&` and TEXT one-term formulas — existing precedent, since such
  content already evaluated as a serial in arithmetic before this ADR.
  Pinned in `recompute.spec.ts` ("coerces date-shaped content to its serial
  (documented B2 edge)").
- **B3** (accepted, narrow): a field whose raw value arrives as a
  numeric-shaped *string* no longer numerically equals a number literal in
  `=`/`!=`. Arithmetic, ordering, SUM, and truthiness are unchanged
  (point-of-use coercion); write-boundary coercion (`"42"` into a NUMBER
  target) still succeeds.
- **B4** (improvement): `textFieldA = textFieldB` now compares text-to-text
  instead of erroring; a string-vs-number comparison yields `false` rather
  than null-propagating through the old raw-resolver channel.
- **B5** (design-locked): deployed TEXT mirrors keep verbatim behavior for
  everything except B2 content, since numeric-shaped strings stay lazy —
  `"042"` still mirrors as `"042"`.

### Typed, non-coercing equality

`evaluateConditionTruth`'s comparison case evaluates both operands into the
value domain and, for `=`/`!=`, compares with plain `===`/`!==` — a
cross-type pair (`number` vs `string`) is simply unequal by construction, no
separate `typeof` branch needed. Ordering (`< <= > >=`) still coerces both
sides via `toNumber` and is numeric-only, matching pre-ADR behavior.

### `TEXT_TOO_LONG`: a computed-text-only guard

A new `FormulaErrorCode` (`errors.ts`) — additive-safe, since no switch in
the codebase is exhaustive over the union. `MAX_COMPUTED_TEXT_LENGTH = 10_000`
(`engine/text-format.ts`) bounds only the running result of `&`, checked
after each part is appended so a runaway formula-on-formula chain cannot
build an unbounded string before failing. A long TEXT field flowing through
a one-term formula or an IF branch is **not** capped — the cap exists to stop
concatenation chains from compounding, not to limit field length, preserving
mirror parity for plain TEXT passthrough. Standard eval-error doctrine
applies: last value kept, error surfaced on `lastError`.

Numbers render inside `&` (and at the TEXT write boundary) via
`formatNumberAsText` (`engine/text-format.ts`): integers bare (`42`, never
`42.0`), up to 15 significant digits with trailing float dust trimmed
(`0.1 + 0.2` → `"0.3"`), falling back to JS's default representation outside
that precision's safe range (`1e21` → `"1e+21"`). Dates/datetimes reach this
function already coerced to serial numbers, so they render as serials — no
date formatting in `&` (see "Not done").

### Target-kind dispatch replaces eleven mirror-vs-engine forks

The evidence pass that preceded implementation found eleven independent
fork points, not the design doc's estimated seven (all corrected before
Task 4 began — see the implementation plan's "Background" section):

| # | Fork | Before | After |
|---|---|---|---|
| F1 | Compute lane split | `computeFormulaValueForRecord` vs `computeMirrorValueForRecord`, chosen per-record | Still two functions (mirror stays a genuine raw passthrough for non-expressible kinds), but the choice is `isMirrorTargetKind(targetFieldType)` — TEXT now always takes the engine path |
| F2 | Write-plan dispatch (`recompute.ts`) | Branch on `isMirrorFormula` | Same branch, but TEXT no longer satisfies `isMirrorTargetKind` so it falls to the engine branch unconditionally |
| F3 | Normalization | Numeric rounding per format vs verbatim raw copy | `normalizeComputedValue`/`targetFieldKind` dispatch on `TargetFieldKind` (`NUMBER \| CURRENCY \| DATE \| DATE_TIME \| TEXT`); TEXT renders numbers via `formatNumberAsText`, passes strings through, and keeps null |
| F4 | Convergence compare | `deepJsonEqual` (mirror) vs `valuesEqual` (engine, `===`) | One `valuesEqual` (`EngineValue`, strict `===`) covers both scalar domains; `deepJsonEqual` remains only for genuinely composite mirror kinds |
| F5 | Outcome shape | `RecomputeOutcome.value` (number) vs `.rawValue` (unknown) — two fields | One tagged `ComputedValue = {kind:'number'\|'text'\|'raw', value}` (`types.ts`); every consumer dispatches on `.kind` |
| F6 | Heartbeat column | Re-parse-based `isMirrorHeartbeat` picking `lastValue` vs `lastValueText` | Dispatches on the sampled `ComputedValue.kind` directly — `number` → `lastValue`, `text`/`raw` → `lastValueText`; `isMirrorHeartbeat` deleted |
| F7 | Override detection | Numeric formula-compare path vs mirror raw-compare path | TEXT targets take the formula path with strict *string* comparison instead of `numbersEqual` |
| F8 | Override storage slot | `overrideValue` (numeric kinds) vs `overrideValueText` (mirror kinds), chosen by re-parsing the expression | `overrideSlotForKind(kind, value)` (`override-repository.ts`) — target-kind-driven: TEXT and raw kinds → `{text: JSON.stringify(value ?? null)}`, numeric kinds → `{numeric: value}` |
| F9 | Scan-page selection | Mirror vs engine branch in `scan-selection.ts` | TEXT-target definitions take the engine branch; the GraphQL selection for a TEXT dependency/target is the scalar, same as any other engine field |
| F10 | Prefetch trust | Mirror lane could not trust the event's prefetched `after` for some cases; engine lane always could | TEXT joining the engine lane picks up the engine's prefetch trust — one fewer refetch, verified as a strict improvement in the event-driven test |
| F11 | Save-validation branch 1c | Duplicated in `save-validation.ts` (backend) and `validate-expression.ts` (frontend) | Collapsed into one `validateExpressionCore` in `src/logic-functions/lib/validation-core.ts`; both wrappers call it, error messages unchanged |

### `overrideValueText`/`lastValueText`: JSON conventions kept for back-compat

Deployed TEXT mirrors already wrote `overrideValueText = JSON.stringify(raw)`
(decoded via `decodeMirrorOverrideValue`) and `lastValueText =
mirrorValueText(raw)` (JSON-stringified, 500-char-capped,
`formula-repository.ts`). Both conventions are **unchanged** by this ADR —
`overrideSlotForKind` and the heartbeat's text branch still produce exactly
that JSON encoding for TEXT and raw kinds alike — so a deployed TEXT-mirror
override or heartbeat round-trips through the new lane with zero data
rewrite. No new columns, no migration.

### Dirty-data corner (T7 constraint 2)

A TEXT mirror whose underlying source value arrives as a non-string scalar
(a number or boolean — possible when the source field's *kind* is TEXT but a
prior write left non-string data) used to copy that value verbatim onto the
target. Now it goes through `coerceToEngineValue` then
`normalizeComputedValue('TEXT', …)`: a number renders through
`formatNumberAsText` (canonical decimal text) and a boolean becomes `"1"`/
`"0"`. Accepted as a strict improvement (dirty data now renders through the
same canonical rules a formula would use) and pinned in `recompute.spec.ts`
("renders a dirty non-string scalar canonically (accepted delta)").

## Consequences

### Behavior deltas discovered during execution (B6–B8)

Beyond B1–B5 (design-locked), three further deltas surfaced during Tasks 4–8
and were adjudicated and accepted rather than repaired — each is a forced
consequence of a design-locked rule, not an implementation bug:

- **B6.** A cross-record DATE/DATE_TIME reference compared with `=` against a
  text literal is now silently `false`. This is B2's eager date coercion
  (the cross-record value resolves to a serial number) combined with B1's
  typed non-coercing equality (`number = string` is false by construction).
  A same-record equivalent is rejected at save time by the existing
  string-comparison validation rule; cross-record refs are deliberately
  exempt from that check (unchanged by this ADR) because the target field's
  kind is not known without a fetch. Pinned in `evaluator.spec.ts`
  ("compares a date-shaped cross-record value against a text literal as
  FALSE (B6)").
- **B7.** An unresolvable operand in a text comparison (e.g. a dotted
  composite subpath that does not exist) now throws `UNKNOWN_VARIABLE`,
  where the old string-mode raw resolver null-propagated it to blank. This
  aligns the text lane with the numeric lane's existing typo-protection
  behavior — an unknown field is a formula bug, not blank data — rather than
  silently swallowing it. Pinned in `evaluator.spec.ts`.
- **B8.** TEXT fields are no longer pickable as a wizard mirror *source*
  (`pickableMirrorSourceFields` filters by `isMirrorTargetKind`, which T7
  flipped for TEXT). This is the intended shape of the arc: the sanctioned
  path for "copy this TEXT field" is the Text output format with the
  one-term formula `thatField`, which `seedMirrorExpression` already
  produces. Pre-existing TEXT mirror drafts still resume via unfiltered
  re-resolution. Escape hatch if a one-click TEXT-mirror picker is wanted
  back later: a picker allowlist union (`MIRRORABLE_KINDS ∪ {'TEXT'}`) —
  cheap, not built.

### Other observable consequences

- **IFBLANK blankness widened.** `IFBLANK` used to substitute its fallback
  only for `null`. It now shares `ISBLANK`'s blankness rule (`isBlankValue`
  in `evaluator.ts`): a whitespace-only string also counts as blank. The two
  functions previously disagreed on this point (ADR 0017 called it out as a
  "deliberate asymmetry"); that asymmetry is gone.
- **Invalid-config heartbeat divergence.** A TEXT-target definition whose
  expression fails to parse writes its heartbeat to `lastValueText` (the
  `text`-kind slot, since `targetFieldKind('TEXT') === 'TEXT'` regardless of
  parse success), where the pre-ADR numeric lane for a comparable
  misconfigured definition would have written (or left untouched) `lastValue`.
  A minor, purely observable divergence in which bookkeeping column reflects
  the error — no data-correctness impact, since `lastError` carries the
  actual diagnostic either way.
- **No page-level fail-fast for a deleted source field on the engine lane.**
  The old mirror lane had a page-level fail-fast when a mirror's source field
  was deleted mid-scan. The engine lane, which a TEXT formula now always
  uses, has no equivalent — a TEXT formula over a deleted field degrades per
  the engine's standard eval-error doctrine (`UNKNOWN_VARIABLE` per record,
  `lastError` set, last value kept) rather than failing the whole scan page
  early. This is lane-consistent (every other engine-family target already
  behaved this way) rather than a regression specific to TEXT.
- **Grammar: nesting budget roughly halves in value contexts.** `parseConcat`
  calls `enter()` and then always delegates to `parseExpression()`, which
  calls `enter()` again — one redundant depth frame per value-context
  descent, that could not be trivially removed without either bypassing
  `parseConcat` for the no-`&` case (breaking the uniform value-tier entry
  point) or restructuring `parseExpression`'s own recursion. Measured
  boundaries: 99 nested parentheses accepted / 100 throws (was ~199), 65
  nested `IF`s accepted / 66 throws (was ~99) — both against
  `MAX_PARSE_DEPTH = 200`. Far beyond any human-authored formula; pinned by
  boundary tests in `parser.spec.ts` ("accepts 99 nested parentheses but
  rejects 100", "accepts 65 nested IFs but rejects 66") so a future
  regression in either direction is caught rather than silently drifting.

## Not done

- **`TEXT()` formatting function.** Dates/datetimes concatenate as their raw
  serial numbers; no date-formatting escape hatch ships in this version.
- **Date formatting in `&`.** Same reason — no format string, no locale
  handling; a future `TEXT()` (Excel-style) would be the natural place for
  it.
- **Kind-aware field resolution.** The escape hatch that would let a
  resolver disambiguate B2/B3-style edges by consulting the *source* field's
  metadata kind rather than pattern-matching its raw value. Not built;
  noted here so a future edge-case report against B2/B3/B6 has a named
  starting point instead of re-deriving the option from scratch.
- **SELECT output.** Deliberately deferred to the next version — see below.

## Next version: SELECT output

Per the design doc's closing section and the implementation plan's final
note: SELECT joins the expressible bucket as a text-kind target with one
extra write-time step (the computed string must match a defined option
value, else standard eval-error doctrine applies). Storage, convergence, and
override detection already ride the text columns built here — the unified
pipeline in this ADR was chosen partly to make that nearly free on the
backend. The remaining work is almost entirely the wizard: an options editor
(values, labels, colors) mirroring Twenty's native SELECT creation, plus
post-creation settings editing. The arc's next step is the SELECT design
brainstorm.
