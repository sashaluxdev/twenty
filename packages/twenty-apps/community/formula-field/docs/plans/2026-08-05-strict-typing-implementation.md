# Strict Kind Typing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the strict kind typing design (`docs/plans/2026-08-05-strict-typing-design.md`): a five-kind static type system enforced at save, kind-aware runtime resolution with zero shape-sniffing, NUMBER/TEXT/DATE functions, a per-definition static gate for legacy definitions, and hoisted per-pass compilation. v0.3.0, supersedes ADR 0026 B2/B6.

**Architecture:** A new app-layer module `kind-inference.ts` walks the engine AST assigning each node one of seven kinds (number/date/datetime/text/boolean/opaque/unknown) from field metadata + literal types, rejecting mismatches and stamping `renderAs` annotations on TEXT-cast nodes. `validateExpressionCore` runs it at save; `recomputeAllRecords`/`handleRecordUpdate`/`recomputeForRecord` run it as a per-definition static gate (the cyclic skip is the *posture* precedent — record the problem, skip the work — not the code shape; see Task 6) and thread a once-per-pass kinds map into a kind-aware `buildResolver`. The engine stays kind-agnostic except for reading `renderAs`.

**Tech Stack:** TypeScript, vitest (unit; `npx vitest run` from package root), Twenty Apps SDK. Package root for ALL paths below: `packages/twenty-apps/community/formula-field/`.

## Global Constraints

- **Efficiency is a substrate design priority: every operation pays rent.** No per-record compile, no per-record metadata lookup, no new writes on converged state, no new queries on hot paths. Kind inference runs per-save and per-definition-per-pass only.
- Baseline: 1084 tests / 66 files green (`npx vitest run`, ~6.5s). Suite must be green at every commit.
- Zero schema changes. No new columns, no field UID edits. `FormulaDefinitionRecord` unchanged.
- The engine (`src/engine/`) never sees field metadata. It may read the `renderAs` annotation stamped by the app layer — nothing else kind-related.
- `validation-core.ts` ships in the front bundle (ADR 0024): keep additions to compact data + one walk; no new dependencies.
- Code style: named exports only, types over interfaces, no `any`, no abbreviations, kebab-case files, `//` comments explaining WHY only. Error copy in messages: sentence case, name the field/operator, name both kinds.
- Version bumps to 0.3.0 only in the final task. No deploy, no push, no formulahelp edits (all separately gated on user approval).
- Commit after every task with `feat(formula-field): ...` / `test(formula-field): ...` / `docs(formula-field): ...`; no signatures or co-author tags.
- Legacy compatibility doctrine: statically-decidable violations → per-definition gate error, no scan; runtime-only failures (cast content, unknown kinds) → per-record eval error with `write: null` (existing posture).

---

### Task 1: Cast/literal AST nodes, parser, evaluator (NUMBER, TEXT, DATE)

