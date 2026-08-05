# Strict Kind Typing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the strict kind typing design (`docs/plans/2026-08-05-strict-typing-design.md`): a five-kind static type system enforced at save, kind-aware runtime resolution with zero shape-sniffing, NUMBER/TEXT/DATE functions, a per-definition static gate for legacy definitions, and hoisted per-pass compilation. v0.3.0, supersedes ADR 0026 B2/B6.

**Architecture:** A new app-layer module `kind-inference.ts` walks the engine AST assigning each node one of six kinds (number/date/datetime/text/boolean/unknown) from field metadata + literal types, rejecting mismatches and stamping `renderAs` annotations on TEXT-cast nodes. `validateExpressionCore` runs it at save; `recomputeAllRecords`/`handleRecordUpdate` run it as a per-definition static gate (cyclic-skip precedent) and thread a once-per-pass kinds map into a kind-aware `buildResolver`. The engine stays kind-agnostic except for reading `renderAs`.

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
- Modify: `src/engine/parser.ts` (reserved words + parse methods in `parsePrimary`'s FIELD case, alongside `if`/`today`/`sum` at :235-309)
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

- `DATE("YYYY-MM-DD")` constant-folds at parse: the parser calls `parseDateOnlyToEpochDays` on the literal; an invalid calendar date or a non-string-literal argument throws `PARSE_ERROR` (message: `DATE() requires a literal "YYYY-MM-DD" date`). The folded node keeps `literal` for error copy. IFS/SWITCH `foldLadder` precedent (parser.ts:549-568).
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
- [ ] **Step 3: Implement.** `ast.ts`: add the three types + `RenderKind`, extend the `AstNode` union. `parser.ts`: in `parsePrimary`'s FIELD case add three lower-cased reserved-word checks (`'number'`, `'text'`, `'date'`) with LPAREN lookahead dispatching to `parseNumberCast()`, `parseTextCast()`, `parseDateLiteral()`, each mirroring `parseIfBlank`'s structure (`this.enter()`/`this.leave()`, single argument via `this.parseConcat()`, RPAREN check). `parseDateLiteral` requires the next token to be a STRING literal token (not an expression); on anything else or on `parseDateOnlyToEpochDays` throwing, throw `new FormulaError('PARSE_ERROR', 'DATE() requires a literal "YYYY-MM-DD" date', position)`. Import `parseDateOnlyToEpochDays` — check import direction: `date-serial.ts` lives under `src/logic-functions/lib/`; the engine must not import app-layer code. **Move nothing**: instead duplicate the tiny pure parse in the parser? No — `date-serial.ts` is itself pure and dependency-free; MOVE `date-serial.ts` to `src/engine/date-serial.ts` and update its ~6 importers (it has no app-domain imports; `text-format.ts` precedent already lives in engine and is imported by both layers). Do the move in this task, mechanically, before wiring.
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
export type ExpressionKind = 'number' | 'date' | 'datetime' | 'text' | 'boolean' | 'unknown';
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
  outputFormat: string | null | undefined;
  fieldKinds?: KindLookup;
}): string | null;
```

- `fieldTypeToKind`: `NUMBER`,`CURRENCY`,`RATING` → `number`; `DATE` → `date`; `DATE_TIME` → `datetime`; `TEXT`,`SELECT` → `text`; `BOOLEAN` → `boolean`; else `unknown`.
- Node kinds: `number`→number; `string`→text; `null`→unknown; `dateliteral`→date; `today`→date; `field`/`crossref`→`fieldTypeToKind` of the ROOT segment's field type (dotted CURRENCY subpaths stay `number`; kind of missing map/field → `unknown`); comparisons/`and`/`or`/`not`/`isblank`→boolean; `concat`→text; `numbercast`→number; `textcast`→text; `sum`→number; `unary`→number; `if`/`ifblank`→unified branch kind.
- Rules (mismatch when BOTH sides known; `unknown` always passes):
  - `=`/`!=`: kinds equal. Message: `Cannot compare ${left} with ${right} using "${op}" (kinds must match)`.
  - `<`,`<=`,`>`,`>=`: kinds equal AND in {number,date,datetime}. Text/boolean ordering message: `Cannot order ${kind} values with "${op}"`.
  - binary `+`: number+number→number; date+number|number+date→date; datetime+number|number+datetime→datetime; else mismatch.
  - binary `-`: number−number→number; date−number→date; datetime−number→datetime; date−date→number; datetime−datetime→number; else mismatch. Message for both: `Cannot apply "${op}" to ${left} and ${right}`.
  - `*`,`/`,`%`, unary, SUM args: number. `concat` parts: text (message: `"&" joins text; wrap ${kind} values in TEXT()`).
  - IF/IFS condition: boolean (message: `Condition must be a comparison or boolean field, got ${kind}`). Branch kinds must unify (unknown unifies with anything; two different known kinds → `IF branches disagree: ${a} vs ${b}`). IFBLANK same unification.
  - `numbercast` operand: text (message: `NUMBER() takes text, got ${kind}`). `textcast` operand: any; stamp `renderAs` = operand kind mapped {number→'number', date→'date', datetime→'datetime', boolean→'boolean', text|unknown→'value'}.
- `strictKindGateError`: returns null immediately for mirror-lane definitions (`!ENGINE_FAMILY_KINDS.has(targetFieldType)` or `targetFieldType` empty — branch 1c owns those). Else run inference; inference error → return it. Else output gate: expected kind from `targetFieldKind(targetFieldType)` mapped {NUMBER|CURRENCY→number, DATE→date, DATE_TIME→datetime, TEXT→text}; inferred ≠ expected and both known → `` `Formula computes ${inferred} but the target field holds ${expected}` `` (suggest `TEXT(...)` when expected is text).

- [ ] **Step 1: Write failing tests** — table-driven, no client, kinds map inline:

```ts
const kinds = new Map<string, string>([
  ['amount', 'NUMBER'], ['price', 'CURRENCY'], ['closeDate', 'DATE'],
  ['syncedAt', 'DATE_TIME'], ['name', 'TEXT'], ['stage', 'SELECT'], ['isActive', 'BOOLEAN'],
]);
const lookup: KindLookup = (object) => (object === 'company' ? kinds : undefined);
const kindOf = (expression: string): KindInferenceResult =>
  inferExpressionKind(parse(expression), 'company', lookup);

