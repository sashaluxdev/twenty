# Live-surface inventory — strict kind typing (v0.3.0)

Raw reference material for the live-verification plan author. Inventory only — no test design,
no editorializing. Compiled from the design doc, ADR 0027, source, the dev Postgres MCP, and prior
SDD artifacts. Branch `strict-typing` at `49eff11edd`.

Sources read:
- `packages/twenty-apps/community/formula-field/docs/plans/2026-08-05-strict-typing-design.md`
- `packages/twenty-apps/community/formula-field/docs/adr/0027-strict-kind-typing.md`
- `packages/twenty-apps/community/formula-field/src/logic-functions/lib/kind-inference.ts`
- `packages/twenty-apps/community/formula-field/src/logic-functions/lib/validation-core.ts`
- `packages/twenty-apps/community/formula-field/src/logic-functions/lib/handle-formula-change.ts`
- `packages/twenty-apps/community/formula-field/src/logic-functions/lib/handle-record-update.ts`
- `packages/twenty-apps/community/formula-field/src/engine/evaluator.ts`
- `packages/twenty-apps/community/formula-field/src/engine/parser.ts` (DATE literal error)
- `packages/twenty-apps/community/formula-field/src/logic-functions/lib/mirror-kinds.ts`
- `packages/twenty-apps/community/formula-field/src/logic-functions/lib/value-io.ts`
- `packages/twenty-apps/community/formula-field/src/front-components/lib/formula-field-input.tsx`
- `packages/twenty-apps/community/formula-field/src/front-components/lib/validate-expression.ts`
- `packages/twenty-apps/community/formula-field/src/front-components/formula-editor.tsx`
- `packages/twenty-apps/community/formula-field/src/front-components/lib/formula-setup-wizard.tsx`
- `packages/twenty-apps/community/formula-field/docs/plans/2026-08-04-live-verification-handoff.md`
- `.superpowers/sdd/2026-08-05-strict-typing-implementation/task-8-report.md`
- `.superpowers/sdd/2026-08-05-strict-typing-implementation/progress.md`
- `packages/twenty-apps/community/formula-field/docs/plans/2026-08-05-strict-typing-live-verification-plan.md`
  (a draft plan already exists in the tree with `⟦INVENTORY §n⟧` placeholders this file feeds)
- read-only Postgres MCP against the dev workspace schema `workspace_1wgvd1injqtife6y4rvfbu3h5`
- `/tmp/claude-1000/-home-sasha-shin-twenty/92e8a28c-c10d-4a8d-af29-d2104f7504ab/tasks/blbevajxj.output`
  (prior `npx nx start twenty-server` log)

---

## 1. Strict rules S1-S9 and decisions D1-D6

All static-kind checks route through one function, `inferExpressionKind` /
`strictKindGateError` in `src/logic-functions/lib/kind-inference.ts`, called from exactly three
call sites:

