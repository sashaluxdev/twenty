# Formula Field

A Twenty **Apps SDK** application that gives any object a "chimeric" formula
field: **reading** the field returns a computed value — a number or a string
(API reads, CSV exports,
table cells, filters, aggregations, copy/paste all get the value, because it is
a real native field); **editing** the field means editing a formula
*expression*, not the value. Arithmetic formulas can reference other fields on
the same record and — by record id — fields on other records and objects.

Deep design rationale lives in `docs/adr/*.md`; operational handoff notes live
in `context.md`. This README is the entry point for a developer evaluating or
operating the app.

## What it is

Twenty has no primitive for registering a brand-new field type with custom
read/write renderers (`defineField` can only attach an *existing*
`FieldMetadataType`). So a "chimeric" field is emulated with two real objects
(ADR 0001):

1. A **value field** — a genuine `NUMBER`, `CURRENCY`, `DATE`, `DATE_TIME` or
   `TEXT` column on the target object. This is what the UI shows and every read
   returns.
2. A **FormulaDefinition** record — one per formula — holding the target
   object/field, the expression string, the extracted dependency list, an
   `enabled` flag, operational status, and a last-evaluated heartbeat.

A logic-function evaluation engine keeps the value field in sync with the
formula. "Editing the field" means editing the FormulaDefinition's expression
through a front component on the record page.

### Feature summary

- **Guided "Add formula field" wizard** — pick object → output format (integer /
  decimal / percent / short / currency / date / datetime / text) → per-format options
  (decimals, currency Short/Full + code, date display style with custom Unicode
  pattern — the same options the native field creator exposes) → name; the value
  field is created at runtime via the metadata API, no redeploy (ADR 0008). Every
  choice persists on the definition (`targetFieldSettings`) so the wizard resumes.
- **Editable field settings** — a completed definition's record page has a
  collapsible "Field settings" section: the target object and field API name are
  read-only (formulas reference the API name; the label update forces
  `isLabelSyncedWithName: false` so the API name stays fixed), while the field
  label and display settings (decimals, number/currency/date format) are
  editable and written straight back through `updateOneField`.
- **Output formats** — integer, decimal, percent (all `NUMBER`), currency
  (`CURRENCY`, stored and computed in **micros**, ×1e6), date / datetime
  (`DATE` / `DATE_TIME`, the Excel serial-date model — **epoch-days**, ADR 0011),
  and text (`TEXT`, a computed string — concatenation, IF branches returning
  text, or a bare reference to another TEXT field; ADR 0026, no display options).
- **Same-record and cross-record references** — read another field on the same
  record, or a field on a specific record of any object by uuid.
- **Manual per-record overrides** — a human editing the value directly pins that
  record; recompute leaves it alone until the override is cleared (ADR 0006).
- **Operational status + status snackbar** — when an input field is
  deactivated/missing a formula goes OFFLINE; downstream formulas go UPSTREAM.
  The record-page Formulas widget fires a toast on mount and on every status
  change, pointing at the Formulas tab for details (ADR 0009, ADR 0021).
- **Definition lifecycle** — trashing a definition deactivates its
  wizard-created field (data kept, reversible); restore reactivates and
  recomputes; purge keeps the column deactivated forever (ADR 0009).
