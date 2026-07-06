# String literals in the formula engine — design

Approved by user 2026-07-06 (chat). Decisions: comparison-operand-only scope;
raw-option-value case-sensitive matching (core-filter-aligned); SELECT option
autocomplete included. Standing constraint: keep the design in line with the
Twenty core source — matching semantics mirror core view filters, editor UX
reuses core's label+value presentation patterns.

## Problem

The engine's value domain is `number | null`; quotes are illegal tokens. So
conditions on SELECT/TEXT fields (`IF(stage = "QUALIFIED", 100, 0)`) cannot be
expressed — users must maintain numeric companion fields.

## Scope

Strings are **transient comparison operands only**, exactly like comparisons
themselves (legal only at an IF condition's top level, per ADR 0010):

- A string literal is legal ONLY as a direct operand of `=` or `!=` at the top
  level of an IF condition.
- Formula RESULTS remain `number | null`. No string branches, no string
  arithmetic, no string ordering. The write/override/convergence stack is
  untouched.

## Grammar / tokenizer

- Double-quoted literals only: `"QUALIFIED"`. Single quotes remain illegal
  characters.
- No escape sequences in v1. Any character except `"` and newline is allowed
  inside; an embedded/unterminated quote is a tokenize error with a specific
  message.
- Max literal length: 100 characters (joins the existing DoS-guard family:
  max expression length / parse depth / eval depth).
- New token type `string`; new AST node `StringLiteral { value: string }`.

## Parser rules (each rejection has its own specific error message)

- `field = "X"`, `"X" = field`, `field != "X"` at condition top level: legal.
- `"A" = "B"` (both literals): legal (constant condition).
- String operand beside `<`, `>`, `<=`, `>=`: parse error ("strings support
  only = and !=").
- String literal anywhere else (arithmetic operand, IF branch, bare
  expression, function argument): parse error ("string literals are only
  allowed beside = or != inside an IF condition").

## Evaluation semantics

When at least one side of `=`/`!=` is a string literal, the comparison runs in
**string mode**:

- The non-literal side (same-record field ref or `[object:uuid:field]`
  cross-ref) resolves to the field's **raw stored string**: SELECT → the
  option `value` (e.g. `QUALIFIED`), TEXT → the raw text. This is identical to
  what Twenty core's own view filters compare against.
- Comparison is exact, case-sensitive string equality.
- Null/absent field value → condition is `null` → the whole IF result is
  `null` (existing ADR 0003 null-propagation; deliberate consistency).
- Runtime type mismatch (raw value is not a string — e.g. a cross-ref to a
  NUMBER field): condition is `null`, not an error.
- Without a string literal present, comparisons behave exactly as today
  (numeric mode). No existing formula changes behavior.

## Resolver / coercion contract

The engine stays pure. `EvaluateOptions`' record-value resolution supplies two
views per field reference:

- `numeric` — today's coerced `number | null` (micros, epoch-days, etc.),
  consumed everywhere arithmetic/numeric comparison happens. UNCHANGED.
- `raw` — the raw stored string when the underlying value is a string
  (SELECT option value, TEXT), else null.

Only string-mode comparison evaluation may consume `raw`. The production
resolver (compute path in `recompute.ts` / `value-io.ts` / `coercion.ts`
family) populates `raw` from the same record fetch already performed — no new
queries. Dependency extraction, cycle detection, `usesToday`, value-io writes:
all unchanged.

## Save-time validation

When the compared field's metadata is known at save (same-record refs), a
string literal compared against a field that is neither SELECT nor TEXT is a
validation error naming the field and its type (existing validation copy
style). Cross-record refs stay runtime-checked (null on mismatch) — types
can't be known reliably at save.

## Autocomplete (in `formula-field-input.tsx`)

After `<field> =` or `<field> !=` where `<field>` resolves to a SELECT field
on the target object: the existing dropdown lists that field's option values,
rendered label-first with the raw value alongside (same presentation as field
suggestions' label + API name), inserted as the quoted raw value. Requires the
field-metadata load to include SELECT `options` (extend the existing metadata
selection). Builds on the caret fix (plan Task 5). Suppressed inside `[...]`
cross-refs like all other suggestions.

## Testing

- Tokenizer: literal round-trip, unterminated, embedded quote, newline, >100
  chars, single-quote still illegal.
- Parser: every legal position; every rejection listed above, each asserting
  its specific error.
- Evaluator: match/mismatch, `!=`, null field → null, runtime mismatch →
  null, literal-literal, cross-ref string comparison, numeric comparisons
  unchanged.
- Validation: SELECT ok, TEXT ok, NUMBER rejected naming type; cross-ref
  passes save.
- Autocomplete: options suggested after `=`/`!=` on a SELECT field only;
  quoted insertion; non-SELECT fields get no option suggestions.
- Fuzz corpus extended with quoted-string inputs (existing fuzz harness).

## Out of scope (explicit)

Escape sequences; single-quoted strings; string-valued formula results;
string functions (CONCAT, LEN); label matching; case-insensitive mode;
MULTI_SELECT contains-semantics (future: would need its own operator).