describe('inferExpressionKind', () => {
  it.each([
    ['amount + 1', 'number'], ['closeDate + 30', 'date'], ['30 + closeDate', 'date'],
    ['closeDate - closeDate', 'number'], ['TODAY() - closeDate', 'number'],
    ['syncedAt - syncedAt', 'number'], ['DATE("2026-01-15")', 'date'],
    ['NUMBER(name) * 2', 'number'], ['TEXT(amount) & " units"', 'text'],
    ['IF(isActive, 1, 2)', 'number'], ['IF(amount > 3, name, stage)', 'text'],
    ['IFBLANK(name, "none")', 'text'], ['ISBLANK(closeDate)', 'boolean'],
  ])('%s infers %s', (expression, expected) => {
    expect(kindOf(expression)).toEqual({ kind: expected, error: null });
  });
  it.each([
    ['closeDate = "2026-01-15"', /Cannot compare date with text/],
    ['closeDate = syncedAt', /Cannot compare date with datetime/],
    ['amount = name', /Cannot compare number with text/],
    ['closeDate * 2', /Cannot apply "\*"/],
    ['name + 1', /Cannot apply "\+"/],
    ['amount & "x"', /wrap number values in TEXT\(\)/],
    ['IF(amount, 1, 2)', /Condition must be a comparison or boolean field/],
    ['IF("a", 1, 2)', /Condition must be a comparison or boolean field/],
    ['IF(isActive, 1, "a")', /IF branches disagree: number vs text/],
    ['name < "b"', /Cannot order text values/],
    ['NUMBER(amount)', /NUMBER\(\) takes text, got number/],
  ])('%s is rejected: %s', (expression, message) => {
    const result = kindOf(expression);
    expect(result.kind).toBeNull();
    expect(result.error).toMatch(message);
  });
  it('treats unknown kinds as unconstrained (skip, never reject)', () => {
    const noKinds: KindLookup = () => undefined;
    expect(inferExpressionKind(parse('mystery = "x"'), 'company', noKinds).error).toBeNull();
    expect(inferExpressionKind(parse('mystery + 1'), 'company', noKinds)).toEqual(
      { kind: 'unknown', error: null },
    );
  });
  it('SELECT compares as text', () => {
    expect(kindOf('stage = "Won"')).toEqual({ kind: 'boolean', error: null });
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
      targetFieldType, outputFormat: null, fieldKinds: lookup });
  it('output gate: kind must match the target', () => {
    expect(gate('amount * 2', 'NUMBER')).toBeNull();
    expect(gate('closeDate + 30', 'DATE')).toBeNull();
    expect(gate('name & "!"', 'TEXT')).toBeNull();
    expect(gate('amount * 2', 'TEXT')).toMatch(/computes number but the target field holds text/);
    expect(gate('name', 'NUMBER')).toMatch(/computes text but the target field holds number/);
  });
  it('mirror-lane and unknown-kind definitions are never gated', () => {
    expect(gate('isActive', 'BOOLEAN')).toBeNull();          // mirror lane, 1c owns it
    expect(strictKindGateError({ ast: parse('mystery'), hostObject: 'company',
      targetFieldType: 'NUMBER', outputFormat: null, fieldKinds: () => undefined })).toBeNull();
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
- Modify: `src/engine/dependencies.ts` + `src/engine/index.ts` (delete `collectStringComparisonRefs` + its export + `StringComparisonRefs`)
- Modify: `src/logic-functions/lib/handle-formula-change.ts` (preload kinds for ALL cross-ref objects, :103-110)
- Test: `src/logic-functions/lib/__tests__/validation-core.spec.ts`, `src/logic-functions/lib/__tests__/handlers.spec.ts`, `src/engine/__tests__/dependencies.spec.ts`

**Interfaces:**
- Consumes: `strictKindGateError` (Task 2).
- Produces: `validateExpressionCore` rejects kind mismatches with the Task 2 messages. Behavior contract: mirror-lane validation (branch 1c) unchanged; H3's bare-BOOLEAN-onto-TEXT rejection now comes from the output gate (boolean ≠ text) — same protection, new message.

- [ ] **Step 1: Write failing tests** (extend `validation-core.spec.ts`; reuse its existing fixture style):

```ts
it('rejects a date field compared to a bare text literal at save', () => {
  const result = validate('closeDate = "2026-01-15"', 'NUMBER');
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
it('skips kind checks when no kinds map is supplied (unknown-kind policy)', () => {
  expect(validateWithoutKinds('mystery = "x"', 'NUMBER').valid).toBe(true);
});
```

Update the existing 1b-pinned tests (string-comparison rejection messages) to the new kind-mismatch copy; the PROTECTION must survive, only the message changes.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.** In `validateExpressionCore` after the parse step: engine-lane only (same condition branch 1c uses, inverted), call `strictKindGateError({ ast, hostObject, targetFieldType, outputFormat: undefined, fieldKinds })`; non-null → `{ valid: false, error, dependencies }`. Delete branches 1b and 1d and `collectStringComparisonRefs` (function, export, its dependencies.spec tests). `outputFormat` is not currently a validation input — pass `undefined`; gate logic must not need it (mirror detection uses targetFieldType alone, matching 1c's condition).
  In `handle-formula-change.ts`, replace the bare-ref-only cross preload (:103-110) with:

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
  - `value-io.spec.ts` additions:

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
```

  (Write the fixture concretely in the style of recompute.spec's existing mock client at :22-45 — stored target `"2026-01-15"`, formula `targetFieldType: 'DATE'`, expression referencing a same-record DATE source with the same serial, `fieldKindsByObject` supplied.)
- [ ] **Step 2: Run the three specs** — FAIL (old behavior still present).
- [ ] **Step 3: Implement** per the interface block above. `buildResolver`'s kind lookup: root segment of `reference.path` / `reference.ref.fieldPath` via `kindContext.kindsByObject.get(objectName)`. No metadata calls anywhere in this file — the maps arrive prebuilt.
- [ ] **Step 4: Run the three specs, then the full suite** — PASS. Some evaluator/recompute tests that relied on sniffing will fail — update each to supply kinds or to pin the new verbatim behavior; every changed pin is part of the reversal and must be listed in the task report.
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

- `computeFormulaValueForRecord`/`planRecomputeForRecord`/`recomputeForRecord` use `args.compiled` when present, else compile (backstop for direct callers). `recomputeAllRecords` compiles ONCE before the page loop and calls `resolveKindsForFormula` ONCE (host object + every `dependencies.crossRecordRefs` object via the existing `resolveFieldKinds` — all cached pulls), threading both into every `planRecomputeForRecord` call.
- `handleRecordUpdate`: the existing per-formula `safeCompile` result is passed as `compiled` (stop the second compile inside `recomputeForRecord`); kinds resolved ONCE PER EVENT (union of host + cross objects across matched formulas), threaded to all. Acknowledged new rent (spec D5): one cached `fieldKinds` call per event where the prefetched path had none; cold-invocation cost is one metadata pull — measured in the live pass.

- [ ] **Step 1: Write failing call-count pins** (behavioral, not timing):

```ts
it('compiles once per pass, not per record', async () => {
  const parseSpy = vi.spyOn(engineModule, 'parse');   // via vi.mock of src/engine with importActual
  await recomputeAllRecords(client, formula);          // fixture: 3 records
  expect(parseSpy).toHaveBeenCalledTimes(1);
});
it('resolves field kinds once per pass', async () => {
  // count client.fieldKinds invocations on the mock client: expect per-object memoized,
  // <= number of distinct objects in the expression, regardless of record count
});
it('planRecomputeForRecord uses the provided compiled program', async () => {
  // pass a sentinel: compiled.ast for expression "1" while formula.expression is "2";
  // the outcome value must be 1 — proof the precompiled AST was used, not a recompile
});
```

(If `vi.spyOn` on the engine barrel fights the bundler, count via a wrapper: export a `compileFormulaCached` seam in recompute.ts and pin on the mock client's query/field-kinds call counts instead — the observable contract is "metadata and parse work do not scale with record count".)
- [ ] **Step 2: Run** — FAIL (parse currently called per record).
- [ ] **Step 3: Implement** per the interface block. Keep the try/catch shape at recompute.ts:298-308 for the compile backstop.
- [ ] **Step 4: Full suite** — PASS.
- [ ] **Step 5: Commit** `perf(formula-field): hoist compilation and kind resolution to once per pass/event`

---

### Task 6: Per-definition static gate in recompute paths + heartbeat double-write fix

**Files:**
- Modify: `src/logic-functions/lib/recompute.ts` (gate in `recomputeAllRecords` before the scan)
- Modify: `src/logic-functions/lib/handle-record-update.ts` (gate in the per-formula loop)
- Modify: `src/logic-functions/lib/formula-repository.ts` (`recordEvaluationHeartbeat` syncs the in-memory record after writing)
- Test: `src/logic-functions/lib/__tests__/recompute.spec.ts`, `__tests__/handlers.spec.ts`

**Interfaces:**
- Consumes: `strictKindGateError` (Task 2), `resolveKindsForFormula` + `CompiledFormula` (Task 5).
- Produces: contract — `recomputeAllRecords` on a gate-failing definition performs ZERO record queries and returns exactly one synthetic outcome `{ formulaId, targetRecordId: '', changed: false, value: emptyValue, error: gateError }`; the heartbeat then records the error write-avoidantly (existing path). `handleRecordUpdate` `continue`s past gate-failing formulas (no write — the sweep surfaces the error within the hour). After `recordEvaluationHeartbeat` writes, it assigns the written `lastError`/`lastValue`/`lastValueText`/`lastEvaluatedAt` back onto the passed `formula` object so `formula-sweep.ts:89-94`'s comparison sees fresh state and skips its redundant second write.

- [ ] **Step 1: Write failing tests:**

```ts
it('gate-failing definition: no record scan, one synthetic error outcome', async () => {
  // formula: expression 'closeDate = "2026-01-15"' (pre-gate legacy shape), NUMBER target,
  // mock client with kinds map exposing closeDate: DATE
  const outcomes = await recomputeAllRecords(client, formula);
  expect(outcomes).toHaveLength(1);
  expect(outcomes[0].error).toMatch(/Cannot compare date with text/);
  expect(recordPageQueries(client)).toBe(0);   // fixture counts target-object queries
});
it('event path skips gate-failing formulas without writing', async () => {
  // handleRecordUpdate with the same formula: no mutation calls for the target record
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
- [ ] **Step 3: Implement.** In `recomputeAllRecords`, after the Task 5 hoisted compile + kinds: `const gateError = strictKindGateError({ ast: compiled.ast, hostObject: targetObject, targetFieldType: formula.targetFieldType, outputFormat: formula.outputFormat, fieldKinds: (object) => kindsByObject.get(object) }); if (gateError !== null) { const outcome = { formulaId: formula.id, targetRecordId: '', changed: false, value: emptyValue, error: gateError }; await recordEvaluationHeartbeat(client, formula, { value: emptyValue, error: gateError }, false); return [outcome]; }` — mirroring the cyclic-skip's write-avoidance via the heartbeat's existing comparison. Same check in `handleRecordUpdate`'s loop right after `safeCompile` → `continue` on failure. Heartbeat sync: after each `updateFormulaBookkeeping` call inside `recordEvaluationHeartbeat`, assign the written fields onto `formula`.
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

- [ ] **Step 1:** `npx vitest run` — fix every remaining failure by re-pinning to strict semantics. Grep-audit for stale doctrine: `grep -rn "B2\|B6\|date-shaped\|truthiness\|coerces numeric-shaped" src/**/__tests__/` — every hit must either be a reversal pin (new semantics, comment referencing this design doc) or be deleted with justification in the task report.
- [ ] **Step 2:** `npx vitest run` green; `npx tsc --noEmit` (or the package's typecheck target) clean; `npx oxlint` (repo lint config) clean.
- [ ] **Step 3: Commit** `test(formula-field): re-pin suite to strict kind semantics (B2/B6 reversal complete)`

---

### Task 10: ADR 0027, ADR 0026 amendment, README, version 0.3.0

**Files:**
- Create: `docs/adr/0027-strict-kind-typing.md`
- Modify: `docs/adr/0026-string-values-and-concatenation.md` (status header: B2/B6 superseded by 0027)
- Modify: `docs/adr/README.md` (index line), `README.md` (language reference: casts, date arithmetic, strict rules), `package.json` (`"version": "0.3.0"`)
- Create: `docs/plans/2026-08-05-strict-typing-execution-ledger.md` (backfill: one line per completed task with commit hashes)

**Interfaces:** none. Content source: the design doc's D1-D6 + S1-S9 + decision log, restated in ADR form (context/decision/consequences/not-done), with the efficiency review's F1/F3 outcomes recorded as first-class decisions. The Not-done section MUST carry forward: `DATE(textExpr)` cast, TEXT() format args, migration tooling, SELECT output (next arc), formulahelp refresh (gated on deploy).

- [ ] **Step 1:** Write ADR 0027 (~150 lines, follow 0026's structure), amend 0026's header (do not rewrite its body — history stands), update README language table, bump version, backfill the ledger.
- [ ] **Step 2:** Full suite + lint one final time.
- [ ] **Step 3: Commit** `docs(formula-field): ADR 0027 strict kind typing; v0.3.0`

---

## Post-plan gates (NOT tasks — user-approval checkpoints)

1. Live verification mini-pass (design doc Testing section): mirror verbatim over date-shaped content, DATE-target convergence, gate surfacing on a legacy-shaped def, save gate in the wizard. Uses the running dev stack; dispatch per the live-verification handoff's model roster.
2. Cloud deploy of v0.3.0 (needs SDK version match + explicit user approval). Run `scripts/audit-strict-gate.ts` against the CLOUD remote first and show the user the gated-definition list.
3. formulahelp reference refresh (separate approval, at/after deploy).