- **editor-validate**: `front-components/lib/validate-expression.ts` → `validateExpressionCore`
  (live, on every keystroke render in `formula-editor.tsx`, and again on the wizard's save click).
- **save**: server-side `handle-formula-change.ts` → `save-validation.ts`'s `validateFormula` →
  the same `validateExpressionCore` — fires on the `FormulaDefinition` create/update DB trigger.
- **recompute gate**: `strictKindGateError` called directly (not through `validateExpressionCore`)
  from `recompute.ts` (`recomputeAllRecords`, sweep path) and `handle-record-update.ts` (event
  path) — this is the D6 per-definition static gate for **legacy** definitions that predate the
  redesign and were never re-saved.

Because all three call the identical `kind-inference.ts` code, the error string is byte-identical
across all three surfaces for every rule below (this is what makes the ADR's editor/server-parity
claims true). The one documented exception is **cross-record kind mismatches**: the editor only
has the host object's `kindsByName`; the server preloads kinds for every cross-referenced object
too. So a cross-record mismatch can pass editor-live-validate and still fail at real save
(D5, ADR 0027 lines 179-190) — an editor-accepts/server-rejects class, not a drift.

The design doc (`2026-08-05-strict-typing-design.md`) states rules in prose, without quoting exact
runtime strings, except for two direct quotes in ADR 0027 (both confirmed byte-identical to the
code template below): `Cannot compare opaque with text using "=" (kinds must match)` and
`TEXT() cannot render a LINKS field`. For every other rule the design doc/ADR describe intent only
— the code template below is authoritative; no drift found for any rule (nothing in the docs
contradicts a code template, they simply don't quote most of them verbatim).

### D1 — Kind lattice

Seven kinds: `number`, `date`, `datetime`, `text`, `boolean` (lattice, participate in operations),
plus `opaque` (known field types outside the lattice — LINKS, MULTI_SELECT, ADDRESS, RATING, ... —
mismatches every operation and even itself) and `unknown` (kind unresolvable — every constraint
skipped, never rejected). `fieldTypeToKind` (kind-inference.ts:30-51) maps: NUMBER/NUMERIC/CURRENCY
→ number; DATE → date; DATE_TIME → datetime; TEXT/SELECT → text; BOOLEAN → boolean; anything else
non-empty → opaque; null/empty → unknown. Dotted subpaths (`price.currencyCode`) always infer
`unknown` regardless of the root's kind (`rawFieldType`, kind-inference.ts:66-71) — this is a
deliberate loosening vs. the retired branch 1b (skip, never a wrong reject).

### D2 — one rule: kinds must match the operation (S1, S3-S6, S8 are its rejections)

| Rule | Code path | Exact error template (code, authoritative) |
|---|---|---|
| `=`/`!=` unequal kinds | `comparisonKind`, kind-inference.ts:124-128 | `` `Cannot compare ${left} with ${right} using "${operator}" (kinds must match)` `` |
| Ordering (`< <= > >=`) on equal-but-non-orderable kinds (text/boolean/opaque) | `comparisonKind`, kind-inference.ts:133-135 | `` `Cannot order ${left} values with "${operator}"` `` |
| Arithmetic (`+ - * /`, unary `-`) kind mismatch | `binaryKind`, kind-inference.ts:145-148 | `` `Cannot apply "${operator}" to ${left} and ${right}` `` |
| Unary `-` on non-number | kind-inference.ts:223-225 | `` `Cannot apply unary "${node.operator}" to ${kind}` `` |
| SUM arg not number | kind-inference.ts:258-260 | `` `SUM args must be number, got ${kind}` `` |
| `&` (concat) non-text part | kind-inference.ts:240-242 | `` `"&" joins text; wrap ${kind} values in TEXT()` `` |
| Condition position (IF/AND/OR/NOT) non-boolean | `assertCondition`, kind-inference.ts:111-114 | `` `Condition must be a comparison or boolean field, got ${kind}` `` |
| IF/IFBLANK branch kind disagreement | `unify`, kind-inference.ts:81 | `` `IF branches disagree: ${a} vs ${b}` `` |
| Output gate (expression kind ≠ target field kind) | `strictKindGateError`, kind-inference.ts:351-353 | `` `Formula computes ${result.kind} but the target field holds ${expected}${suggestion}` `` — `suggestion` is `' Wrap it in TEXT(...) to fix this.'` only when `expected === 'text'`, else `''` |

All of the above fire at **all three surfaces** (editor-validate, save, recompute gate) since they
are pure functions of `(AST, field kinds)` — pass-invariant per D6.

- **S1** (`dateField = "2026-01-15"` rejected): the comparison-mismatch template above, `left`=`date`,
  `right`=`text`. Sanctioned rewrite: `dateField = DATE("2026-01-15")`.
- **S3** (`textField * 2` on TEXT content rejected): the arithmetic-mismatch template,
  `left`=`text`, `right`=`number` (or vice versa depending on operand order). Sanctioned rewrite:
  `NUMBER(textField) * 2`.
- **S4** (`IF("a", 1, 2)`, `IF(numField, …)` rejected): the condition-position template,
  `kind`=`text` or `number`. No cast rewrite — must rewrite the condition itself
  (`IF(numField != 0, …)`).
- **S5** (`isActive & ""` rejected): the `&` non-text-part template, `kind`=`boolean`. Sanctioned
  rewrite: `TEXT(isActive) & ""`.
- **S6** (`42 = "42"`, `textFieldA = numFieldB` rejected): the comparison-mismatch template,
  `left`/`right` = `number`/`text`.
- **S8** (`closeDate < syncedAt`, `syncedAt > TODAY()` rejected — date vs datetime): the
  comparison-mismatch template fires first (`left`=`date|datetime`, `right` the other) — this is
  the "unequal kinds" branch, NOT the separate ordering-template branch (ADR 0027 explicitly notes
  these are two distinct messages, not collapsed: unequal kinds reuse the `=`/`!=` message; the
  ordering-only message is for equal-but-unorderable kinds like two text values).
- **S2** and **S9** are NOT rejection scenarios — they are behavior/perf deltas (see §2 and the ADR
  Consequences), not gate errors.
- **S7**: three new functions added to the language (NUMBER, TEXT, DATE) — not a rejection, a
  new-surface addition (see §2, §4).

### D3 — explicit casts (S7)

- `NUMBER(text)` — non-text operand rejected at the static gate: `` `NUMBER() takes text, got ${kind}` `` (kind-inference.ts:285). At runtime, non-numeric text throws `NON_NUMERIC_VALUE` (see §2).
- `TEXT(value)` — opaque operand rejected: `` `TEXT() cannot render a ${fieldType} field` `` where `fieldType` is the RAW field type name (e.g. `LINKS`), not the bucket label `opaque` (kind-inference.ts:292-297, `rawFieldTypeOfNode`). Any non-opaque kind is accepted and stamps `renderAs` on the node (compile-time, zero per-record cost).
- `DATE("YYYY-MM-DD")` — parser-level (not kind-inference-level) rejection, fires at **parse time**, which every one of the three surfaces triggers as their first step (`validateExpressionCore` step 1, `parser.ts:parseDateLiteral`). Exact error, `parser.ts:597-601`:
  `'DATE() requires a literal "YYYY-MM-DD" date'` (`FormulaError('PARSE_ERROR', ...)`) — fires when
  the argument is not a STRING token, or the string fails `parseDateOnlyToEpochDays`, or the
  closing paren is missing. A valid literal constant-folds to a `dateliteral` AST node holding the
  epoch-day value at parse time (zero runtime cost).

### D4 — resolver kind-directed parsing (S2, S9 — behavior/perf, not rejections)

No error messages; behavioral deltas only, see §2/Consequences.

### D5 — enforcement architecture

Already described above (the three call sites). Additional notes: kind resolution happens **once
per definition per pass** (sweep) or **once per event** (event path), never per record; the
engine (`src/engine/`) itself stays kind-agnostic except reading the compile-time `renderAs`
annotation on TEXT nodes.

### D6 — legacy definitions: per-definition static gate

A definition saved before the redesign that now violates D2/D3 is **not** migrated or
auto-disabled and is **not scanned**: the recompute paths (`recomputeAllRecords`,
`handle-record-update.ts`) run `strictKindGateError` once per definition per pass/event; on a
gate error, the error is written to the definition row (write-avoidant — only on change) and the
record scan/recompute for that definition is skipped entirely — zero record queries. This applies
to every write path per ADR 0027 D6, not only the sweep: the record-page widget's override
toggle-off and its per-record TODAY staleness refresh both gate on entry the same way.
Per-record eval errors remain ONLY for what statics cannot decide: cast runtime failures
(`NUMBER()` on non-numeric content) and kind-unknown references — these produce `write: null`,
zero record writes, zero timeline rows.

---

## 2. Runtime cast/render behaviors

### NUMBER() runtime posture

`toNumber` is the ONE numeric coercion choke point in `evaluator.ts` (lines 107-122), used by
arithmetic, unary minus, ordering, SUM, and `numbercast`. A number passes through; a string is
`.trim()`ed and `Number(...)`'d — if the trimmed string is `''` or the parse is non-finite, it
throws:

```
FormulaError('NON_NUMERIC_VALUE', `Text value is not numeric (${excerptForError(JSON.stringify(value))})`)
```

`excerptForError` bounds the excerpt to 80 chars (`MAX_ERROR_VALUE_EXCERPT_LENGTH`, evaluator.ts:92)
with a trailing `…` — this bound is scoped to the evaluator's `toNumber`/arithmetic/NUMBER() paths;
per ADR 0027 D3 the resolver's `coerceToNumber` (`coercion.ts:101`, was `:109` pre-Task-4) applies
the identical bound on its own unbounded-message path. `numbercast` evaluation
(evaluator.ts:460-464): `null` propagates as `null`; a number passes through untouched; otherwise
`toNumber(value)` is called (throws as above on non-numeric text). This is the confirmed dev-DB
example: the disabled T5 fixture `0b845ca6-fca2-4d32-a38f-e56a5d8faf1e` has
`lastError: "NON_NUMERIC_VALUE: Text value is not numeric (\"a\")"` recorded from `IF("a", 1, 2)`
(pre-strict-typing era; now this would be save-rejected as S4 instead of reaching runtime).
Per D6, a cast runtime failure produces `write: null` — no record write, no target-record timeline
row, definition stays enabled and keeps converging on other records.

### TEXT() rendering per `renderAs` kind (evaluator.ts:466-485, `textcast` case)

`renderAs` is stamped on the AST node at kind-inference/compile time from the operand's inferred
kind (`renderKindOf`, kind-inference.ts:95-108: number→'number', date→'date', datetime→'datetime',
boolean→'boolean', else→'value'). The evaluator's dispatch, quoted verbatim:

```ts
case 'textcast': {
  const value = evaluateNode(node.operand, resolve, depth + 1, maxDepth, todayEpochDay);
  if (value === null) return null;
  switch (node.renderAs) {
    case 'date':
      return typeof value === 'number' ? epochDaysToDateString(value) : value;
    case 'datetime':
      return typeof value === 'number' ? epochDaysToIsoDateTime(value) : value;
    case 'boolean':
      return typeof value === 'number' ? (value === 0 ? 'false' : 'true') : value;
    case 'number':
    case 'value':
    default:
      return typeof value === 'number' ? formatNumberAsText(value) : value;
  }
}
```

So: `TEXT(dateField)` → `YYYY-MM-DD` string (`epochDaysToDateString`); `TEXT(dateTimeField)` → ISO
8601 string (`epochDaysToIsoDateTime`); `TEXT(booleanField)` → literal `"true"`/`"false"` (boolean
runtime domain is `0`/nonzero number, per the comment `value === 0 ? 'false' : 'true'`);
`TEXT(numberField)`/default/`value` → `formatNumberAsText` canonical decimal rendering. `null`
operand short-circuits to `null` before the switch. No length cap on TEXT() results (unlike `&`,
capped at `MAX_COMPUTED_TEXT_LENGTH` → `TEXT_TOO_LONG`).

### DATE("YYYY-MM-DD") literal

Constant-folds to a `dateliteral` AST node holding the epoch-day serial at **parse time**
(`parser.ts:parseDateLiteral`). Evaluation is trivial: `case 'dateliteral': return node.value;`
(evaluator.ts:455-456) — no runtime parsing cost.

### Four typed date-arithmetic signatures (`binaryKind`, kind-inference.ts:139-175)

| Signature | Operator | Result kind |
|---|---|---|
| `date ± number → date` | `+` (either operand order) or `-` (date left only) | date |
| `datetime ± number → datetime` | `+` (either order) or `-` (datetime left only) | datetime |
| `date − date → number` (days) | `-` | number |
| `datetime − datetime → number` (fractional days) | `-` | number |

These are signature-table entries only — runtime values are already epoch-day/fractional-day
serials, so evaluation is ordinary numeric arithmetic (evaluator.ts `binary` case), zero added
runtime cost. `date` and `datetime` never mix in one operation (mismatch, S8-adjacent rejection
via the same arithmetic-mismatch template).

### Gate effect on a statically-broken definition (D6)

- **Sweep** (`recomputeAllRecords`, cron `formula-sweep.ts`): gate runs once per definition per
  pass; on error, writes the definition row (write-avoidant) and skips the record scan entirely
  — zero record queries for that definition. The sweep's heartbeat write now syncs the in-memory
  definition record after each write (ADR 0027 D6 fix), so a subsequent write in the same pass
  sees fresh state instead of double-writing against stale in-memory state.
- **Event path** (`handle-record-update.ts`): gate computed once per event
  (`gateErrorByFormulaId` map, lines 245-260) over `eventAffectedFormulas` only; both the
  override-detection loop and the recompute loop check `gateErrorByFormulaId.has(formula.id)`
  and skip (lines 282, 417-419) — a gated formula never turns a human edit into a spurious
  override row, and never recomputes.
- Zero-write / zero-scan is the mechanism that replaces "an unbounded permanent tax (full scan + N
  evaluations per broken definition per sweep — 387 evals/def/hour at ADR 0025's measured scale)".

---

## 3. Not-done list (ADR 0027, verbatim — OUT of live-test scope)

> - **`DATE(textExpr)` as a general text→date cast.** `DATE()` stays literal-only this arc.
> - **datetime↔date bridging.** S8 rejects `syncedAt > TODAY()` and every other date/datetime
>   comparison, and — unlike S1/S3/S5, each of which ships a sanctioned rewrite (`DATE(...)`,
>   `NUMBER(...)`, `TEXT(...)`) — this arc ships **none**. There is no `DATEVALUE(datetime)` /
>   `DATETIME(date)` bridge, so a user with a legitimate "was this synced after today started?"
>   formula has no expressible form until a future arc adds one. Accepted knowingly: the alternative
>   (implicit widening) is exactly the silent-flip class S1 exists to kill.
> - **Formatting arguments to TEXT()** (Excel-style format strings).
> - **Any truthiness escape hatch or lint-level "warn instead of reject" mode.**
> - **Migration tooling for legacy definitions.** The definition-level gate error plus editor
>   explanation is the story; the pre-deploy blast-radius audit (`scripts/audit-strict-gate.ts`)
>   tells us whether that stance holds at real scale before cloud deploy.
> - **SELECT output.** Still the explicitly designated next-version feature, unaffected by this arc
>   (ADR 0026's closing section).
> - **formulahelp reference refresh.** Gated on deploy, separate approval — not part of this arc.
> - **Note (disambiguation):** this ADR's D4 "F1-scope-guard" and the unrelated **F1-empty-string**
>   bug named in `verification-reports/T6-verdict.md` are two different items that happen to share
>   a label by coincidence of numbering. F1-empty-string is a separate, later arc.

(The design doc's own Not-done section, `2026-08-05-strict-typing-design.md` lines 198-210, is
worded near-identically and is superseded by the ADR text above per the ADR/design-doc precedent.)

---

## 4. Editor surface

### Autocomplete — three new entries (`FUNCTION_SUGGESTIONS`, `formula-field-input.tsx:40-119`)

```ts
{
  name: 'NUMBER',
  label: 'NUMBER(text) — cast numeric text',
  type: 'function',
  insertText: 'NUMBER(',
},
{
  name: 'TEXT',
  label: 'TEXT(value) — render as text',
  type: 'function',
  insertText: 'TEXT(',
},
{
  name: 'DATE',
  label: 'DATE("YYYY-MM-DD") — fixed date',
  type: 'function',
  insertText: 'DATE("',
},
```

Note `DATE`'s `insertText` includes the opening quote (`'DATE("'`) — the other two just open the
paren. Per ADR 0027 D3 "Reserved-word lookahead": NUMBER/TEXT/DATE dispatch as functions only when
immediately followed by `(` — a bare `date`/`text`/`number` field reference still works (deliberate
departure from the hard-reserved IF/SUM precedent).

### Inline validation — system-field kind coverage (fix-wave item [A], commit `0f40b22bc3`)

`deriveObjectFields` (formula-field-input.tsx:164-210) builds `kindsByName` over **ALL** of the
object's fields, unfiltered — including system fields (e.g. `createdAt`) and inactive fields —
because the server's kind gate types every field, so filtering the editor's map would let it infer
`unknown` (skip) for a reference the server actually types and rejects. This closes what the ledger
calls a "Task-3 regression class": previously the editor's `kindsByName` only covered the narrowed
suggestible-field set, so a system-field expression like `IF(createdAt > TODAY(), 1, 0)` could pass
editor-live-validate and then be rejected only at real save. Comment, verbatim
(formula-field-input.tsx:143-148):

> kindsByName drives the pre-save string-comparison and strict-kind checks, which must see
> non-suggestible kinds (e.g. MULTI_SELECT) and system/inactive kinds (e.g. createdAt) to reject
> them, so it cannot be derived from the narrowed `fields`.

The narrowed `fields` list (suggestion dropdown) stays filtered to active, non-system,
`SUGGESTIBLE_FIELD_TYPES` (NUMBER/NUMERIC/CURRENCY/BOOLEAN/DATE/DATE_TIME/SELECT/TEXT) — the
kind-coverage widening only affects the validation map, not what shows up in autocomplete.

### Wizard save-gate error display path

Two distinct display mechanisms, both observed in code:

1. **Record-page "Formulas" tab editor** (`formula-editor.tsx`): `liveError` is recomputed via
   `validateExpression` on every render of a definition row (line 833-840) and disables the Save
   button (`disabled={!dirty || Boolean(liveError) || rowBusy}`, line 981) — this is a pure
   client-side pre-save check, never touches the network. If `liveError` is empty, `saveExpression`
   (line 602) re-validates identically before firing the mutation; if that validation now fails
   (race/stale state), it sets `definition.lastError` in local state (line 613-619) WITHOUT calling
   the mutation. Render precedence (line 1014-1017): `liveError` shown first if present, else
   `definition.lastError` (a prior real save-time rejection persisted server-side).
2. **Formula setup wizard** (`formula-setup-wizard.tsx`): no live pre-save validation call found;
   it wraps the `createFormulaDefinition`/similar mutation in try/catch and on rejection sets local
   `error` state (lines 699-700, 790-791) rendered via `<ErrText as="div">{error}</ErrText>`
   (line 1038) — i.e. it surfaces the SERVER's rejection (the exact `handle-formula-change.ts` →
   `validateFormula` → `validateExpressionCore` error string) rather than pre-computing it
   client-side.

---

## 5. Current dev workspace state

Dev workspace schema: `workspace_1wgvd1injqtife6y4rvfbu3h5` (the other schema present,
`workspace_3ixj3i1a5avy16ptijtb3lae3`, has no `_formulaDefinition`/`_formulaOverride` tables — not
the formula-field app's workspace). Table names are `_formulaDefinition` and `_formulaOverride`
(underscore-prefixed, workspace-schema convention).

### `_formulaDefinition` — all 6 rows (queried live via `mcp__postgres__query`)

| id | name | target | expression | enabled | lastError | outputFormat |
|---|---|---|---|---|---|---|
| `934808fc-0839-472d-81ca-80ef35a19bc5` | T2 seed - legacy TEXT mirror (surveyResult.comments <- shortNotes) | surveyResult.comments (TEXT) | `shortNotes` | true | null | **mirror** |
| `ac778b67-9890-42ba-ab06-eb0c7134380a` | T2 seed - numeric control (pet.age <- literal 2+2) | pet.age (NUMBER) | `2 + 2` | true | null | decimal |
| `e3b98982-fd86-42cc-8130-27acb4a87eaf` | T4 Text Greeting | pet.t4TextGreeting (TEXT) | `isGoodWithKids & ""` | true | null | text |
| `964f3c82-d52e-4bdf-b684-682a4961be2e` | T4 Tab Enabler | surveyResult.t4TabEnabler (TEXT) | `name & " (T4)"` | true | null | text |
| `9eacde36-d006-42b0-b439-9cb1b852796e` | T5 demo 1 - H2 date-shaped TEXT compare (surveyResult.score) | surveyResult.score (NUMBER) | `IF(shortNotes = "2026-01-15", 1, 0)` | **false** | null | decimal |
| `0b845ca6-fca2-4d32-a38f-e56a5d8faf1e` | T5 demo 2 - lone string literal condition (surveyResult.participants) | surveyResult.participants (NUMBER) | `IF("a", 1, 2)` | **false** | `NON_NUMERIC_VALUE: Text value is not numeric ("a")` | decimal |

None are soft-deleted (`deletedAt` null on all 6). `lastValueText` on the TEXT-target rows:
`934808fc…` = `"20468"`, `e3b98982…` = `"0"`, `964f3c82…` = `"T5 demo - H2 date-shaped TEXT
compare (T4)"` (note: this is the mirror-computed value of a DIFFERENT definition's `name` field —
`t4TabEnabler` mirrors `surveyResult.name`, and that record's name happens to be one of the T5
fixture's own display name, an unrelated naming coincidence, not a data-integrity issue).

**T2/T4/T5 residue classification per `2026-08-04-live-verification-handoff.md`** (that handoff's
own T-numbers are TASK numbers within its plan, e.g. "T2 — Seed pre-upgrade-shaped state",
"T4 — Wizard and editor UI pass", "T5 — Known-delta live demonstrations" — the fixture names in
the DB directly cite which handoff task created them):
- **T2 fixtures** (2 rows): `934808fc…` (legacy TEXT mirror seed) and `ac778b67…` (numeric control)
  — created per the handoff's T2 "seed pre-upgrade-shaped state" task.
- **T4 fixtures** (2 rows): `e3b98982…` (Text Greeting) and `964f3c82…` (Tab Enabler) — created per
  the handoff's T4 "wizard and editor UI pass" task.
- **T5 fixtures** (2 rows, both `enabled: false`): `9eacde36…` and `0b845ca6…` — created per the
  handoff's T5 "known-delta live demonstrations" task (H2 date-shaped-text compare demo, and the
  lone-string-literal-condition demo). Per Task 8's report, these being `enabled: false` is WHY
  `audit-strict-gate.ts` (which only walks `loadAllEnabledFormulas`) does not surface them, even
  though they are pre-existing strict-violating shapes (`9eacde36…`'s expression
  `IF(shortNotes = "2026-01-15", 1, 0)` is exactly the S1 rejection shape; `0b845ca6…`'s
  `IF("a", 1, 2)` is exactly the S4 rejection shape).

### Mirror-lane definitions

Exactly one: `934808fc-0839-472d-81ca-80ef35a19bc5` (`outputFormat: 'mirror'`, TEXT target,
bare-ref `shortNotes` expression). All other 5 rows are engine-lane (`decimal`/`text`
outputFormat).

### `_formulaOverride` — both rows (queried live)

| id | name | target | overrideValueText | active |
|---|---|---|---|---|
| `1a6314c0-c1af-4670-91c8-56eb27ab8302` | surveyResult.comments#a8713d5d-a24e-4d5e-a62c-7c68d9987deb | surveyResult.comments, record `a8713d5d-…` | `"Pinned comment value"` | true |
| `31a08b1f-eff7-43c9-a08e-470e3a85a863` | surveyResult.comments#55aa3458-f54e-4630-a23c-04eaae2f83f8 | surveyResult.comments, record `55aa3458-…` | `"irrelevant-source-junk-for-override-case-D"` | true |

Both pin the mirror-lane definition `934808fc…`'s target field (`surveyResult.comments`); both
`overrideValue` (numeric column) are null — TEXT-target overrides pin through
`overrideValueText` only, per `pinnedOverrideValue` in `handle-record-update.ts:79-88`.

### Task 8's blast-radius audit output (enabled-only, from `task-8-report.md` — for cross-reference, NOT re-run here)

```
id                                   | name                                                               | target                    | verdict
------------------------------------ | ------------------------------------------------------------------ | ------------------------- | ----------------------------------------------------
934808fc-0839-472d-81ca-80ef35a19bc5 | T2 seed - legacy TEXT mirror (surveyResult.comments <- shortNotes) | surveyResult.comments     | PASS
964f3c82-d52e-4bdf-b684-682a4961be2e | T4 Tab Enabler                                                     | surveyResult.t4TabEnabler | PASS
ac778b67-9890-42ba-ab06-eb0c7134380a | T2 seed - numeric control (pet.age <- literal 2+2)                 | pet.age                   | PASS
e3b98982-fd86-42cc-8130-27acb4a87eaf | T4 Text Greeting                                                   | pet.t4TextGreeting        | GATED: "&" joins text; wrap boolean values in TEXT()

Total: 4  PASS: 3  GATED: 1  PARSE: 0
```

Reconciling this against the live 6-row table: `T4 Text Greeting` shows `lastError: null` in the DB
even though the audit script GATES it — this is expected and non-contradictory: the audit script is
a read-only, zero-write offline inference; it does not write its verdict back to `lastError`. The
definition row's actual `lastError` column reflects only what the real save/sweep/event gate has
written, and per Task 8's report this row predates the strict-typing gate's deployment onto this
data (it was a T4-handoff fixture from the STRING-OUTPUT arc, seeded 2026-08-04, before ADR 0027
existed) — so its `lastError` has never been touched by the new gate. **This is a live-test-visible
gap**: does the sweep/event path actually write the GATED error onto this row once triggered, or
does it remain stale null until the next real evaluation cycle touches it? (Inventory only — not
adjudicated here.)

---

## 6. Prior live-pass conventions (`2026-08-04-live-verification-handoff.md`)

**Mode**: superpowers:subagent-driven-development discipline — orchestrator dispatches every
mechanical step (server starts, seeding, UI driving, DB queries) to subagents; does only briefs,
adjudication, ledger upkeep.

**Verdict format**: Task T6 ("Verdict synthesis") collates T3-T5 into "a single verdict table:
PASS / EXPECTED-DELTA (with ADR cite) / FINDING. Any FINDING: adjudicate — real regressions get one
fix dispatch + scoped re-review per SDD, doc-only gaps get appended to the execution ledger's
follow-up list." Evidence type per check: DB row comparison against an expectations table (T3),
Playwright screenshots per numbered UI item (T4), and named documentation demos, not bugs to fix
(T5, for the H2/lone-literal known-deltas).

**Fixture naming convention**: task-number-prefixed display names inside the `name` field itself —
`"T2 seed - <description>"`, `"T4 <ShortLabel>"`, `"T5 demo <n> - <description>"` — so a fixture's
provenance is legible directly from a DB dump without cross-referencing a separate id map. This is
the same convention the confirmed dev-DB rows in §5 follow.

**Model roster**: "Dispatch with explicit models: haiku for pure-mechanical (process starts,
single-script seeding from a complete spec), sonnet for multi-step drive-and-observe work (UI
flows, seed-then-query), opus only where the subagent must judge observed behavior against the ADR
in the field. The orchestrator (opus) adjudicates every observation report against the expectations
table below — subagents report what happened, the orchestrator decides pass/delta/fail."

**Cleanup conventions**: T6 instructs "Tear down or leave the dev processes per user preference;
note which in the ledger" — teardown of dev PROCESSES (server/worker/front) is a user preference,
not mandatory; no instruction to delete seeded fixtures (the T2/T4/T5 rows in §5 are the surviving
residue of exactly this — they were never torn down).

**Gaps #2/#3 (F1-empty-string)** — **could not be filled from this repository.** The design doc
and ADR 0027 both cite `verification-reports/T6-verdict.md` as the source of the F1-empty-string
finding (a bug distinct from the unrelated same-numbered "F1-scope-guard" efficiency finding), but
that file is not present anywhere in this git history (`git log --all` finds no commit ever adding
a `T6-verdict.md`, in any path) — it appears to have been an ephemeral scratchpad artifact from the
prior live-verification session, never committed. The only description of its symptom available in
this repo is the draft plan's own paraphrase (`2026-08-05-strict-typing-live-verification-plan.md`
ground rule 4): *"The F1-empty-string bug's symptoms (empty-string TEXT dependency reverting to
NULL via API/event path) are a KNOWN pre-existing issue — if observed, record under
'known-issue sightings', do not fail the check, do not fix in this phase."* Numbered "gap #2/#3"
specifically (as opposed to a general F1-empty-string mention) does not appear verbatim anywhere in
the accessible corpus — the plan author should treat the paraphrase above as the only available
description and NOT invent a #2/#3 numbering from it. This gap must not be misattributed: it is
about an empty-string TEXT dependency reverting to NULL, NOT about any strict-typing S-rule.

---

## 7. Fix-wave live carry-forwards (`.superpowers/sdd/2026-08-05-strict-typing-implementation/progress.md`, verbatim)

> LIVE-PASS CARRY-FORWARD: (1) cross-impacted cross-object def failing its gate now writes a
> definition-row error where it previously silently skipped (intended, newly visible); (2)
> system-field expressions now show inline editor errors pre-save (intended); (3) heartbeat
> mutates React-held definition objects — confirm no stale widget render

> FINAL REVIEW parked: handle-record-update.ts:183 pre-pass tests updatedFields !== undefined
> while siblings use !updatedFields — ruling: unreachable under declared type (string[] |
> undefined), style-consistency only, fold into any future touch of that file

(For reference, `handle-record-update.ts:183`, quoted from the source read in this session:

```ts
if (
  actorWorkspaceMemberId &&
  updatedFields !== undefined &&
  updatedFields.length > 0 &&
  typeof formula.targetField === 'string' &&
  updatedFields.includes(formula.targetField)
) {
  return true;
}
```

— siblings elsewhere in the same file (e.g. `sameRecordAffected`, line 96) use `!updatedFields`
instead of `updatedFields !== undefined`.)

---

## 8. Observability hooks

### Sweep scheduling

`src/logic-functions/formula-sweep.ts:120`: `cronTriggerSettings: { pattern: '0 * * * *' }` —
**hourly**, on the hour. (Sibling app cron jobs for reference: `variation-sweep.ts:55` also
`'0 * * * *'`; `timeline-cleanup.ts:23` is `'*/10 * * * *'`, every 10 minutes — NOT the formula
sweep.) No on-demand HTTP/CLI trigger for the cron was found in the app source; the only two other
ways a recompute pass runs outside the hourly cron are: (a) the event path
(`handle-record-update.ts`, fires per database-event trigger, not on a schedule), and (b) the
front-end's own on-visit refresh (`refresh-stale-formulas.ts`, referenced from
`formula-editor.tsx:509` — "definition page is visited or the hourly cron sweep runs"). A live test
that cannot wait an hour for the real cron would need to either drive the event path directly
(create/update a source record) or find an explicit sweep-trigger entry point in
`twenty-server`'s cron/BullMQ admin surface (not investigated here — out of this inventory's
source set, which was scoped to the formula-field app package).