**Files:**
- Modify: `src/engine/ast.ts` (add 3 node types to the union)
- Modify: `src/engine/parser.ts` (reserved words + parse methods in `parsePrimary`'s FIELD case, alongside `if`/`today`/`sum` at :235-268)
- Modify: `src/engine/evaluator.ts` (3 `evaluateNode` cases)
- Modify: `src/engine/dependencies.ts` (walk + `usesToday` cases for the 3 nodes)
- Modify: `src/engine/date-serial.ts` (1-entry render cache)
- Test: `src/engine/__tests__/parser.spec.ts`, `src/engine/__tests__/evaluator.spec.ts`, `src/engine/__tests__/dependencies.spec.ts`

**Interfaces:**
- Produces (in `ast.ts`, exported and added to the `AstNode` union):

```ts
export type RenderKind = 'number' | 'date' | 'datetime' | 'boolean' | 'value';
export type DateLiteralNode = { type: 'dateliteral'; value: number; literal: string };
export type NumberCastNode = { type: 'numbercast'; operand: AstNode };
export type TextCastNode = { type: 'textcast'; operand: AstNode; renderAs?: RenderKind };
```

- `DATE("YYYY-MM-DD")` constant-folds at parse: the parser calls `parseDateOnlyToEpochDays` on the literal; an invalid calendar date or a non-string-literal argument throws `PARSE_ERROR` (message: `DATE() requires a literal "YYYY-MM-DD" date`). The folded node keeps `literal` for error copy. IFS/SWITCH `foldLadder` precedent (parser.ts:554-568).
- **Lookahead-only reservation (user decision 2026-08-05):** `number`/`text`/`date` dispatch as functions ONLY when the identifier is immediately followed by `LPAREN` (`this.tokens[this.position + 1].type === 'LPAREN'` — one-token lookahead already available). A bare `date` (or `text`, `number`) stays an ordinary field reference — fields with these names keep working. This deliberately differs from the hard-reserved IF/SUM precedent; say so in a short why-comment at the dispatch site. Pin it: `expect(parse('date')).toEqual({ type: 'field', path: 'date' })` and `expect(parse('date + 1')).toMatchObject({ type: 'binary' })`.
- `renderAs` is OPTIONAL and stamped later by kind inference (Task 2). Evaluator dispatch when absent = `'value'` behavior.

- [ ] **Step 1: Write failing parser tests** in `parser.spec.ts`:

```ts
describe('cast and literal functions', () => {
  it('folds DATE("2026-01-15") to a dateliteral node at parse time', () => {
    const ast = parse('DATE("2026-01-15")');
    expect(ast).toEqual({ type: 'dateliteral', value: 20468, literal: '2026-01-15' });
  });
  it('rejects DATE with an invalid calendar date at parse', () => {
    expect(() => parse('DATE("2026-13-40")')).toThrowError(/DATE\(\) requires a literal/);
  });
  it('rejects DATE with a non-literal argument at parse', () => {
    expect(() => parse('DATE(someField)')).toThrowError(/DATE\(\) requires a literal/);
  });
  it('parses NUMBER(field) into a numbercast node', () => {
    expect(parse('NUMBER(code)')).toEqual({
      type: 'numbercast', operand: { type: 'field', path: 'code' },
    });
  });
  it('parses TEXT(amount) into a textcast node without renderAs', () => {
    expect(parse('TEXT(amount)')).toEqual({
      type: 'textcast', operand: { type: 'field', path: 'amount' },
    });
  });
  it('enforces arity: NUMBER() and TEXT(a, b) are parse errors', () => {
    expect(() => parse('NUMBER()')).toThrowError();
    expect(() => parse('TEXT(a, b)')).toThrowError();
  });
});
```

(Compute 20468 in-test if preferred: `parseDateOnlyToEpochDays('2026-01-15')` — do not hardcode a wrong serial; verify by import.)

- [ ] **Step 2: Run** `npx vitest run src/engine/__tests__/parser.spec.ts` — expect FAIL (reserved-word `PARSE_ERROR` or shape mismatch).
- [ ] **Step 3: Implement.** `ast.ts`: add the three types + `RenderKind`, extend the `AstNode` union. `src/engine/index.ts`: export `RenderKind`, `DateLiteralNode`, `NumberCastNode`, `TextCastNode`, and `ConcatNode` (tests in Tasks 1-2 import them; today the barrel exports only `AstNode` from ast.ts). `parser.ts`: in `parsePrimary`'s FIELD case add three lower-cased checks (`'number'`, `'text'`, `'date'`) that dispatch to `parseNumberCast()`, `parseTextCast()`, `parseDateLiteral()` ONLY when the next token is LPAREN (lookahead reservation above — otherwise fall through to the field-reference path), each parse method mirroring `parseIfBlank`'s structure (`this.enter()`/`this.leave()`, single argument via `this.parseConcat()`, RPAREN check). `parseDateLiteral` requires the next token to be a STRING literal token (not an expression); on anything else or on `parseDateOnlyToEpochDays` throwing, throw `new FormulaError('PARSE_ERROR', 'DATE() requires a literal "YYYY-MM-DD" date', position)`.
  Import direction: `date-serial.ts` lives under `src/logic-functions/lib/` and the engine must not import app-layer code. MOVE it to `src/engine/date-serial.ts` — it imports only `src/engine/errors`, so the move is legal (`text-format.ts` precedent: lives in engine, imported by both layers) — EXCEPT `currentEpochDay()`, which reads the system clock; three documented invariants (ast.ts:80-82, evaluator.ts:78-82, date-serial.ts:78-81) say the engine never does that. Leave `currentEpochDay` behind in a new `src/logic-functions/lib/current-epoch-day.ts` (its only importer is `recompute.ts:29`). Update the 7 importers: `coercion.ts:8`, `recompute.ts:29`, `value-io.ts:8`, `front-components/lib/display-value.ts:4`, and 3 spec files (`value-io.spec.ts:10`, `coercion.spec.ts:7`, `date-target.spec.ts:3`). Do the move mechanically, before wiring.
  Transient note: `dependencies.ts` also contains `walkStringComparisons` (:235-317, deleted in Task 3); do NOT extend it for the new nodes — it returning without descending into cast operands is harmless for the one task it survives.
- [ ] **Step 4: Run parser tests** — PASS. Run full suite to catch import-path fallout from the move: `npx vitest run` — PASS (1084 + new).
- [ ] **Step 5: Write failing evaluator tests** in `evaluator.spec.ts`:

```ts
describe('cast evaluation', () => {
  const resolve: VariableResolver = (ref) =>
    ref.kind === 'same'
      ? ({ amount: 42.5, code: ' 42 ', label: 'ACME', when: 20468, flag: 1 } as
          Record<string, EngineValue>)[ref.path]
      : null;
  it('evaluates a dateliteral to its epoch-day serial', () => {
    expect(evaluate({ type: 'dateliteral', value: 20468, literal: '2026-01-15' }, resolve)).toBe(20468);
  });
  it('NUMBER trims and parses numeric text, propagates null, and errors on non-numeric', () => {
    expect(evaluate(parse('NUMBER(code)'), resolve)).toBe(42);
    expect(evaluate(parse('NUMBER(missing)'), () => null)).toBeNull();
    expect(() => evaluate(parse('NUMBER(label)'), resolve)).toThrowError(FormulaError);
  });
  it('TEXT dispatches on renderAs: date, datetime, boolean, number, value', () => {
    const textOf = (renderAs: RenderKind, operand: AstNode): EngineValue =>
      evaluate({ type: 'textcast', operand, renderAs }, resolve);
    expect(textOf('date', { type: 'field', path: 'when' })).toBe('2026-01-15');
    expect(textOf('number', { type: 'field', path: 'amount' })).toBe('42.5');
    expect(textOf('boolean', { type: 'field', path: 'flag' })).toBe('true');
    expect(textOf('value', { type: 'field', path: 'label' })).toBe('ACME');
  });
  it('TEXT without renderAs behaves as value: numbers render canonically, text passes through', () => {
    expect(evaluate(parse('TEXT(amount)'), resolve)).toBe('42.5');
    expect(evaluate(parse('TEXT(label)'), resolve)).toBe('ACME');
  });
  it('TEXT propagates null', () => {
    expect(evaluate(parse('TEXT(missing)'), () => null)).toBeNull();
  });
  it('TEXT results are never length-capped (only & is)', () => {
    const long = 'x'.repeat(MAX_COMPUTED_TEXT_LENGTH + 100);
    expect(evaluate(parse('TEXT(label)'), () => long)).toBe(long);
  });
});
```

- [ ] **Step 6: Run** — FAIL. **Implement** the three `evaluateNode` cases:

```ts
case 'dateliteral':
  return node.value;
case 'numbercast': {
  const value = evaluateNode(node.operand, resolve, depth + 1, maxDepth, todayEpochDay);
  if (value === null) return null;
  return typeof value === 'number' ? value : toNumber(value);
}
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

Bound the value excerpt in `toNumber`'s error message (evaluator.ts:100 currently interpolates the
full `JSON.stringify(value)`; that string now lands in `lastError` via the cast path): truncate the
stringified value to 80 characters with a trailing `…` before interpolation, in `toNumber` itself
(one place, covers arithmetic and NUMBER() alike). Add a pin:

```ts
it('bounds non-numeric error messages (no unbounded record content in lastError)', () => {
  const longText = 'x'.repeat(500);
  expect(() => evaluate(parse('NUMBER(label)'), () => longText))
    .toThrowError((error: FormulaError) => error.message.length < 160);
});
```

**Scope of the bound (do not overclaim it):** `toNumber` is the choke point for the *evaluator's*
arithmetic and `NUMBER()` paths only. The resolver-side `coerceToNumber` builds its own
`Field value is not numeric (${JSON.stringify(raw)})` at `coercion.ts:109`, unbounded, and that
string lands in `lastError` exactly the same way. `coercion.ts` belongs to Task 4 — apply the
identical 80-character truncation there (Task 4, Step 3) and state the claim here as
evaluator-scoped. Do NOT write "all NON_NUMERIC_VALUE messages are bounded" in the task report
until Task 4 lands.

Add the 1-entry render cache in `date-serial.ts` (`TEXT(TODAY())` across a 387-record sweep hits one serial repeatedly):

```ts
let lastRenderedSerial: number | null = null;
let lastRenderedString = '';
// inside epochDaysToDateString, before computing:
if (epochDays === lastRenderedSerial) return lastRenderedString;
// after computing `rendered`:
lastRenderedSerial = epochDays; lastRenderedString = rendered;
```

`dependencies.ts`: add `dateliteral` (no children), `numbercast`/`textcast` (walk `operand`) to the walk and to `usesToday`. Blank `renderAs` note: `dependencies` output is unaffected by annotations.
- [ ] **Step 7: Run** evaluator + dependencies specs, then full suite — PASS.
- [ ] **Step 8: Commit** `feat(formula-field): NUMBER/TEXT casts and DATE literal in engine (parse-folded, renderAs-dispatched)`

---

### Task 2: Kind inference module

**Files:**
- Create: `src/logic-functions/lib/kind-inference.ts`
- Test: `src/logic-functions/lib/__tests__/kind-inference.spec.ts`

**Interfaces:**
- Produces (consumed by Tasks 3, 5, 6):

```ts
export type ExpressionKind =
  | 'number' | 'date' | 'datetime' | 'text' | 'boolean'
  | 'opaque'    // KNOWN field type outside the lattice (LINKS, MULTI_SELECT, ADDRESS, RATING, ...):
                // mismatches every operation and every known kind — preserves branch 1b/1d's
                // save-time rejections, which plain 'unknown' would silently loosen
  | 'unknown';  // kind not resolvable (no metadata) — every constraint skipped, never rejected
export type KindLookup = (objectName: string) => Map<string, string> | undefined;
// Maps a Twenty field type to a kind; anything unrecognized -> 'unknown'.
export const fieldTypeToKind = (fieldType: string | null | undefined): ExpressionKind;
// Walks the AST: returns the expression's kind, or the first mismatch as `error`.
// SIDE EFFECT: stamps `renderAs` on every TextCastNode from its operand's kind.
export type KindInferenceResult =
  | { kind: ExpressionKind; error: null }
  | { kind: null; error: string };
export const inferExpressionKind = (
  ast: AstNode,
  hostObject: string,
  fieldKinds?: KindLookup,
): KindInferenceResult;
// Save/sweep gate: inference + output gate against the target kind.
// Returns null when the definition passes (or is mirror-lane / undecidable).
export const strictKindGateError = (args: {
  ast: AstNode;
  hostObject: string;
  targetFieldType: string | null | undefined;
  fieldKinds?: KindLookup;
}): string | null;
```

- `fieldTypeToKind(fieldType)`: `null`/`undefined` → `unknown`; `NUMBER`,`NUMERIC`,`CURRENCY` → `number`; `DATE` → `date`; `DATE_TIME` → `datetime`; `TEXT`,`SELECT` → `text`; `BOOLEAN` → `boolean`; **any other non-empty type → `opaque`** (RATING included — Twenty stores it as an enum string; it was never resolvable in the engine lane and 1b rejected comparisons on it). Callers pass `undefined` when the field is absent from the map.
- `opaque` rules: mismatches every operation (arithmetic, comparisons, `&`, conditions, SUM, NUMBER()); in TEXT() it is rejected too (`TEXT() cannot render a ${fieldType} field`) — composites have no canonical text rendering. `opaque` unifies only with `unknown` in branch positions.
- **How `opaque` renders in copy (deliberate asymmetry, do not "fix" it silently):** generic mismatch messages interpolate the bare kind label `opaque` (`Cannot compare opaque with text using "=" (kinds must match)`), because the generic path holds only a kind, not the originating field type. TEXT()'s dedicated message interpolates the RAW field type (`TEXT() cannot render a LINKS field`), because that call site still has the field in hand. If the walk is refactored to carry the originating field type alongside the kind, unify on the raw type everywhere and update the Task 2/Task 3 rejection rows to match.
- Node kinds: `number`→number; `string`→text; `null`→unknown; `dateliteral`→date; `today`→date; `field`/`crossref`→ see the dotted-path rule below; comparisons/`and`/`or`/`not`/`isblank`→boolean; `concat`→text; `numbercast`→number; `textcast`→text; `sum`→number; `unary`→number; `if`/`ifblank`→unified branch kind.
- **Dotted paths infer `unknown` (skip, never reject).** Only a BARE root reference (`segments.length === 1`) maps through `fieldTypeToKind`; a **dotted** path (`segments.length > 1`) infers `unknown`. Root-segment inference is knowingly wrong on subpaths — `price.currencyCode` holds text but the root CURRENCY maps to `number`, and `myLinks.primaryLinkUrl` holds text but the root LINKS maps to `opaque`, which would turn `myLinks.primaryLinkUrl & "x"` (correct today) into a save rejection with no escape hatch. Inferring `unknown` loosens save-time rejection for dotted paths relative to branch 1b — the safe direction, since 1b was over-rejecting on paths it never resolved. Kind of a missing map or missing field → `unknown`. (This also discharges D1's "the implementation plan pins the exact unit for CURRENCY" obligation: a bare `price` is `number` in micros; subpaths are ungated.)
- Rules (mismatch when BOTH sides known; `unknown` always passes):
  - `=`/`!=`: kinds equal. Message: `Cannot compare ${left} with ${right} using "${op}" (kinds must match)`.
  - `<`,`<=`,`>`,`>=`: kinds equal AND in {number,date,datetime}. Two distinct failures, two distinct messages — do not collapse them (S8's own named regression, `closeDate < syncedAt` and `amount < closeDate`, satisfies "in the ordered set" but not "kinds equal"): kinds **unequal** → reuse `Cannot compare ${left} with ${right} using "${op}" (kinds must match)`; kinds **equal but outside** {number,date,datetime} → `Cannot order ${kind} values with "${op}"`.
  - binary `+`: number+number→number; date+number|number+date→date; datetime+number|number+datetime→datetime; else mismatch.
  - binary `-`: number−number→number; date−number→date; datetime−number→datetime; date−date→number; datetime−datetime→number; else mismatch. Message for both: `Cannot apply "${op}" to ${left} and ${right}`.
  - `*`,`/`,`%`, unary, SUM args: number. `concat` parts: text (message: `"&" joins text; wrap ${kind} values in TEXT()`).
  - IF/IFS condition: boolean (message: `Condition must be a comparison or boolean field, got ${kind}`). Branch kinds must unify (unknown unifies with anything; two different known kinds → `IF branches disagree: ${a} vs ${b}`). IFBLANK same unification.
  - `numbercast` operand: text (message: `NUMBER() takes text, got ${kind}`). `textcast` operand: any; stamp `renderAs` = operand kind mapped {number→'number', date→'date', datetime→'datetime', boolean→'boolean', text|unknown→'value'}.
- `strictKindGateError` exact predicate (NOT identical to branch 1c — blank target is deliberately ungated): `if (targetFieldType == null || targetFieldType === '' || !ENGINE_FAMILY_KINDS.has(targetFieldType)) return null;` (mirror lane and blank targets are branch 1c's/nobody's business — skip-never-reject). Else run inference; inference error → return it. Else output gate: expected kind from `targetFieldKind(targetFieldType)` mapped {NUMBER|CURRENCY→number, DATE→date, DATE_TIME→datetime, TEXT→text}; inferred ≠ expected and inferred not `unknown` → `` `Formula computes ${inferred} but the target field holds ${expected}` `` (suggest `TEXT(...)` when expected is text). An `opaque` inferred result also fails the gate (a bare LINKS ref onto a TEXT target — 1d parity).

- [ ] **Step 1: Write failing tests** — table-driven, no client, kinds map inline:

```ts
const kinds = new Map<string, string>([
  ['amount', 'NUMBER'], ['price', 'CURRENCY'], ['closeDate', 'DATE'],
  ['syncedAt', 'DATE_TIME'], ['name', 'TEXT'], ['stage', 'SELECT'], ['isActive', 'BOOLEAN'],
  ['myLinks', 'LINKS'],
]);
// D5 types cross-record operands for the first time (branch 1b exempted them) — give the lookup
// a second object so a cross-ref mismatch is provable here, not only in Task 3.
const opportunityKinds = new Map<string, string>([['closeDate', 'DATE'], ['amount', 'NUMBER']]);
const kindsByObject = new Map<string, Map<string, string>>([
  ['company', kinds], ['opportunity', opportunityKinds],
]);
const lookup: KindLookup = (object) => kindsByObject.get(object);
const CROSS_CLOSE_DATE = '[opportunity:20202020-1c25-4d02-bf25-6aeccf7ea419:closeDate]';
const kindOf = (expression: string): KindInferenceResult =>
  inferExpressionKind(parse(expression), 'company', lookup);
```

**Grammar constraint (verified empirically):** comparisons and AND/OR/NOT/ISBLANK are only parseable
INSIDE an IF condition (`parser.ts:136-146` rejects top-level comparisons, `:299-306` rejects
value-position combinators). Every comparison test below is therefore wrapped in `IF(..., 1, 0)` and
asserted through the IF's result kind or the rejection message. Do NOT "fix" the parser to allow
top-level comparisons — the grammar is as designed.

```ts
describe('inferExpressionKind', () => {
  it.each([
    ['amount + 1', 'number'], ['closeDate + 30', 'date'], ['30 + closeDate', 'date'],
    ['syncedAt + 30', 'datetime'],                            // datetime ± number stays datetime
    ['closeDate - closeDate', 'number'], ['TODAY() - closeDate', 'number'],
    ['syncedAt - syncedAt', 'number'], ['DATE("2026-01-15")', 'date'],
    ['NUMBER(name) * 2', 'number'], ['TEXT(amount) & " units"', 'text'],
    ['IF(isActive, 1, 2)', 'number'], ['IF(amount > 3, name, stage)', 'text'],
    ['IFBLANK(name, "none")', 'text'], ['IF(ISBLANK(closeDate), 1, 0)', 'number'],
    ['IF(stage = "Won", 1, 0)', 'number'],                    // SELECT compares as text
    ['SWITCH(stage, "Won", 1, "Lost", 0)', 'number'],         // desugars to an IF ladder
    ['myLinks.primaryLinkUrl & "x"', 'text'],                 // dotted path -> unknown, not opaque
    ['price.amountMicros + 1', 'unknown'],                    // dotted path -> unknown, not number
  ])('%s infers %s', (expression, expected) => {
    expect(kindOf(expression)).toEqual({ kind: expected, error: null });
  });
  it.each([
    ['IF(closeDate = "2026-01-15", 1, 0)', /Cannot compare date with text/],
    ['IF(closeDate = syncedAt, 1, 0)', /Cannot compare date with datetime/],
    ['IF(amount = name, 1, 0)', /Cannot compare number with text/],
    ['closeDate * 2', /Cannot apply "\*"/],
    ['name + 1', /Cannot apply "\+"/],
    ['amount & "x"', /wrap number values in TEXT\(\)/],
    ['IF(amount, 1, 2)', /Condition must be a comparison or boolean field/],
    ['IF("a", 1, 2)', /Condition must be a comparison or boolean field/],
    ['IF(isActive, 1, "a")', /IF branches disagree: number vs text/],
    ['IF(name < "b", 1, 0)', /Cannot order text values/],
    ['NUMBER(amount)', /NUMBER\(\) takes text, got number/],
    ['IF(myLinks = "x", 1, 0)', /Cannot compare/],            // opaque kind: 1b parity
    ['TEXT(myLinks)', /TEXT\(\) cannot render a LINKS field/], // opaque in TEXT()
    ['IF(closeDate < syncedAt, 1, 0)', /Cannot compare date with datetime/],   // ordered set, unequal kinds
    ['IF(amount < closeDate, 1, 0)', /Cannot compare number with date/],       // ditto (S8 regression)
    ['SWITCH(closeDate, "2026-01-15", 1, 0)', /Cannot compare date with text/], // desugared rung is typed
    [`IF(${CROSS_CLOSE_DATE} = "2026-01-15", 1, 0)`, /Cannot compare date with text/], // cross-record operand
  ])('%s is rejected: %s', (expression, message) => {
    const result = kindOf(expression);
    expect(result.kind).toBeNull();
    expect(result.error).toMatch(message);
  });
  it('treats unknown kinds as unconstrained (skip, never reject)', () => {
    const noKinds: KindLookup = () => undefined;
    expect(inferExpressionKind(parse('IF(mystery = "x", 1, 0)'), 'company', noKinds).error).toBeNull();
    expect(inferExpressionKind(parse('mystery + 1'), 'company', noKinds)).toEqual(
      { kind: 'unknown', error: null },
    );
  });
  it('stamps renderAs on TEXT nodes from the operand kind', () => {
    const ast = parse('TEXT(closeDate) & TEXT(amount) & TEXT(isActive) & TEXT(name)');
    inferExpressionKind(ast, 'company', lookup);
    const renders = (ast as ConcatNode).parts
      .filter((part): part is TextCastNode => part.type === 'textcast')
      .map((part) => part.renderAs);
    expect(renders).toEqual(['date', 'number', 'boolean', 'value']);
  });
});
describe('strictKindGateError', () => {
  const gate = (expression: string, targetFieldType: string): string | null =>
    strictKindGateError({ ast: parse(expression), hostObject: 'company',
      targetFieldType, fieldKinds: lookup });
  it('output gate: kind must match the target', () => {
    expect(gate('amount * 2', 'NUMBER')).toBeNull();
    expect(gate('closeDate + 30', 'DATE')).toBeNull();
    expect(gate('name & "!"', 'TEXT')).toBeNull();
    expect(gate('syncedAt + 30', 'DATE_TIME')).toBeNull();      // datetime target
    expect(gate('price * 2', 'CURRENCY')).toBeNull();           // CURRENCY target expects number
    expect(gate('amount * 2', 'TEXT')).toMatch(/computes number but the target field holds text/);
    expect(gate('name', 'NUMBER')).toMatch(/computes text but the target field holds number/);
    expect(gate('closeDate + 30', 'DATE_TIME')).toMatch(
      /computes date but the target field holds datetime/);
    expect(gate('name & "!"', 'CURRENCY')).toMatch(
      /computes text but the target field holds number/);
  });
  it('mirror-lane and unknown-kind definitions are never gated', () => {
    expect(gate('isActive', 'BOOLEAN')).toBeNull();          // mirror lane, 1c owns it
    expect(strictKindGateError({ ast: parse('mystery'), hostObject: 'company',
      targetFieldType: 'NUMBER', fieldKinds: () => undefined })).toBeNull();
  });
});
```

- [ ] **Step 2: Run** `npx vitest run src/logic-functions/lib/__tests__/kind-inference.spec.ts` — FAIL (module missing).
- [ ] **Step 3: Implement** `kind-inference.ts` as a single recursive `walk(node): ExpressionKind` throwing an internal `KindMismatch` carrying the message (caught at the top and returned as `{kind: null, error}`); helper `unify(a, b)` for branches. Import only from `src/engine` and `value-io`/`mirror-kinds` (bundle discipline). ~150 lines.
- [ ] **Step 4: Run the spec, then the full suite** — PASS.
- [ ] **Step 5: Commit** `feat(formula-field): kind inference walk with strict operation signatures and renderAs stamping`

---

### Task 3: Save gate — validation-core integration, branch 1b/1d retirement

**Files:**
- Modify: `src/logic-functions/lib/validation-core.ts` (insert inference between step 1 and 1c; delete branch 1b at :94-114 and branch 1d at :161-189)
- Modify: `src/engine/dependencies.ts` + `src/engine/index.ts` (delete `collectStringComparisonRefs` + its export + `StringComparisonRefs` **and its two now-orphaned private helpers `walkStringComparisons` and `collectStringOperand` (dependencies.ts:217-317)** — leaving them behind is dead code and a lint failure)
- Modify: `src/logic-functions/lib/handle-formula-change.ts` (preload kinds for ALL cross-ref objects, :112-120)
- Test: `src/logic-functions/lib/__tests__/validation-core.spec.ts`, `src/logic-functions/lib/__tests__/handlers.spec.ts`, `src/engine/__tests__/dependencies.spec.ts`

**Interfaces:**
- Consumes: `strictKindGateError` (Task 2).
- Produces: `validateExpressionCore` rejects kind mismatches with the Task 2 messages. Behavior contract: mirror-lane validation (branch 1c) unchanged; H3's bare-BOOLEAN-onto-TEXT rejection now comes from the output gate (boolean ≠ text) — same protection, new message.

- [ ] **Step 1: Write failing tests.** `validation-core.spec.ts` calls `validateExpressionCore({...})` inline (see :26-40 for the shape) — define these two local helpers at the top of the new describe, then the cases:

```ts
const kinds = new Map<string, string>([
  ['amount', 'NUMBER'], ['closeDate', 'DATE'], ['name', 'TEXT'],
  ['isActive', 'BOOLEAN'], ['myLinks', 'LINKS'],
]);
const opportunityKinds = new Map<string, string>([['closeDate', 'DATE']]);
const kindsByObject = new Map<string, Map<string, string>>([
  ['company', kinds], ['opportunity', opportunityKinds],
]);
const validate = (expression: string, targetFieldType: string) =>
  validateExpressionCore({
    expression, hostObject: 'company', targetField: 'result', targetFieldType,
    fieldKinds: (object) => kindsByObject.get(object), otherFormulas: [],
  });
const validateWithoutKinds = (expression: string, targetFieldType: string) =>
  validateExpressionCore({
    expression, hostObject: 'company', targetField: 'result', targetFieldType,
    otherFormulas: [],
  });

it('rejects a date field compared to a bare text literal at save', () => {
  const result = validate('IF(closeDate = "2026-01-15", 1, 0)', 'NUMBER');
  expect(result.valid).toBe(false);
  expect(result.error).toMatch(/Cannot compare date with text/);
});
it('accepts the DATE() literal form', () => {
  expect(validate('IF(closeDate = DATE("2026-01-15"), 1, 0)', 'NUMBER').valid).toBe(true);
});
it('rejects a number expression onto a TEXT target without TEXT()', () => {
  expect(validate('amount * 2', 'TEXT').error).toMatch(/target field holds text/);
});
it('still rejects a bare BOOLEAN reference onto a TEXT target (H3 parity)', () => {
  expect(validate('isActive', 'TEXT').valid).toBe(false);
});
it('still rejects a bare LINKS reference onto a TEXT target (1d parity via opaque)', () => {
  expect(validate('myLinks', 'TEXT').valid).toBe(false);
});
it('skips kind checks when no kinds map is supplied (unknown-kind policy)', () => {
  expect(validateWithoutKinds('IF(mystery = "x", 1, 0)', 'NUMBER').valid).toBe(true);
});
it('rejects a kind mismatch carried by a cross-record operand (D5 types them; 1b exempted them)', () => {
  const result = validate(
    'IF([opportunity:20202020-1c25-4d02-bf25-6aeccf7ea419:closeDate] = "2026-01-15", 1, 0)',
    'NUMBER',
  );
  expect(result.valid).toBe(false);
  expect(result.error).toMatch(/Cannot compare date with text/);
});
```

Update the existing 1b-pinned tests (string-comparison rejection messages) to the new kind-mismatch copy; the PROTECTION must survive, only the message changes.

**Three additional pre-existing tests reverse; update them in this step — the suite is not green without it.** All three are in `validation-core.spec.ts` and none of them are 1b message pins:
- `:44-54` "accepts a concatenation expression onto a TEXT target" uses `aString & "INV" & 1+TODAY()`. Under the new rules `1+TODAY()` infers `date` (number+date→date) and `&` requires text, so the expression is now rejected. Replace the expression with `aString & "INV" & TEXT(1 + TODAY())`, preserving the "a full engine expression validates onto TEXT" coverage.
- `:71-90` "rejects a bare ref to a non-text source kind onto a TEXT target" pins branch 1d's exact copy with `toEqual`: `Cannot mirror BOOLEAN field "isActive" onto a TEXT field (kinds must match)`. With 1d deleted the same case is caught by the output gate under different copy. Change the assertion to `expect(result.error).toMatch(/computes boolean but the target field holds text/)` — the protection survives, the message does not.
- `:105-119` "leaves a non-bare expression … unrestricted" uses `isActive & ""`, which S5 now rejects. Invert it to assert `/"&" joins text; wrap boolean values in TEXT\(\)/`, and add a positive companion asserting `TEXT(isActive) & ""` is valid onto a TEXT target — that pair is the S5 delta made test-visible.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.** In `validateExpressionCore` after the parse step, call `strictKindGateError({ ast, hostObject, targetFieldType, fieldKinds })` (the helper itself returns null for mirror-lane/blank targets — its predicate is authoritative, Task 2); non-null → `{ valid: false, error, dependencies }`. Keep branch 1c (mirror validation) untouched. Delete branches 1b and 1d and `collectStringComparisonRefs` (function, export, its dependencies.spec tests).
  In `handle-formula-change.ts` (:95-121), update the `src/engine` import first: **add `extractDependencies`, drop `bareReferenceOf` and `parse`** — both are used only inside the block being replaced (:114), so leaving them imported fails lint. Then KEEP the host-object preload (`if (after.targetObject) await preloadKinds(after.targetObject)`) and replace only the bare-ref-only cross preload with:

```ts
try {
  const { crossRecordRefs } = extractDependencies(after.expression ?? '');
  for (const ref of crossRecordRefs) {
    await preloadKinds(ref.object);
  }
} catch {
  // A parse failure surfaces through validateFormula; nothing to preload.
}
```

(All objects come from one cached metadata pull — zero extra network after the first.)
- [ ] **Step 4: Run** validation-core, handlers, dependencies specs; then full suite — PASS.
- [ ] **Step 5: Commit** `feat(formula-field): strict kind gate at save; retire pattern branches 1b/1d`

---

### Task 4: Kind-aware resolver and storage-boundary parsing (B2 removal, F1 guard)

**Files:**
- Modify: `src/logic-functions/lib/coercion.ts` (strip date-sniffing from `coerceToEngineValue` AND `coerceToNumber`)
- Modify: `src/logic-functions/lib/value-io.ts` (`normalizeStoredValue` parses DATE/DATE_TIME by kind)
- Modify: `src/logic-functions/lib/recompute.ts` (`buildResolver` gains kinds; `RecomputeArgs` gains `fieldKindsByObject`)
- Test: `src/logic-functions/lib/__tests__/coercion.spec.ts`, `__tests__/value-io.spec.ts`, `__tests__/recompute.spec.ts`

**Interfaces:**
- Produces:

```ts
// recompute.ts (internal, threaded from Task 5's callers)
const buildResolver = (
  sameRecord: Record<string, unknown>,
  crossRecords: Map<string, Record<string, unknown> | null>,
  kindContext?: { hostObject: string; kindsByObject: Map<string, Map<string, string>> },
): VariableResolver;
export type RecomputeArgs = { /* existing */ fieldKindsByObject?: Map<string, Map<string, string>>; };
```

- Resolution by kind (root segment of the path, `fieldTypeToKind`): `date` → `parseDateOnlyToEpochDays`, falling back to `parseIsoDateTimeToEpochDays`, catch → null; `datetime` → `parseIsoDateTimeToEpochDays`, fallback date-only, catch → null; `text` → string raw verbatim (non-string composite → `coerceToEngineValue`); `number`/`boolean` → `coerceToNumber`; `unknown` or no kindContext → `coerceToEngineValue` (degradation: JS-type-directed, no transforms, never a hard error).
- `coerceToEngineValue` after this task: the `isDateOnlyString`/`isIsoDateTimeString` block is GONE — strings return verbatim (trim only for the emptiness check). `coerceToNumber`: the string branch keeps `Number(trimmed)` parsing, loses the two date-shape branches.
- **F1 guard:** `normalizeStoredValue(raw, kind)` switches on kind: TEXT → string-or-null (unchanged); DATE → for string raw `parseDateOnlyToEpochDays` w/ ISO fallback in try/catch → null, for number raw the number; DATE_TIME → ISO parse first; NUMBER/CURRENCY → `coerceToNumber` try/catch → null (unchanged path, now sniff-free).

- [ ] **Step 1: Rewrite the B2-pinned tests as reversal pins** (these are the test-visible design reversal — call out in review):
  - `coercion.spec.ts`: `it('should still coerce date-shaped strings to serials')` (:89) becomes `it('resolves date-shaped strings verbatim as text (strict typing: no shape-sniffing)')` expecting `'2026-01-15'` in / `'2026-01-15'` out; the `coerceToNumber date parsing` describe (:14) becomes rejection pins (`NON_NUMERIC_VALUE` for date-shaped strings).
  - `value-io.spec.ts` additions (first: add `type TargetFieldKind` to the existing `src/logic-functions/lib/value-io` import — the spec does not import it today, so the block below will not compile without that):

```ts
it.each([
  ['2026-01-15', 'DATE', 20468],
  ['2026-01-15T00:00:00.000Z', 'DATE', 20468],
  ['2026-01-15T12:00:00.000Z', 'DATE_TIME', 20468.5],
  ['8801-25-03', 'DATE', null],           // dirty stored value degrades to null, never throws
  [20468, 'DATE', 20468],
])('normalizeStoredValue(%j, %s) -> %j', (raw, kind, expected) => {
  expect(normalizeStoredValue(raw, kind as TargetFieldKind)).toBe(expected);
});
```

  - `recompute.spec.ts`: the B2 edge pin (:822 `coerces date-shaped content to its serial`) becomes `copies date-shaped TEXT content verbatim (B2 reversed)`; the B6 same-record pin (:843) becomes a save-gate reference note + runtime check that with kinds present, `closeDate = DATE("2026-01-15")` compares true for a matching stored date. **Convergence anti-rewrite-loop pin (the F1 finding):**

```ts
it('DATE-target formula whose value is unchanged performs zero writes across two passes', async () => {
  // client fixture: DATE target storing "2026-01-15", expression "closeDate" (bare date passthrough)
  // run planRecomputeForRecord twice; assert plan.write === null both times.
});
it('DATE_TIME-target formula whose value is unchanged performs zero writes across two passes', async () => {
  // Same shape, fractional serial: stored "2026-01-15T12:00:00.000Z", expression "syncedAt".
  // Round trip is serial -> ISO string -> store -> re-read -> parse -> serial; the re-parsed float
  // must be bit-identical, because valuesEqual compares with === and 20468.5 !== 20468.499999.
  // This is ADR 0022's catastrophic mode at its likeliest point — fractional-day precision.
});
```

  (Fixture: use `FakeClient` from `src/logic-functions/lib/__tests__/fake-client.ts` — it supports `setFieldKinds`, `seed`, `writes`, `mutations`, `querySelections`; the B6 describe at `recompute.spec.ts:843-870` is the exemplar that already combines `setFieldKinds` + `seed` + a full formula literal. Stored target `"2026-01-15"`, formula `targetFieldType: 'DATE'`, expression referencing a same-record DATE source with the same serial, `fieldKindsByObject` supplied.)
  **Callers that must receive kinds or visibly degrade — thread them IN THIS TASK, not in Task 5:** `handle-record-update.ts:217` (`computeFormulaValueForRecord` inside the override-detection loop) and `front-components/formula-editor.tsx:782` (`recomputeForRecord` behind the widget's recompute-now action). Without kinds, a DATE reference resolves verbatim as text and `closeDate + 30` becomes a NON_NUMERIC_VALUE eval error on those paths. Leaving them unthreaded until Task 5 commits a knowingly-red event path for a whole task; map construction is local and cheap, so build it here (a per-formula `resolveFieldKinds` call is acceptable at this point) and let Task 5 hoist it to once-per-event. The editor site resolves kinds itself via its client (it is per-user-click — one cached `fieldKinds` call is fine).
  *Considered, deferred (efficiency review #9): stamping resolved kinds directly onto field nodes at compile time, so the resolver skips the per-reference root-split plus two map lookups. Rejected for v1 — it optimizes code that does not exist yet, and it interacts with the dotted-path rule (Task 2): if dotted paths infer `unknown`, the stamped shape changes. Revisit after this arc, not during. The per-reference root-split + two map lookups is accepted for v1.*
- [ ] **Step 2: Run the three specs** — FAIL (old behavior still present).
- [ ] **Step 3: Implement** per the interface block above. `buildResolver`'s kind lookup: root segment of `reference.path` / `reference.ref.fieldPath` via `kindContext.kindsByObject.get(objectName)`. No metadata calls anywhere in this file — the maps arrive prebuilt. While in `coercion.ts`, apply Task 1's 80-character truncation to `coerceToNumber`'s message at `:109` (`Field value is not numeric (${JSON.stringify(raw)})`, currently unbounded): it lands in `lastError` on the resolver path exactly as the evaluator's does, and Task 1's `toNumber` bound does not cover it. Pin it with the Task 1 assertion shape (message length < 160).
- [ ] **Step 4: Run the three specs, then the full suite** — PASS. Some evaluator/recompute tests that relied on sniffing will fail — update each to supply kinds; every changed pin is part of the reversal and must be listed in the task report. Do NOT "fix" such a failure by pinning the unthreaded verbatim behavior — a pin that encodes a kindless DATE reference resolving as text is encoding broken semantics that a later task must re-revert.
- [ ] **Step 5: Commit** `feat(formula-field): kind-aware resolver; retire shape-sniffing; kind-directed storage parsing`

---

### Task 5: Hoisted compilation and once-per-pass kind resolution

**Files:**
- Modify: `src/logic-functions/lib/recompute.ts`
- Modify: `src/logic-functions/lib/handle-record-update.ts`
- Test: `src/logic-functions/lib/__tests__/recompute.spec.ts`, `__tests__/handlers.spec.ts`, `__tests__/scan-prefetch.spec.ts`

**Interfaces:**
- Produces:

```ts
export type CompiledFormula = { ast: AstNode; dependencies: FormulaDependencies };
export type RecomputeArgs = {
  /* existing fields */
  compiled?: CompiledFormula;                                  // hoisted compile
  fieldKindsByObject?: Map<string, Map<string, string>>;       // hoisted kinds (Task 4)
};
// New helper, exported for handlers:
export const resolveKindsForFormula = async (
  client: FormulaClient,
  formula: FormulaDefinitionRecord,
  compiled: CompiledFormula,
): Promise<Map<string, Map<string, string>>>;
```

- `computeFormulaValueForRecord`/`planRecomputeForRecord`/`recomputeForRecord` use `args.compiled` when present, else compile (backstop for direct callers). `recomputeAllRecords` compiles ONCE before the page loop and calls `resolveKindsForFormula` ONCE (host object + every `dependencies.crossRecordRefs` object via the existing `resolveFieldKinds` — all cached pulls), threading both into every `planRecomputeForRecord` call. Also thread the hoisted `compiled` into `buildScanSelection` and `expressionUsesTodayOf` (both currently compile independently — `scan-selection.ts:42`, `recompute.ts:83`), bringing the per-pass parse count to exactly 1 for engine-lane formulas.
- `handleRecordUpdate`: the existing per-formula `safeCompile` result is passed as `compiled` (stop the second compile inside `recomputeForRecord`); kinds resolved ONCE PER EVENT (union of host + cross objects across matched formulas), built BEFORE the override-detection loop at :137 (it calls `computeFormulaValueForRecord` at :217 and needs the same map — see Task 4) and threaded to both loops. Acknowledged new rent (spec D5): one cached `fieldKinds` call per event where the prefetched path had none; cold-invocation cost is one metadata pull — measured in the live pass.
- **Hoist placement is pinned by Task 6, not merely by `buildScanSelection`:** both the hoisted `compileFormula` and `resolveKindsForFormula` must be placed **before `recompute.ts:748`** (`emptyValue`), not just before `buildScanSelection` (:766). Task 6's gate sits immediately after 748 and needs `compiled.ast` and `kindsByObject` in scope there. Lines 740-748 are local consts with no awaits, so the hoist has room ahead of 748.
- Mirror-lane note: `isMirrorFormula` (recompute.ts:236-248) short-circuits before compiling for engine-family targets but compiles per record for mirror targets — pass `compiled` there too; the mirror-lane call-count pin is a separate test with its own expected count.
- *Considered, deferred (efficiency review #8): resolving the event-path kinds map lazily — only once a matched formula actually needs it — so an event touching no engine-lane formula pays nothing. Rejected for v1: it optimizes code that does not exist yet, and the eager map is one cached `fieldKinds` call per event. Accepted for v1 as written; revisit with real event-path measurements after this arc.*

- [ ] **Step 1: Write failing call-count pins** (behavioral, not timing):

```ts
// SEAM (verified empirically): vi.spyOn on the src/engine barrel records ZERO calls —
// compileFormula binds parse from src/engine/parser directly. Mock the parser module:
vi.mock('src/engine/parser', async (importActual) => {
  const actual = await importActual<typeof import('src/engine/parser')>();
  return { ...actual, parse: vi.fn(actual.parse) };
});
// Baseline today is 5 parses for a 3-record pass (buildScanSelection + 3 per-record +
// expressionUsesTodayOf). After hoisting + threading, exactly 1.
it('compiles once per pass, not per record', async () => {
  await recomputeAllRecords(client, formula);          // fixture: 3 records
  expect(vi.mocked(parse)).toHaveBeenCalledTimes(1);
});
it('resolves field kinds once per pass', async () => {
  // count client.fieldKinds invocations on the mock client: expect per-object memoized,
  // <= number of distinct objects in the expression, regardless of record count
});
it('planRecomputeForRecord uses the provided compiled program', async () => {
  // pass a sentinel: compiled.ast for expression "1" while formula.expression is "2";
  // the outcome value must be 1 — proof the precompiled AST was used, not a recompile
});
it('keeps two engine-lane formulas isolated when one event matches both', async () => {
  // two definitions on the same object with DIFFERENT expressions and different target fields;
  // run the event path once and assert each definition writes its OWN computed value.
  // A scoping error in the hoist (one `compiled`/`kindsByObject` leaking across the formula loop)
  // writes formula A's result into formula B's records and surfaces NO error at all — this pin
  // is the only thing that catches it.
});
```

(The observable contract is "metadata and parse work do not scale with record count"; if the module mock fights the alias config, fall back to pinning `FakeClient` query/field-kinds call counts only.)
- [ ] **Step 2: Run** — FAIL (parse currently called per record).
- [ ] **Step 3: Implement** per the interface block. Keep the try/catch shape at recompute.ts:298-308 for the compile backstop.
- [ ] **Step 4: Full suite** — PASS.
- [ ] **Step 5: Commit** `perf(formula-field): hoist compilation and kind resolution to once per pass/event`

---

### Task 6: Per-definition static gate in recompute paths + heartbeat double-write fix

**Files:**
- Modify: `src/logic-functions/lib/recompute.ts` (gate in `recomputeAllRecords` before the scan, **and inside `recomputeForRecord` itself** — see the single-record contract below)
- Modify: `src/logic-functions/lib/handle-record-update.ts` (gate in **both** the override-detection loop and the per-formula loop)
- Modify: `src/logic-functions/lib/formula-repository.ts` (`recordEvaluationHeartbeat` syncs the in-memory record after writing)
- Test: `src/logic-functions/lib/__tests__/recompute.spec.ts`, `__tests__/handlers.spec.ts`

**Line numbers below are as of pre-Task-5.** Task 5's hoist inserts statements ahead of them, so anchor every placement on the content markers (`emptyValue`, `loadOverriddenRecordIds`, `buildScanSelection`, the override-detection loop head) rather than on the numbers.

**Interfaces:**
- Consumes: `strictKindGateError` (Task 2), `resolveKindsForFormula` + `CompiledFormula` (Task 5).
- Produces: contract — `recomputeAllRecords` on a gate-failing definition performs ZERO record queries and returns exactly one synthetic outcome `{ formulaId, targetRecordId: '', changed: false, value: emptyValue, error: gateError }`; the heartbeat then records the error write-avoidantly (existing path).
  **The synthetic outcome shape is NEW — there is no `targetRecordId: ''` precedent in the repo, so do not go looking for one.** What the cyclic skip (`formula-sweep.ts:66-75`) supplies is the *posture* precedent — record the problem on the definition row, skip the work — not the code shape: it `continue`s before ever calling `recomputeAllRecords` and writes `lastError` directly. Write-avoidance here comes from `recordEvaluationHeartbeat`'s own comparisons (`formula-repository.ts:369`, `:383`, `:399`), not from the cyclic skip. Verified safe: all four `recomputeAllRecords` callers (`formula-sweep.ts:77`, `handle-formula-change.ts:169`, `handle-record-update.ts:349`, `handle-definition-lifecycle.ts:203`) read only `.length`, `.changed`, and `.error`, so the empty `targetRecordId` is inert. One visible consequence to expect and not mistake for a bug: `formula-sweep`'s `evaluated` counter reads 1 for a gated definition, because the array has one element.
  **Single-record paths must be gated too — put the gate inside `recomputeForRecord` itself.** `recomputeForRecord` has exactly two non-`handleRecordUpdate` callers, and both are otherwise ungated: `src/front-components/formula-editor.tsx:782` (the override toggle-off — "hand the record back to the formula") and `src/front-components/lib/refresh-stale-formulas.ts:135` (`recomputeForRecordFn`, the widget's per-record TODAY refresh). On a legacy definition like `closeDate = "2026-01-15"` each would evaluate a silently-wrong value and WRITE it while the sweep refuses to — the exact B6 outcome this arc exists to kill. Gating inside `recomputeForRecord` (resolving kinds from `args.fieldKindsByObject` when supplied, else one cached `fieldKinds` call) covers all three call sites at one point and adds no per-event rent, because `handleRecordUpdate`'s hoisted gate short-circuits before reaching it. If the gate is instead placed at each call site, both files above must be added to this task's **Files** list explicitly. (`refresh-stale-formulas.ts:142`'s `recomputeAllRecordsFn` call is already covered by the `recomputeAllRecords` gate.)
  **Gate placement in `recomputeAllRecords` is load-bearing:** immediately after `emptyValue` (recompute.ts:748, already in scope for the synthetic outcome) and BEFORE `loadOverriddenRecordIds` (:751) and `buildScanSelection` (:766) — otherwise every gate-failing definition still pays one query + one metadata read per sweep.
  `handleRecordUpdate` computes `gateErrorByFormulaId` once per event (alongside the Task 5 hoisted kinds, before :137) and `continue`s on it in BOTH loops — the override-detection loop (:137-262) and the formula loop (:264). A gated formula must never turn a human edit into an override row: "what would the formula say?" has no answer while broken, exactly the posture the existing `status === 'OFFLINE'` skip at :147 encodes. This also removes the per-event fetch+evaluate cost for gated definitions.
  After each `updateFormulaBookkeeping` call inside `recordEvaluationHeartbeat`, assign **exactly the fields in that call's `update` object** back onto the passed `formula` (four write sites, four one-line spreads: text lane writes lastValueText/lastError/lastEvaluatedAt; number lane lastValue/lastError/lastEvaluatedAt; two TODAY-staleness branches lastEvaluatedAt only). A blanket four-field assignment would desync memory from the row. Result: `formula-sweep.ts:89-94`'s comparison sees fresh state and skips its redundant second write in every lane.

- [ ] **Step 1: Write failing tests:**

```ts
it('gate-failing definition: no record scan, one synthetic error outcome', async () => {
  // formula: expression 'closeDate = "2026-01-15"' (pre-gate legacy shape), NUMBER target,
  // mock client with kinds map exposing closeDate: DATE
  const outcomes = await recomputeAllRecords(client, formula);
  expect(outcomes).toHaveLength(1);
  expect(outcomes[0].error).toMatch(/Cannot compare date with text/);
  // Whole-query assertion, deliberately: loadOverriddenRecordIds queries under the TOP-LEVEL key
  // `formulaOverrides`, not the target object's plural key, so a filter on 'opportunities' alone
  // passes even when the gate lands AFTER loadOverriddenRecordIds — voiding the placement
  // contract this task calls load-bearing.
  expect(client.querySelections).toHaveLength(0);
});
it('event path skips gate-failing formulas in BOTH loops: no recompute write, no override row', async () => {
  // handleRecordUpdate with the same gated formula, simulating a human edit to the target field:
  // expect zero mutations against the target record AND zero formulaOverride creates.
  // NOTE: FakeClient's `mutations` (fake-client.ts:49) is a scalar counter — it cannot be
  // filtered. Assert on `client.mutationSelections` (:56, pushed at :324), filtering by mutation
  // key (`createFormulaOverride`, `updateOpportunity`).
});
it('negative control: a PASSING definition still scans normally after the gate lands', async () => {
  // same fixture, expression corrected to 'closeDate = DATE("2026-01-15")':
  // expect one outcome per seeded record and a non-empty client.querySelections —
  // proof the gate rejects broken definitions, not all definitions.
});
it('heartbeat write syncs the in-memory record (no sweep double-write)', async () => {
  await recordEvaluationHeartbeat(client, formula, { value, error: 'X' }, false);
  expect(formula.lastError).toBe('X');
  // second call with identical outcome performs zero writes:
  const writesBefore = mutationCount(client);
  await recordEvaluationHeartbeat(client, formula, { value, error: 'X' }, false);
  expect(mutationCount(client)).toBe(writesBefore);
});
it('cast runtime failures still error per record with write:null', async () => {
  // 'NUMBER(name) * 2' over a record where name = "ACME": plan.write === null, outcome.error
  // matches /NON_NUMERIC_VALUE/ — statics pass (name is text), runtime content fails
});
```

- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.** In `recomputeAllRecords`, at the placement pinned above: `const gateError = strictKindGateError({ ast: compiled.ast, hostObject: targetObject, targetFieldType: formula.targetFieldType, fieldKinds: (object) => kindsByObject.get(object) }); if (gateError !== null) { const outcome = { formulaId: formula.id, targetRecordId: '', changed: false, value: emptyValue, error: gateError }; await recordEvaluationHeartbeat(client, formula, { value: emptyValue, error: gateError }, false); return [outcome]; }` — the write-avoidance comes from `recordEvaluationHeartbeat`'s own comparisons, NOT from the cyclic skip (which never reaches this function); the cyclic skip is the posture precedent only (contract above). In `recomputeForRecord`, run the same gate on entry — kinds from `args.fieldKindsByObject` when supplied, else one cached `fieldKinds` call — and return the single-record equivalent (`write: null`, `error: gateError`) so the editor and stale-refresh call sites cannot write a silently-wrong value. In `handleRecordUpdate`: build `gateErrorByFormulaId` before the override-detection loop and `continue` on it in both loops (contract above) — that short-circuit runs before `recomputeForRecord` is reached, so the inner gate costs nothing on the event path. Heartbeat sync: per-branch field assignment (contract above).
- [ ] **Step 4: Full suite** — PASS.
- [ ] **Step 5: Commit** `feat(formula-field): per-definition strict gate (no scan for statically-broken defs); heartbeat state sync`

---

### Task 7: Editor surface — autocomplete, wizard copy

**Files:**
- Modify: `src/front-components/lib/formula-field-input.tsx` (`FUNCTION_SUGGESTIONS`, :40-101)
- Test: `src/front-components/lib/__tests__/compute-suggestions.spec.ts`

**Interfaces:**
- Consumes: nothing new. Produces: three autocomplete entries.

- [ ] **Step 1: Failing test:** extend the compute-suggestions spec:

```ts
it.each([['NUM', 'NUMBER'], ['TEX', 'TEXT'], ['DAT', 'DATE']])(
  'suggests %s -> %s', (typed, name) => {
    expect(computeSuggestions(typed, typed.length, []).map((option) => option.name)).toContain(name);
  });
```

- [ ] **Step 2: Run** — FAIL. **Implement:** append to `FUNCTION_SUGGESTIONS`:

```ts
{ name: 'NUMBER', label: 'NUMBER(text) — cast numeric text', type: 'function', insertText: 'NUMBER(' },
{ name: 'TEXT', label: 'TEXT(value) — render as text', type: 'function', insertText: 'TEXT(' },
{ name: 'DATE', label: 'DATE("YYYY-MM-DD") — fixed date', type: 'function', insertText: 'DATE("' },
```

- [ ] **Step 3: Run spec + full suite** — PASS. (Editor error display needs no change: `validateExpression` already returns the new messages.)
- [ ] **Step 4: Commit** `feat(formula-field): autocomplete entries for NUMBER/TEXT/DATE`

---

### Task 8: Blast-radius audit script (read-only)

**Files:**
- Create: `scripts/audit-strict-gate.ts`

**Interfaces:**
- Consumes: `strictKindGateError`, `compileFormula`, `loadAllEnabledFormulas`, `createDynamicCoreClient`. Pattern: `scripts/retro-purge-timeline.ts` (remote config from `~/.twenty/config.json` → env → dynamic import of the client). ZERO mutations.

- [ ] **Step 1: Implement** (no unit test — it's an operational read-only script; its logic is Task 2's, already covered):

```
Usage: npx tsx scripts/audit-strict-gate.ts <remoteName>
```

Per enabled formula: compile (parse failure → report as PARSE), resolve kinds via `client.fieldKinds` per referenced object, run `strictKindGateError`, print a table: `id | name | targetObject.targetField | verdict (PASS | GATED: <error> | PARSE: <error>)` and a summary count. Exit 0 always (it reports; it does not judge).
- [ ] **Step 2: Run against the local dev remote** (`dev`): expect the T2/T5 fixture definitions to appear (several intentionally violate strict rules — e.g. the H2 demo). Paste the table into the task report.
- [ ] **Step 3: Commit** `feat(formula-field): read-only strict-gate audit script for pre-deploy blast radius`

---### Task 9: Reversal sweep — remaining pinned specs, lint, typecheck

**Files:**
- Modify: any spec still pinning B2/B6/truthiness/lazy-coercion behavior (`evaluator.spec.ts` :603/:632/:680, `recompute.spec.ts` :795-843 remnants, `handlers.spec.ts` TEXT-lane describes, `validate-expression.spec.ts`, others the suite surfaces)
- Test: the whole suite.

**Interfaces:** none new. This task exists because Tasks 3-6 each updated the pins they broke; this one proves NOTHING ELSE still encodes the old semantics.

- [ ] **Step 1:** `npx vitest run` — fix every remaining failure by re-pinning to strict semantics. Grep-audit for stale doctrine: `grep -rn "B2\|B6\|date-shaped\|truthiness\|coerces numeric-shaped" src/` — search the whole tree, NOT `src/**/__tests__/`: with globstar off (this sandbox's default) that glob collapses to `src/engine/__tests__/` and silently skips `coercion.spec.ts` and `recompute.spec.ts` — the very file this task names at `:795-843`. Every hit must either be a reversal pin (new semantics, comment referencing this design doc) or be deleted with justification in the task report. Add the design's hot-path assertion as a static check: `grep -rn "validateExpressionCore\|validateFormula" src/logic-functions/lib/recompute.ts src/logic-functions/lib/handle-record-update.ts src/logic-functions/formula-sweep.ts` must return nothing — recompute paths gate via `strictKindGateError` only, never full validation.
- [ ] **Step 2:** `npx vitest run` green; `npx tsc --noEmit` (or the package's typecheck target) clean; `npx oxlint` (repo lint config) clean.
- [ ] **Step 3: Commit** `test(formula-field): re-pin suite to strict kind semantics (B2/B6 reversal complete)`

---

### Task 10: ADR 0027, ADR 0026 amendment, README, version 0.3.0

**Files:**
- Create: `docs/adr/0027-strict-kind-typing.md`
- Modify: `docs/adr/0026-string-values-and-concatenation.md` (status header: B2/B6 superseded by 0027)
- Modify: `docs/adr/README.md` (index line), `README.md` (language reference: casts, date arithmetic, strict rules), `package.json` (`"version": "0.3.0"`)
- Create: `docs/plans/2026-08-05-strict-typing-execution-ledger.md` (backfill: one line per completed task with commit hashes)

**Interfaces:** none. Content source: the design doc's D1-D6 + S1-S9 + decision log, restated in ADR form (context/decision/consequences/not-done), with the efficiency review's F1-scope-guard/F3 outcomes recorded as first-class decisions (label them explicitly — the unrelated **F1-empty-string** bug from `verification-reports/T6-verdict.md` is a different item and a later arc). The Not-done section MUST carry forward: `DATE(textExpr)` cast, TEXT() format args, **datetime↔date bridging** (S8 rejects `syncedAt > TODAY()` and this arc ships no sanctioned rewrite for it, unlike S1/S3/S5), migration tooling, SELECT output (next arc), formulahelp refresh (gated on deploy).
Also record as a first-class consequence: the editor keeps only its host-object kinds map while the server preloads every cross-ref object, so **cross-record kind mismatches are an editor-accepts / server-rejects class** — the pre-existing divergence posture, now reachable by a new rule (D5 types cross-record operands for the first time).

- [ ] **Step 1:** Write ADR 0027 (~150 lines, follow 0026's structure), amend 0026's header (do not rewrite its body — history stands), update README language table, bump version, backfill the ledger.
- [ ] **Step 2:** Full suite + lint one final time.
- [ ] **Step 3: Commit** `docs(formula-field): ADR 0027 strict kind typing; v0.3.0`

---

## Post-plan gates (NOT tasks — user-approval checkpoints)

1. Live verification mini-pass (design doc Testing section): mirror verbatim over date-shaped content, DATE-target convergence, gate surfacing on a legacy-shaped def, save gate in the wizard. Uses the running dev stack; dispatch per the live-verification handoff's model roster.
2. Cloud deploy of v0.3.0 (needs SDK version match + explicit user approval). Run `scripts/audit-strict-gate.ts` against the CLOUD remote first and show the user the gated-definition list.
3. formulahelp reference refresh (separate approval, at/after deploy).
