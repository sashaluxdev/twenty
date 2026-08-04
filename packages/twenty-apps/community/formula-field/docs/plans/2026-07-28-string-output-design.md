# String Output and & Concatenation: Design

Date: 2026-07-28
Status: implemented by docs/plans/2026-07-31-string-output-implementation.md
Implementation must author ADR 0026 (string values + concatenation) and refresh the stale ADR index.

## Goal

Formulas can produce text: `aString & "INV" & 1+TODAY()` writes `"ACME-INV20664"` into a runtime-created TEXT field via a new "Text" output format. Also unlocks label formulas: `IF(amount > 50000, "Hot", "Cold")`.

## Guiding principles (from the user)

1. The simplest effective solution wins.
2. Efficiency is sacred: never loop where a batch will do; always look for the easier way first.
3. Convention first: adopt proven answers (OpenFormula/Excel semantics) before inventing.
4. No deference to legacy: refactor what stands in the way of the best design.

## Locked decisions

- **D1 Strings as first-class values.** String literals legal anywhere a value goes; IF/IFS/SWITCH branches may return text. No TEXT() formatting function in v1 (dates concat as serials).
- **D2 Null coerces to `""` inside `&` only** (OpenFormula/Excel convention). Kleene null propagation untouched everywhere else.
- **D3 Dynamic typing, format-driven output.** No static type inference. The target format decides coercion at the write boundary.
- **D4 Full unification of the write path** (mirror-vs-engine binary dissolved into one tagged-value pipeline).
- **D5 v1 targets TEXT only.** SELECT output is the designated next-version feature (see final section).

## Language specification

### Grammar

- New token `&` (single-char, no lookahead).
- New loosest-precedence tier, left-associative, per OpenFormula: `concat := additive ('&' additive)*`. Precedence tightest to loosest: parens, primaries, unary, `* / %`, `+ -`, `&`, comparisons (condition slots only).
- STRING becomes a legal primary (any value position), removing the comparison-operand-only restriction.
- Comparison operands are concat-level: `a & "-x" = code` parses, `&` binds tighter than `=`.

### Coercion (context-driven, extends the existing rule)

- **In `&`:** operands coerce to text. Numbers render as canonical decimals: up to 15 significant digits, trailing noise trimmed, integers bare (`42` renders `"42"`, never `"42.0"` or float dust). Dates/datetimes render as their serial numbers. BOOLEAN fields render `"1"`/`"0"` (via their existing numeric coercion). Null renders `""`.
- **In arithmetic and `< <= > >=`:** unchanged, numeric-only; non-numeric text raises NON_NUMERIC_VALUE at eval time.
- **In `=` / `!=`:** text compares to text (case-sensitive, as today), number to number. Cross-type equality (`42 = "42"`) is false (`!=` true), matching Excel's non-coercing `=`. A null operand still null-propagates.

### Functions

- IF/IFS/SWITCH: branches and values may be text; condition semantics unchanged.
- IFBLANK: generalizes to text; returns the fallback when the value is null or a whitespace-only string (consistent with ISBLANK's blankness rule).
- ISBLANK: already text-aware; a computed `""` is blank.
- SUM, TODAY: numeric only, unchanged.
- AND/OR/NOT: unchanged, condition-only, Kleene.

### Guards

- Per-literal cap stays at 100 chars.
- New eval-time cap: a computed string longer than 10,000 chars raises a new error code `TEXT_TOO_LONG` (runaway valve for formula-on-formula chains). Standard eval-error doctrine applies (last value kept, error on definition).

## Unified value pipeline (approach C)

One tagged value flows end-to-end:

```
ComputedValue =
  | { kind: 'number', value: number | null }
  | { kind: 'text',   value: string | null }
  | { kind: 'raw',    value: unknown }
```

**The single dispatch rule, stated once:** if the target field kind is expressible (NUMBER, CURRENCY, DATE, DATE_TIME, TEXT), the expression is evaluated by the engine; for any other kind (BOOLEAN, SELECT, composites) the expression must be a bare field reference and the value passes through raw. "Mirror another field" remains a wizard entry point but stops being an execution lane; mirroring a TEXT field becomes the one-term formula `thatField`.

Each of the seven current mirror-vs-engine forks becomes one dispatch on `kind`:

| Concern | number | text / raw |
|---|---|---|
| Normalization | micros / serial / rounding per format | verbatim string (raw per existing mirror rules) |
| Convergence compare | numeric-normalized equality | strict string equality (existing mirror compare for raw) |
| Override storage | `overrideValue` | `overrideValueText` |
| Heartbeat | `lastValue` | `lastValueText` |
| Editor display | numeric formatting | string verbatim |

No new columns, no data migration. Deployed formulas and mirrors behave identically; existing mirror/handler suites are the regression net for the refactor.

**Validation dedup:** the copy-pasted dispatch logic in backend `save-validation.ts` and frontend `validate-expression.ts` collapses into one shared module beside the engine (both sides already import from `src/engine`). The existing save-time rejection of string comparison against fields that cannot hold strings stays as-is.

**Write semantics:** null result clears the field (existing doctrine). `""` writes as an empty string, following current mirror behavior for TEXT. A text result reaching a numeric/date target runs through the existing numeric coercer (`"42"` succeeds, `"INV42"` is NON_NUMERIC_VALUE, last value kept).

## Frontend

- New `text` entry in `OUTPUT_FORMATS` targeting TEXT field kind; the wizard is data-driven off this array, no display options needed for v1.
- Editor display gains the string branch (currently a bare `as number` cast).
- Frontend validation updates come free via the shared validation module.

## Testing

- Engine: `&` tokenization; precedence and string-primary parsing (including condition operands); the full `&` coercion matrix (numbers, serials, booleans, null-to-`""`); cross-type equality; TEXT_TOO_LONG; IFBLANK text blankness.
- Write path: text lane through recompute, convergence skip, override detection, heartbeat; shared-validation parity; all existing mirror and numeric suites must pass unchanged or with mechanical updates only.
- Behavior cross-checks against HyperFormula and Gnumeric test expectations (clean-room, behavior only, no GPL code copied).

## Rollout

- Version bump to 0.2.0 (first language-surface expansion).
- Cloud deploy per the SDK/platform matching rule (npm twenty-sdk on the hosted platform line).
- After deploy: update the formulahelp skill's `reference.md`, whose hard truth #1 ("formulas can never output text") becomes false.

## Next version: SELECT output (explicit commitment)

The next planning cycle starts here, per user decision. SELECT joins the expressible bucket as a text-kind target with one extra write-time step: the computed string must match a defined option value, otherwise standard eval-error doctrine applies. Storage, convergence, and override detection already ride the text columns; the unified pipeline was chosen partly to make this nearly free on the backend. The remaining work is almost entirely the wizard: an options editor (values, labels, colors) mirroring Twenty's native SELECT creation, plus post-creation settings editing. The v1 implementation plan must end with an explicit reminder of this commitment.