### Heartbeat / evidence columns on `_formulaDefinition`

Confirmed live column list (via Postgres MCP, `information_schema.columns`): `lastEvaluatedAt`
(timestamptz), `lastValue` (double precision — engine-lane numeric target), `lastValueText` (text —
JSON-encoded string envelope, e.g. `"20468"` with the quotes literally part of the stored text, for
TEXT-target/mirror-lane rows), `lastError` (text), plus `status`/`statusReason`/`scanCursor` as
additional bookkeeping (the `BOOKKEEPING_FIELDS` set in `handle-formula-change.ts:16-24` also lists
`dependencies` as bookkeeping). A pass advancing `lastEvaluatedAt` alone (no other column change) is
the D6 "heartbeat single-write" signature for a definition whose computed value hasn't changed.

### Per-record errors and overrides

- `_formulaOverride` table (confirmed columns): `targetObject`, `recordId`, `targetField`,
  `overrideValue` (double precision, numeric-lane pin), `overrideValueText` (text, TEXT-lane /
  mirror-lane pin, JSON-encoded), `active` (boolean). Two live rows exist now (§5).
- Per-record eval errors (cast runtime failures, kind-unknown refs) do NOT land in any per-record
  table — per D6 they produce `write: null` (the outcome object's `error` field) and are NEVER
  persisted to the target record or to a timeline row; the only durable trace is the definition-row
  `lastError`/heartbeat (aggregate, not per-record) UNLESS the specific failing record happens to be
  the one whose error the sweep's "first-error write" captured (a known single-slot mechanism, not
  a per-record log).