- **Description + tooltip** — an optional free-text description ("4 ·
  Description" wizard step, and a "Field settings" block in the post-create
  editor — description stays editable after creation, unlike the name). When
  set, a small "?" glyph appears next to the formula's name in the record-page
  Formulas tab; hovering it shows the description via the browser's native
  tooltip (`title` attribute — the app's only tooltip mechanism, ADR 0022). No
  glyph renders when the description is empty.

## Formula grammar

The engine (`src/engine/`) is a whitelist tokenizer → recursive-descent parser →
tree-walking interpreter. There is no `eval` / `new Function` anywhere. Only the
characters that make up the grammar below are accepted; everything else (`;`,
single quotes, backslashes, unicode homoglyph operators, …) is rejected at the
exact offset where it appears. The double-quote `"` opens a whitelisted string
literal, which is an ordinary value (ADR 0026) — legal anywhere a number is,
except beside an ordering operator; single quotes are never accepted.

```
concat       := expression ('&' expression)*   // the loosest value tier
expression   := term (('+' | '-') term)*
term         := unary (('*' | '/' | '%') unary)*
unary        := ('+' | '-') unary | primary
primary      := NUMBER | STRING | FIELD | CROSSREF | IF | TODAY | SUM | IFBLANK
              | IFS | SWITCH | NUMBERCAST | TEXTCAST | DATELITERAL | '(' concat ')'
IF           := 'IF' '(' condition ',' concat ',' concat ')'
TODAY        := 'TODAY' '(' ')'
SUM          := 'SUM' '(' concat (',' concat)* ')'
IFBLANK      := 'IFBLANK' '(' concat ',' concat ')'
IFS          := 'IFS' '(' condition ',' concat
                    (',' condition ',' concat)* (',' concat)? ')'
SWITCH       := 'SWITCH' '(' concat (',' concat ',' concat)+
                    (',' concat)? ')'
NUMBERCAST   := 'NUMBER' '(' concat ')'
TEXTCAST     := 'TEXT' '(' concat ')'
DATELITERAL  := 'DATE' '(' STRING ')'          // literal only, constant-folds at parse
condition    := boolFunction | concat (compareOp concat)?
boolFunction := 'AND' '(' condition (',' condition)+ ')'
              | 'OR'  '(' condition (',' condition)+ ')'
              | 'NOT' '(' condition ')'
              | 'ISBLANK' '(' concat ')'
compareOp    := '>' | '<' | '>=' | '<=' | '=' | '==' | '!='

NUMBER   := digits ['.' digits]              // e.g. 42, 3.14, .5
STRING   := '"' chars '"'                     // double-quoted, a value anywhere
FIELD    := ident ('.' ident)*               // same-record dotted path
CROSSREF := '[' object ':' uuidV4 ':' fieldPath ']'
ident    := (letter | '_') (letter | digit | '_')*
```

`TODAY()` resolves to the current epoch-day (ADR 0012), `SUM(...)` totals its
non-null arguments (ADR 0016), `IFBLANK(value, fallback)` substitutes a fallback
for a blank value (ADR 0017, widened by ADR 0026), `AND`/`OR`/`NOT`/`ISBLANK` are
condition-only combinators (ADR 0017), and `IFS`/`SWITCH` (ADR 0018) are readable
multi-rung ladders that desugar into nested IFs at parse time.
`NUMBER`/`TEXT`/`DATE` (ADR 0027) are the three explicit-cast functions — see
"Strict kind typing" below. IF, TODAY, SUM, IFBLANK, IFS, SWITCH, AND, OR, NOT,
and ISBLANK are hard-reserved words regardless of context; NUMBER, TEXT, and
DATE are reserved **only when immediately followed by `(`** — a bare `date`,
`text`, or `number` still parses as an ordinary field reference, so fields
already using those names keep working.

Binary operators are left-associative; `*` `/` `%` bind tighter than `+` `-`;
unary `+`/`-` bind tighter than binary but looser than parentheses. Arithmetic
binds tighter than comparison: `a + b > c * 2` groups as `(a + b) > (c * 2)`.
`&` (concatenation, ADR 0026) is looser than every arithmetic operator but
tighter than a comparison, so `a & "-" & b = code` concatenates first and then
compares the result.

### Examples

```
amount.amountMicros + probability * 2      same-record fields, precedence
(amount + tax) / 12                        parentheses
amount.amountMicros * 1.1                   dotted path into a CURRENCY composite
100 - discountPercent % 100                 modulo
[company:6a1b…-uuid:employees] * 1000       cross-record ref by record id
amount.amountMicros + [company:…:budget]    mixing same- and cross-record
IF(probability > 50, amount.amountMicros, 0)    conditional on a threshold
IF(discount != 0, price - discount, price)  explicit comparison (truthiness removed, ADR 0027)
IF(a >= 10, 1, IF(a >= 5, 0.5, 0))          nested IF (tiering)
IF(stage = "won", amount.amountMicros, 0)   double-quoted string equality
TODAY() - startDate                          days elapsed since a date field
SUM(amount.amountMicros, tax, shipping)      variadic total, ignores null args
IF(AND(stage = "won", amount > 1000), 1, 0)  compound condition (AND/OR/NOT)
IF(ISBLANK(email), 0, 1)                      test whether a field is blank
revenue + IFBLANK(upsell, 0)                  treat a blank input as 0
IFS(score >= 90, 5, score >= 70, 4, 0)        readable range ladder (nested IF)
SWITCH(stage, "lead", 1, "won", 3, 0)        map a SELECT field to a number
"INV-" & customerCode & "-" & invoiceNumber  concatenation (TEXT output)
IF(amount > 50000, "Hot", "Cold")            branches may return text
sourceField                                   one-term formula = a TEXT mirror
NUMBER(zip) * 1000                            explicit text→number cast (ADR 0027)
TEXT(amount) & " units"                       explicit number→text cast
closeDate = DATE("2026-01-15")                fixed-date literal comparison
closeDate + 30                                typed date arithmetic (date ± number → date)
```

A same-record path like `amount.amountMicros` reaches into a composite field;
dependency tracking keys on the **root** segment (`amount`), because update
events report changes at field granularity. A cross-record reference is
`[object:recordId:fieldPath]` where `recordId` must be a UUID v4; it applies to
that specific record.

### IF conditionals (ADR 0010)

`IF(condition, then, else)` — function-call form, exactly 3 arguments, keyword
case-insensitive (`IF` / `if` / `If`). Rules:

- **Comparisons are transient.** `> < >= <= = !=` (`==` is an alias of `=`) are
  legal **only** at the top level of IF's condition slot. A comparison anywhere
  a value is expected — top level, inside arithmetic, in a then/else branch,
  inside a parenthesised comparison operand — is a parse error. Formulas produce
  `number | string | null` (ADR 0026), never a boolean.
- **Chained comparisons** (`a > b > c`) are a parse error.
- **Conditions are strictly boolean (ADR 0027).** A condition must infer the
  `boolean` kind — a comparison, or AND/OR/NOT/ISBLANK. The old Excel-style
  truthiness fallback (`0` = false, nonzero = true for a bare numeric
  condition) is **removed**: `IF(numField, …)` no longer parses as "is this
  nonzero" — write `IF(numField != 0, …)`. This is checked statically at
  save time, not at eval time.
- **Null rules (ADR 0003 consistency).** A null condition, or a null in either
  comparison operand, makes the **entire IF result null**. This deliberately
  deviates from Excel (where a blank cell compares as 0) to match the app's
  null-propagation policy — an empty input never silently becomes a 0.
- **String literals (double-quoted).** `"..."` is an ordinary value (ADR 0026):
  legal in a condition operand (`IF(stage = "won", …)`), in a branch
  (`IF(x > 1, "Hot", "Cold")`), and in any other value slot. Strings still
  compare for equality only — an ordering operator with a literal operand
  (`a > "b"`) is a parse error. Equality is **typed, non-coercing, and kind-
  checked at save (ADR 0027)**: both operands of `=`/`!=` must infer the same
  kind, or the save is rejected outright — `42 = "42"` no longer merely
  evaluates to false, it fails to save (`Cannot compare number with text
  using "=" (kinds must match)`). Single quotes are always rejected.
- **Lazy evaluation.** Only the taken branch is evaluated: an error in the
  untaken branch (e.g. division by zero) never fires. The condition is always
  evaluated.
- **Eager dependencies.** Dependency extraction collects references from the
  condition AND both branches (the untaken branch's inputs can flip the
  condition's outcome next time), so recompute triggers and cycle detection see
  the whole conditional.
- **`if`, `today`, `sum`, `ifblank`, `and`, `or`, `not`, `isblank`, `ifs` and
  `switch` are reserved words** (case-insensitive). A bare same-record field with
  one of those names is no longer expressible (dotted paths like `if.x` / `and.x`
  / `ifblank.y` / `ifs.x` / `switch.x` still are, and cross-refs `[obj:id:and]`
  are unaffected).

### Boolean condition functions (ADR 0017)

Four condition-context combinators compose comparisons inside an IF condition
(function-style, not infix — `a > 1 AND b < 2` is **not** supported):

- `AND(cond1, ..., condN)` / `OR(cond1, ..., condN)` — variadic, **at least 2
  arguments** (a 1-arg AND/OR is a parse error, almost always a mistake).
- `NOT(cond)` — exactly 1 argument.
- `ISBLANK(value)` — exactly 1 argument; true when the value is blank (see
  below). These are legal **only** inside an IF condition (or nested inside each
  other); using one where a value is expected — `AND(a>1, b>2)` at the top
  level, or `IF(a>1, NOT(b), 0)` — is a parse error.

- **Kleene three-valued null logic, NO short-circuit.** Every argument is always
  evaluated (so an error — division by zero, unknown field — in any argument
  always fires, like SUM). Truths then combine by the Kleene rule: `AND` is false
  if **any** argument is false, else null if any is null, else true; `OR` is true
  if **any** argument is true, else null if any is null, else false. So a
  determined truth dominates a null — `AND(false, null)` is **false** and
  `OR(true, null)` is **true**, not null. This is what makes the blank-tolerance
  idioms work: `OR(ISBLANK(x), x > 10)` skips a blank `x` (the true `ISBLANK`
  dominates the null from `x > 10`), and `AND(NOT(ISBLANK(x)), x > 10)` fails a
  blank `x` (the false `NOT(ISBLANK)` dominates). Only when NO argument is
  determined does the combinator stay null (e.g. `AND(true, null)` /
  `OR(false, null)`); `IFBLANK` (below) substitutes a value for a blank input in
  that case.

### Blank handling: ISBLANK and IFBLANK (ADR 0017)

`ISBLANK(value)` **observes** blankness instead of propagating null — it returns
true/false (never null) for a successfully evaluated argument; a typo'd field
name inside it still throws `UNKNOWN_VARIABLE` (a formula bug, not a blank).

- **Bare field / cross-record operand** — an empty or whitespace-only string is
  blank, any other non-empty string is not blank (so `ISBLANK(email)` works on
  TEXT / SELECT fields day one). `null` is blank, a number is not, a missing
  linked record reads as blank.
- **Compound operand** (`ISBLANK(a + b)`) — a null result (from internal null
  propagation) counts as blank.

`IFBLANK(value, fallback)` returns `value` unless it is **blank**, otherwise
`fallback` (which may itself be null). It is a **value** function, legal anywhere
a number is — `revenue + IFBLANK(upsell, 0)` fixes the most common
null-propagation complaint, and `IF(IFBLANK(amount, 0) > 1000, …)` reads as
"treat a blank amount as 0". **Both arguments are always evaluated** (SUM
precedent), so an error in the fallback fires even when the value is non-blank.
Since ADR 0026 the two functions agree on what blank means — `null`, or text
that is empty/whitespace-only — so `IFBLANK(nickname, firstName)` substitutes on
a blank TEXT field too. ADR 0017's "deliberate asymmetry" (IFBLANK null-only,
numeric-only) is gone.

### Multi-rung ladders: IFS and SWITCH (ADR 0018)

Nested-IF ladders are the most common real CRM formulas but become unreadable
past two rungs. `IFS` and `SWITCH` are **pure parser sugar** — they desugar into
nested IFs during parsing, so every property (lazy short-circuit, null
propagation, dependency tracking, save-time validation) is inherited from IF with
no new runtime behavior. There is no IFS/SWITCH node at runtime; the stored AST is
just IFs.

- `IFS(cond1, value1, cond2, value2, ..., [default])` — takes the value of the
  first true condition. Each condition uses the full condition grammar (including
  `AND`/`OR`/`NOT`/`ISBLANK`); each value is an expression.
  `IFS(a > 1, 2, b > 3, 4, 0)` desugars to `IF(a > 1, 2, IF(b > 3, 4, 0))`.
- `SWITCH(expr, key1, value1, key2, value2, ..., [default])` — compares `expr`
  against each key by `=`. `expr` and the keys are comparison operands (numbers or
  string literals), so `SWITCH(stage, "lead", 1, "won", 3, 0)` maps a SELECT field
  with zero string-rule relaxation. It desugars to
  `IF(stage = "lead", 1, IF(stage = "won", 3, 0))`.

- **No default, no match → null (blank)**, not an error — a deliberate divergence
  from Excel's `#N/A`, consistent with the engine's null philosophy. The desugar
  uses a null-producing else for the innermost IF when no default is given.
- **Null propagation composes.** A `SWITCH` on a **blank** field is null at the
  first rung (`expr = key1` has a null operand), so the whole ladder is null even
  with a default present. Guard a blank text field with
  `IF(ISBLANK(stage), fallback, SWITCH(stage, ...))`, or a blank numeric subject
  with `SWITCH(IFBLANK(x, 0), ...)`.
- **Trade-offs (accepted).** `SWITCH` duplicates `expr` per rung (pure, so
  harmless; dependency extraction dedupes). Each rung adds one IF frame, so the
  parse-depth guard bounds ladders to roughly ~60 rungs — far past any hand-written
  formula. Runtime error messages speak in IF terms (the real AST); parse-time
  errors (arity, malformed args) do say IFS/SWITCH.

### Text values and concatenation (ADR 0026)

The engine's value domain is `number | string | null`, so a formula can produce
text as well as a number. `&` concatenates:

```
"INV-" & customerCode & "-" & invoiceNumber   a template
firstName & " " & lastName                     null parts contribute nothing
sourceField                                    a one-term formula copies a field
```

- **How a field resolves (reversed by ADR 0027 — read this bullet as current).**
  A field resolves purely by its declared metadata **kind**, never by
  inspecting the value's shape: a DATE / DATE_TIME field always becomes its
  epoch-day serial, and a TEXT (or SELECT) field always resolves **verbatim**,
  even when its content happens to be date-shaped (`"2026-01-15"`) or
  numeric-shaped (`"042"`) — no regex, no sniffing. `"042"` keeps its leading
  zero, a blank field is `""` rather than an error. This replaced an earlier
  (v0.2.0) rule where date-*shaped-and-valid* TEXT content was eagerly parsed
  as a serial in every context; that rule proved surprising enough that the
  user rejected it before deploy — see ADR 0027.
- **Numeric contexts require the `number` kind, statically (ADR 0027).**
  `zip + 1` over a TEXT field is no longer accepted with implicit numeric
  coercion — arithmetic, ordering, and SUM all require `number` operands at
  save time, so a TEXT operand needs an explicit `NUMBER(zip) + 1`. NUMBER()
  goes the other direction: its own argument requires `text`
  (`NUMBER(numericField)` is itself a save-time rejection — NUMBER() casts
  text to a number, it does not accept a number). `&` is not a numeric
  context and never was: `&` requires `text` operands, so numbers need
  `TEXT(amount) & "x"`.
- **`&` semantics.** `&` requires every operand to already be `text` (ADR
  0027) — a number or a date reaching `&` must be wrapped in `TEXT(...)`
  first; there is no implicit rendering path any more. `TEXT(...)` renders
  numbers canonically (integers bare, up to 15 significant digits, float
  dust trimmed) and dates as `YYYY-MM-DD`. `null` contributes the empty
  string (the ONE place null does not propagate — a template must not blank
  out because one part is empty), so an all-null concat is `""`.
- **`TEXT_TOO_LONG`.** The running result of a `&` chain is capped at 10 000
  characters, checked after each part. The cap is concat-only: a long TEXT field
  flowing through a one-term formula or an IF branch is never capped, which is
  what keeps a TEXT passthrough at parity with its source field.
- **Equality is typed and kind-checked at save (ADR 0027).** `=`/`!=` compare
  without coercion, and both operands must infer the same kind or the save is
  rejected — a number can never equal its text form, even by accident.
  Ordering (`< <= > >=`) remains restricted to number/date/datetime, and both
  sides must share that kind too.
- **TEXT targets.** A Text-format definition's expression must itself infer
  `text` (the output gate, ADR 0027) — it writes the computed string
  verbatim. A bare number- (or date-, or boolean-) inferring expression is
  **rejected at save**, not silently rendered; wrap it in `TEXT(...)` to
  produce text explicitly (`TEXT(amount)`, not `amount`). A one-term formula
  naming another TEXT (or SELECT) field is the sanctioned way to mirror it;
  a bare reference to a field of any other kind is rejected at save.

### Dates (Excel serial model, ADR 0011)

Dates are not a separate type — a date simply **is** a number, exactly like
Excel. The internal representation is **fractional days since the Unix epoch**
(1970-01-01 UTC): a `DATE` is a whole epoch-day integer, a `DATE_TIME` is
fractional (`epochMs / 86 400 000`). Everything is plain arithmetic:

```
closeDate + 30                    30 days after the close date
renewalDate - closeDate           the number of days between two dates
startAt + 1 / 24                  one hour after startAt (DATE_TIME target)
IF(signedDate > closeDate,        dates compare as numbers, so ordering
   signedDate, closeDate)         works in an IF condition — picks the later
```

- **Reading, kind-directed (reversed by ADR 0027 — read this bullet as
  current).** A `DATE` field (`"yyyy-MM-dd"`) parses to whole epoch-days; a
  `DATE_TIME` field (ISO UTC) parses to fractional epoch-days. Parsing is now
  driven by the field's **declared metadata kind**, not by pattern-sniffing
  the value — a TEXT field holding date-shaped content (`"2026-01-15"`)
  is **never** parsed as a date any more, in any context; it resolves
  verbatim as text (see "Text values and concatenation" above). Content that
  fails to parse against its own declared DATE/DATE_TIME kind (which should
  not normally occur, since Twenty's own field validation guards it)
  degrades to `null` rather than erroring.
- **Writing.** A `DATE` **target floors to the whole UTC day** (a date has no
  time) and serializes to `"yyyy-MM-dd"`; a `DATE_TIME` target rounds to the
  whole millisecond and serializes to ISO UTC. So `closeDate + 0.5` on a DATE
  target still writes the same calendar day — use a DATE_TIME target to keep the
  half-day.
- **UTC only.** All conversion is UTC (`Date.UTC` / `toISOString`), never
  local-time math — this is DST-immune and timezone-independent. Near midnight
  this can surprise: `2026-07-03T23:30:00Z` and `2026-07-04T01:30:00+02:00` are
  the **same instant** and floor to the same DATE (the 3rd), even though one
  local wall-clock date reads as the 4th.
- **Typed date arithmetic (ADR 0027), narrower than plain numbers.** Dates
  are still represented as numbers internally, but arithmetic on them is no
  longer unrestricted: only four signatures are legal —
  `date ± number → date`, `datetime ± number → datetime`,
  `date − date → number` (days), `datetime − datetime → number` (fractional
  days). `birthDate * 2` — meaningless under any date semantics — is now
  **rejected at save** (multiplication is not one of the four signatures),
  where the pre-0027 engine would have silently computed a meaningless
  far-future serial. The residual honest tradeoff: `closeDate - probability`
  type-checks fine (`date − number → date`) even though subtracting a
  percentage from a date is semantically dubious — the type system checks
  **kind**, not domain meaning, exactly as Excel's does.

### Strict kind typing (ADR 0027)

Every expression is statically typed at save time — not just comparisons.
Seven kinds: `number`, `date`, `datetime`, `text`, `boolean` (the five that
participate in operations), plus `opaque` (a known-but-uninvolved field type
— LINKS, MULTI_SELECT, ADDRESS, RATING, …, which mismatches everything) and
`unknown` (kind unresolvable — skipped, never rejected). The rule is uniform:
**an operation's operands must share the kind the operation expects**, or the
save is rejected with a message naming both kinds.

- `=`/`!=` — same kind, any kind.
- `< <= > >=` — same kind, and only number/date/datetime.
- `+ - * /`, unary, SUM — number, plus the four typed date-arithmetic
  signatures above.
- `&` — text only.
- IF/IFS conditions, AND/OR/NOT operands — boolean only (no truthiness
  fallback).
- IF/IFS/SWITCH branches and IFBLANK's two arguments — must unify to one
  kind.
- The **output gate**: the whole expression's inferred kind must match the
  target field's kind — a Text-format definition must infer `text` (use
  `TEXT(...)` to emit a number as text), a NUMBER/CURRENCY target must infer
  `number`, and so on.

**Casts are the only crossings** — three functions, `NUMBER`/`TEXT`/`DATE`
(grammar above):

- `NUMBER(text)` parses numeric text to a number; non-numeric content is a
  per-record `NON_NUMERIC_VALUE` error, not a save-time rejection (statics
  cannot know a text field's runtime content).
- `TEXT(value)` renders any kind canonically: numbers as plain decimal, dates
  as `YYYY-MM-DD`, datetimes as ISO 8601, booleans as `true`/`false`. No
  format-string arguments in this version.
- `DATE("YYYY-MM-DD")` is a **fixed-date literal only** — the argument must
  be a literal string, checked at save; it is not a general text→date cast
  (there is no `DATE(someTextField)`).

**Legacy definitions are gated, not migrated.** A definition saved before
this redesign whose expression violates a new rule is neither auto-disabled
nor grandfathered: the recompute sweep runs one static check per definition
per pass and, on failure, records the error on the definition row and skips
scanning that definition's records entirely — no per-record evaluation, no
writes. Opening the editor shows exactly what is wrong; fixing and re-saving
is the only way out. A pre-deploy audit script
(`scripts/audit-strict-gate.ts`) reports every enabled definition's verdict
(PASS / GATED / PARSE) against a live remote without writing anything, so a
deploy ships with a known population of gated definitions rather than a
guessed one.

**Editor-accepts / server-rejects for cross-record operands.** The editor's
live validation only has the *host* object's field kinds loaded; the server
preloads kinds for every object a formula's cross-record references touch.
Same-record kind mismatches are always caught identically in both places.
A cross-record mismatch, however, can pass the editor's live check and still
fail the real save — the same pre-existing client/server divergence posture
the app has always had for other server-only checks, now reachable through a
new rule, since this is the first version that types cross-record operands
at all.

### Value & error semantics (ADR 0003)

- **Field kinds coerce into `number | string | null`, by declared kind, never
  by value shape** (`coercion.ts`, ADR 0026, kind-directed since ADR 0027):
  numbers pass through; booleans → 0/1; a CURRENCY composite referenced
  without a sub-path → its `amountMicros`; DATE / DATE_TIME fields parse to
  epoch-days (Excel serial model, ADR 0011) because their **metadata kind**
  says so, not because their content looks date-shaped; every TEXT/SELECT
  field resolves verbatim as text, unconditionally — no runtime coercion
  happens outside an explicit `NUMBER(...)`/`TEXT(...)` cast or one of the
  typed date-arithmetic signatures, since numeric and text contexts now
  require their kind statically at save (ADR 0027) rather than coercing
  whatever shows up at point of use.
- **Null propagates.** A field that exists but is empty resolves to `null`; any
  sub-expression touching a null yields null, and the whole result is null (the
  value field is cleared). This distinguishes "empty input" from "computed 0".
- **Unknown variable** (a field the record does not have) → `UNKNOWN_VARIABLE`
  error (fails loud; likely a typo).
- **Division or modulo by zero** → `DIVISION_BY_ZERO` error; the value is left
  unchanged and the error is surfaced on `lastError`.
- **Non-finite result** (Infinity/NaN) → `NON_NUMERIC_VALUE` error.
- **Cycles are rejected at save time** (ADR 0005). Cycle detection is
  field-granular (object.field nodes, record ids ignored — conservative, can
  only over-report). A cyclic formula is disabled with `CYCLE_DETECTED`.

Error codes: `TOKENIZE_ERROR`, `PARSE_ERROR`, `DIVISION_BY_ZERO`,
`UNKNOWN_VARIABLE`, `NON_NUMERIC_VALUE`, `MAX_DEPTH_EXCEEDED`, `CYCLE_DETECTED`,
`TEXT_TOO_LONG`.

### Limits (DoS guards)

Read from `src/engine/parser.ts`, `src/engine/evaluator.ts` and
`src/engine/text-format.ts`:

| Limit | Value | Where |
| --- | --- | --- |
| Max expression length | 2000 chars | `MAX_EXPRESSION_LENGTH` (parser) |
| Max parse recursion depth | 200 | `MAX_PARSE_DEPTH` (parser) |
| Max evaluation depth | 64 | `DEFAULT_MAX_DEPTH` (evaluator) |
| Max computed text (`&` chains) | 10 000 chars | `MAX_COMPUTED_TEXT_LENGTH` (text-format) |

The parser caps source length and nesting before the JS call stack can overflow;
the evaluator independently caps AST depth at runtime.

## Architecture

```
                         ┌─────────────────────────────────────────────┐
                         │  FormulaDefinition object (one per formula)  │
                         │  targetObject/Field, expression, deps (JSON),│
                         │  enabled, status/statusReason, heartbeat     │
                         └───────────────┬─────────────────────────────┘
                                         │ save (.created/.updated)
                                         ▼
   pure engine  ◄──── compileFormula ──── save-validation: parse, extract deps,
   (src/engine)      (parse + deps)        reject cycles, (re)enable
        ▲                                        │
        │ evaluate(ast, resolver)                │ recompute
        │                                        ▼
   ┌────┴───────────┐   record IO   ┌────────────────────────────┐
   │  recompute.ts  │◄─────────────►│  dynamic-client.ts (raw    │
   │  value-io      │  (micros)     │  GraphQL over CoreApiClient)│
   └────┬───────────┘               └────────────────────────────┘
        │ writes value field                ▲            ▲
        ▼                                    │ app token  │ user token
   target object records          logic functions      front components
        ▲                                    │            │
        │ triggers                           │            │
   ┌────┴──────────────────────────┐    ┌────┴────────────┴───────────────┐
   │ *.updated / *.created (wildcard)│    │ formula-editor.tsx (record tab) │
   │ formulaDefinition.{created,      │    │   status snackbar on mount/     │
   │   updated,deleted,restored,      │    │   status change (enqueueSnackbar)│
   │   destroyed}                     │    │ formula-definition-editor.tsx   │
   │ formula-sweep (hourly cron:      │    │   + setup wizard                │
   │   status recompute + legacy      │    │ convergeTrashedDefinitionLayout │
   │   FX Status companion cleanup)   │    │   (trashed value field) ───────►│ viewFields
   └──────────────────────────────────┘    └─────────────────────────────────┘
                    FormulaOverride object (hidden) — one row per pinned record
```

- **Pure engine** (`src/engine/`, ADR 0002) — tokenizer, parser, AST, evaluator,
  dependency extraction, cycle detection, typed errors. I/O-free: all data
  access is delegated to a caller-supplied `VariableResolver`, which makes it
  100% unit-testable and guarantees no dynamic code path.
- **FormulaDefinition object** (`src/objects/formula-definition.object.ts`) — the
  formula record: target object/field/type, currency code, expression, extracted
  dependencies (JSON), `enabled`, `outputFormat`, `createdField` provenance,
  `status`/`statusReason`, and `lastValue`/`lastEvaluatedAt`/`lastError`.
- **Recompute engine** (`src/logic-functions/lib/recompute.ts`, `value-io.ts`,
  ADR 0004) — resolves same- and cross-record inputs, evaluates, and writes the
  value field. Currency reads/writes go through micros. Before a value is
  written or compared it is normalized per target kind (`normalizeComputedValue`
  in `value-io.ts`): CURRENCY rounds to whole micros, DATE floors to a whole UTC
  day, DATE_TIME rounds to a whole millisecond, and an integer-format NUMBER
  rounds to a whole number; a plain float NUMBER is written and compared exactly.
  This keeps convergence and override detection stable. No-op writes are
  suppressed (recursion guard).
- **Wildcard record triggers** (`on-record-updated`, `on-record-created`, ADR
  0008) — fire on `*.updated` / `*.created` for any object (object name from
  `payload.objectMetadata.nameSingular`); the app's own objects are skipped.
  Cross-object formulas recompute when a referenced record changes.
- **Definition-lifecycle triggers** (`on-formula-definition-{created,updated,
  deleted,restored,destroyed}`, ADR 0009) — save-time validation on
  create/update; deactivate/reactivate the wizard-created field on trash/restore;
  keep it deactivated and clean up override rows on destroy. Status is always
  recomputed from scratch, so event reordering under retries is harmless.
- **Hourly sweep** (`formula-sweep.ts`) — cron backstop that reconverges every
  enabled formula and its status (catches missed events), then runs
  `cleanupCompanionFields` (`fx-status-cleanup.ts`, ADR 0021) to deactivate and
  hard-delete any legacy `<field>FxStatus` companion field left over from a
  pre-ADR-0021 install.
- **Front widgets** — `formula-editor.tsx` (record-page tab: value + editable
  expression with autocomplete + Override toggle) and
  `formula-definition-editor.tsx` (FormulaDefinition record page: setup wizard
  for a fresh draft, else the expression editor). ADR 0007.
- **Dynamic raw-GraphQL client** (`dynamic-client.ts`, ADR 0008) — genql clients
  validate selections against a type map frozen at deploy, so a field created
  after deploy throws client-side. All record IO instead serializes selections
  to raw GraphQL over `CoreApiClient`'s transport, which keeps auth in both the
  logic-function runtime (app token) and the browser (host token bridge).
- **FormulaOverride object** (`src/objects/formula-override.object.ts`, ADR 0006)
  — hidden technical object, one row per (targetObject, targetField, recordId)
  with an `active` flag. Recompute skips active overrides.
- **Status snackbar** (`status-toast.ts` + `formula-editor.tsx`, ADR 0021 —
  supersedes the FX Status companion field of ADR 0009) — on record-page
  widget mount and on every OFFLINE/UPSTREAM status transition, the widget
  calls `enqueueSnackbar`: `error` variant for OFFLINE, `warning` for
  UPSTREAM, each pointing the user at the Formulas tab for the reason. A
  per-definition dedupe key and a session-local "already notified" map keep an
  unchanged status quiet on every subsequent poll while still re-toasting a
  heal-then-re-break. No extra field, no bulk value write, no viewField layout
  convergence — the mechanism that used to require a user-token front-component
  render just to make a chip visible is gone. `fx-status-field.ts` keeps only
  `companionFieldName` (legacy bookkeeping for the cleanup sweep and other
  legacy-tolerance paths) and `convergeTrashedDefinitionLayout`, which now
  hides only the value field of a trashed definition.

## Limitations (honest)

- **Per-record edit-lock is impossible.** `isUIEditable` is column-level, not
  per-record. Value fields are globally editable; a direct human edit is treated
  as a manual override (detected by comparing the written value to the computed
  value, not by actor — a recompute write inherits the triggering user's id).
- **No inline cell badge.** Apps cannot decorate a native field cell
  (`FieldDisplay` is a fixed internal switch). The override indicator is a toggle
  *inside the widget*, and status surfaces via a snackbar toast fired from the
  record-page widget (ADR 0021) rather than a column in the record itself.
- **The status snackbar only fires from a record page.** It is wired into
  `formula-editor.tsx`'s mount/poll cycle, so there is no passive OFFLINE/
  UPSTREAM signal from list (index) views — a user only learns a formula is
  broken by opening a record page of the affected object (or the Formulas
  tab directly). Workspaces deployed before ADR 0021 may still show a stale,
  no-longer-synced FX Status chip until the hourly sweep deletes it.
- **Runtime-created fields are not app-owned.** `createOneField` stamps the
  workspace custom application, not this app (the wizard runs under the user
  token). App uninstall will NOT remove wizard-created fields; provenance is
  tracked on `FormulaDefinition.createdField` instead.
- **Recompute is event-driven + hourly sweep, not transactional.** Values
  converge after the triggering event (or within the hour via the sweep); there
  is no read-your-write guarantee inside a single transaction.
- **Currency is stored as micros** (×1e6) end-to-end. Formula math on a currency
  field operates on `amountMicros`; the field is labelled "currency (micros)".
- **Runtime-created fields/tabs don't invalidate open tabs.** A field or
  record-page tab created at runtime (by the setup wizard) propagates to
  already-open browser tabs only over the live SSE metadata stream; there is no
  app-side metadata-invalidation verb exposed to front components
  (`FrontComponentHostCommunicationApi` offers `enqueueSnackbar` but no
  metadata-refresh). A page refresh reliably syncs. After creating a formula
  field the wizard therefore raises an info snackbar prompting a refresh if the
  new field does not immediately appear in views or tabs.

## Runbook

### Local dev environment

- Server on **`http://127.0.0.1:3000`** (not the SDK default 2020); frontend on
  `:3001`. Start: `npx nx start twenty-server`,
  `npx nx run twenty-server:worker`, `npx nx start twenty-front`. Postgres at
  `postgres://postgres:postgres@localhost:5432/default`.
- The CLI runs via the vendored entrypoint (the `.bin/twenty` symlink hit a
  perms issue in this env):
  `node <repo>/node_modules/twenty-sdk/dist/cli.cjs <cmd>`.

### Deploy / build / test

Run from the app dir (`packages/twenty-apps/community/formula-field/`):

```bash
# Deploy/sync to local (build + typecheck + register + sync + regenerate client)
node <repo>/node_modules/twenty-sdk/dist/cli.cjs dev --once

# Uninstall
echo y | node <repo>/node_modules/twenty-sdk/dist/cli.cjs app:uninstall

# Unit + fuzz tests
node <repo>/node_modules/vitest/vitest.mjs run
# (redirect to a file and tail it — background runs sometimes swallow stdout)

# Integration tests (real install → criteria → uninstall; bumps version per run)
node <repo>/node_modules/vitest/vitest.mjs run --config vitest.integration.config.ts

# Lint
<repo>/node_modules/.bin/oxlint -c .oxlintrc.json .
```

Production deploy is out of scope here (local-only). Prod would need
`twenty remote:add --url <cloud> && twenty app deploy --private`.

### API key for scripts

Stored in `~/.twenty/config.json` under `remotes.local.apiKey` (a
workspace-scoped API_KEY JWT). Read it in Node scripts; never mint/forge tokens.

### Common operational situations

- **A formula shows OFFLINE.** An input field it reads was deactivated or is
  missing (`statusReason` names the dead input). Recompute AND override detection
  skip it. Reactivate the input field (or restore the definition that owns it) —
  status heals automatically on the next event or the hourly sweep.
- **A formula shows UPSTREAM.** It reads the target field of an OFFLINE/UPSTREAM
  formula; it keeps computing on frozen inputs but is flagged. `statusReason`
  names where the chain broke. Fix the root OFFLINE formula; UPSTREAM clears on
  reconvergence.
- **No status snackbar seen for a broken formula.** The toast only fires from
  the record-page Formulas widget's mount/poll cycle (ADR 0021) — open a
  record page of the formula's target object, or check the Formulas tab
  directly; there is no signal from list/index views. If the same status was
  already toasted this widget session, it won't repeat until it changes.
- **A leftover FX Status chip / column from before ADR 0021.** On a workspace
  deployed under the old design, `<field>FxStatus` fields stop being
  value-synced immediately but are not deleted until the next hourly sweep
  runs `cleanupCompanionFields` — expect up to ~1 hour of a stale, frozen chip.
  If `deleteOneField` is denied to the app token, the field is left
  deactivated (out of every view) and the delete retries on the next sweep.
- **Override toggle behavior.** Editing a value field directly pins that record
  (an active FormulaOverride row). Toggle OFF deactivates the override (keeps the
  value) and recomputes; toggle ON restores the last override value and shows an
  "Override value restored" hint. Recompute skips active overrides.
- **Stale widget after a deploy ("No Data" / old code).** The frontend caches
  metadata (including which front-component checksum to load) in IndexedDB
  (`twenty-front-metadata-store`). After `dev --once`, hard-refresh / clear site
  data, or delete that IndexedDB database. This causes most "it doesn't work"
  red herrings — always hard-refresh before judging UI behavior.
- **Re-mint the API key after a DB reset.** The CLI key dies with the DB.
  Re-mint via the auth mutations on `/metadata` (they are on `/metadata`, not
  `/graphql`): `getLoginTokenFromCredentials` → `getAuthTokensFromLoginToken` →
  `getRoles` (Admin id; `createApiKey` requires a `roleId`) → `createApiKey` →
  `generateApiKeyToken`, then write the token to `~/.twenty/config.json`
  `remotes.local.apiKey`. The install is production-clean — it seeds no demo
  data — so after a reset create your first formula through the setup wizard on
  a record page (or via `createFormulaDefinition` against an existing field).