- `timelineActivity` exists as a table in the OTHER workspace schema
  (`workspace_3ixj3i1a5avy16ptijtb3lae3`), not the one holding the formula tables
  (`workspace_1wgvd1injqtife6y4rvfbu3h5`) — meaning the two are different Twenty workspaces
  entirely; a live test targeting formula data must stay in
  `workspace_1wgvd1injqtife6y4rvfbu3h5`, and its own `timelineActivity` table was not separately
  queried in this pass (not selected by the `%formula%` OR `%timeline%` filter run against that
  schema — a live test should re-query
  `information_schema.tables` for `table_schema = 'workspace_1wgvd1injqtife6y4rvfbu3h5' AND
  table_name ILIKE '%timeline%'` directly, which this inventory did not do).

### Server log observability

The most recent `npx nx start twenty-server` run
(`/tmp/claude-1000/-home-sasha-shin-twenty/92e8a28c-c10d-4a8d-af29-d2104f7504ab/tasks/blbevajxj.output`,
855 lines, readable) shows a normal NestJS boot: all modules initialized
(`LogicFunctionLayerModule`, `LogicFunctionModule` among them), routes mapped
(`/metadata`, `/graphql`, `/admin-panel`, `/rest/*`), config loaded, ending at
`[NestApplication] Nest application successfully started` (line 844) at 08/05/2026 4:57:17 PM.
Immediately after, the process exited non-zero (`Warning: command "rimraf dist && NODE_ENV=
development nest start --watch" exited with non-zero status code`, lines 845-848) — **confirming
the server is currently STOPPED**, matching the progress.md session-stop note ("Dev server STOPPED
... Postgres/Redis left up"). Grepping the full log for `formula`/`error`/`warn` (case-insensitive)
found ZERO lines mentioning the formula-field app by name and ZERO warning/error lines besides the
final non-zero-exit warning — i.e. this log slice shows only generic Nest startup, no
`LogicFunctionLayerModule` cron-tick, sweep-run, or per-formula activity log line at all. This
means: **it is not yet established from available evidence whether the formula sweep/event
pipeline emits any distinguishable log line at INFO level** — a live test relying on log-based
observability (e.g. the P4 "lazy-gate" check's log-evidence fallback) should first confirm whether
such a line exists at all once the server actually runs long enough to hit an hourly tick or an
event, or fall back to DB-column evidence (`lastEvaluatedAt` ticks, `write`-absence) as the plan's
own ground rules already anticipate. Per the task's explicit instruction, the server was NOT
started to check this further.

---
## CORRECTIONS (design review, 2026-08-05)
- §5 WRONG: T5 demo 1 (`9eacde36…`, `IF(shortNotes = "2026-01-15", 1, 0)`) is NOT the S1 shape — `shortNotes` is TEXT, so this is a legal text=text comparison under strict typing and PASSES the gate. Do not use as a gated fixture.
- §5 WRONG: the `outputFormat:'mirror'` row (`934808fc…`) runs the ENGINE lane, not mirror (TEXT is not in MIRRORABLE_KINDS; lane is decided by target kind). The workspace has ZERO true mirror-lane definitions.
- §4 WRONG (item 2): the wizard never submits an expression on the engine path and cannot display a save-gate rejection (rejection lands async on the row via the DB trigger, no channel to the mutation caller).
- §8 ADDITION: timelineActivity DOES exist in workspace_1wgvd1injqtife6y4rvfbu3h5; the app's timeline-cleanup cron (*/10) soft-deletes formula noise — 10-minute observation window.
- Save validation runs on EVERY non-bookkeeping update (incl. enabled-only, name-only): rejection writes enabled:false + lastError asynchronously. Heartbeat writes NOTHING on a converged pass (no lastEvaluatedAt tick) outside the TODAY-staleness carve-out.
