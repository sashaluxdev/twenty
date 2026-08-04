# String Output and & Concatenation Implementation Plan

> **For agentic workers:** Hybrid execution — see `## Execution model`. Parallel phases (A and H) run as Workflow fan-outs; the linear chain (Tasks 4–9) uses superpowers:subagent-driven-development task-by-task. The orchestrating session does orchestration and reasoning only: briefs, dispatch, report reading, adjudication. Every code edit, test run, grep, and doc authoring is dispatched to an agent. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Formulas can produce text — `aString & "INV" & 1+TODAY()` writes `"ACME-INV20665"` into a runtime-created TEXT field via a new "Text" output format — implementing the approved design in `docs/plans/2026-07-28-string-output-design.md` (D1–D5 locked).

**Architecture:** The engine's value domain widens from `number | null` to `number | string | null` with a single typed resolver replacing the numeric/raw resolver pair; a new loosest-precedence `&` tier concatenates with per-operand text coercion. The write path dispatches on target field kind: NUMBER/CURRENCY/DATE/DATE_TIME/TEXT are engine-expressible (TEXT joins `ENGINE_FAMILY` and leaves `MIRRORABLE_KINDS`), everything else stays raw passthrough. Existing `overrideValueText`/`lastValueText` columns carry the text lane — no new columns, no migration. The duplicated save-validation dispatch collapses into one shared module consumed by backend and frontend.

**Tech Stack:** TypeScript (strict, no `any`), twenty-sdk 2.19.0 / twenty-client-sdk 2.18.0 (pinned — do not bump), Vitest (NOT Jest), oxlint, esbuild-bundled front components.

## Global Constraints

- Package root for every command and path in this plan: `/home/sasha_shin/twenty/packages/twenty-apps/community/formula-field`. All `src/...` paths below are relative to it.
- Test runner is **Vitest**. The repo's `.bin` symlink can be broken in this environment; use the vendored entrypoint: `node /home/sasha_shin/twenty/node_modules/vitest/vitest.mjs run <path>` (or `npx vitest run <path>` if it resolves). `--reporter=basic` is invalid in vitest v4 — use the default reporter.
- `.tsx` files are NOT collected by vitest (`include: ['src/**/*.spec.ts']`). Testable logic must live in `.ts` modules (house pattern: extract pure logic to `lib/` and test that).
- Type check: `npx tsc --build` once (required: `tsconfig.json` references the composite `tsconfig.spec.json`, and without its outputs `tsc --noEmit` reports 96 spurious TS6305), then `npx tsc --noEmit` — that is the check that must stay clean. `tsc --build` itself reports 32 pre-existing spec-project-only errors; those are baseline, documented in the execution ledger, and must not be "fixed" as part of any task. Lint: `/home/sasha_shin/twenty/node_modules/.bin/oxlint -c .oxlintrc.json .` (or `npm run lint`).
- Baseline at branch start: whole unit suite **962 passed**, engine subset **301 passed**. Both must be green before Task 1. Verified green on `feat/formula-field-string-output` at setup (2026-08-03).
- Comments: short-form `//` only, WHY not WHAT, no JSDoc blocks. No `any`. Named exports only. No abbreviations in identifiers.
- Front-component bundle weight is load-bearing (ADR 0024): the shared validation module must not add any new dependency to the front bundle. `.oxlintrc.json` bans `twenty-shared*` imports under `src/logic-functions/`.
- Dependency direction: `src/logic-functions/**` must never import from `src/front-components/**` (stated in `save-validation.ts:64-66`). The frontend already imports from `src/logic-functions/lib/` (`mirror-kinds`, `value-io`, `override-repository`) — that direction is fine.
- Never modify `src/objects/*.object.ts` field UIDs. This plan requires **zero** schema changes.
- Do **not** deploy to cloud or bump SDK dependency versions as part of this plan. The `package.json` version bump to `0.2.0` happens in Task 9 only; actual deployment needs separate user approval.
- Work on a feature branch off `main`. Commit after every task with `feat(formula-field): ...` / `refactor(formula-field): ...` / `docs(formula-field): ...` messages. No signatures, no co-author tags.

## Background: what the evidence pass actually found

Three claims in the design doc that the code reading corrected:

1. **"Seven mirror-vs-engine forks" — there are eleven** (F1–F11): compute lane split (`recompute.ts:276` vs `:392`), write-plan dispatch (`recompute.ts:564-604`), normalization (`:600-603` vs `:622-647`), convergence compare (`deepJsonEqual` at `:593` vs `valuesEqual` at `:633`), outcome shape (`types.ts:61-77` `value` vs `rawValue`), heartbeat column (`formula-repository.ts:342-380`), override detection (`handle-record-update.ts:118-204`), override storage slot (`override-repository.ts:171-227`), scan-page selection (`scan-selection.ts:47-85`), prefetch trust (`handle-record-update.ts:248-259`), and save-validation branch 1c (`save-validation.ts:188-225`, duplicated at `validate-expression.ts:70-95`). The raw lane survives for non-expressible kinds, so the forks become expressible-vs-raw dispatches rather than vanishing.
2. **The editor already renders TEXT correctly** — `displayValue` (`formula-editor.tsx:134-158`) routes TEXT through `isMirrorTargetKind` to the verbatim branch. The `as number` cast at `:145` only bites once TEXT leaves `MIRRORABLE_KINDS` (Task 7), so the display fix (Task 8) must land in the same arc. A second, separate gap: `formula-definition-editor.tsx:600-602` renders `lastValue` only and never reads `lastValueText`, so text heartbeats show `—`.
3. **The wizard's mirror path already emits the one-term formula** — `seedMirrorExpression` (`formula-field-formats.ts:304-307`) produces bare `thatField` / `[obj:id:field]`. The only wizard change for TEXT mirrors is routing `outputFormat` to `'text'` instead of `'mirror'` (backend never reads `'mirror'`; only `isIntegerBackedFormat` reads `outputFormat`).

Confirmed as designed: `overrideValueText` (`formula-override.object.ts:21`) and `lastValueText` (`formula-definition.object.ts:27`) exist and are written today by the mirror lane — no new columns. There are **no exhaustive switches over `FormulaErrorCode`** anywhere, so adding `TEXT_TOO_LONG` is additive-safe.

### Design decision made during planning: semi-eager string coercion

`coerceToNumber` (`src/logic-functions/lib/coercion.ts:48-111`) currently coerces **all** strings at resolve time: date-shaped → epoch-day serial, numeric-shaped → `Number()`, else throw `NON_NUMERIC_VALUE`, and empty/whitespace strings throw. Keeping that fully eager would destroy the feature (`zipField & "-x"` with zip `"01234"` would render `"1234-x"`) and mangle TEXT one-term formulas (`"042"` → `"42"`). Going fully lazy (strings always verbatim) would break deployed date comparisons (`closeDate = TODAY()` would become cross-type false).

**Resolution (the plan's core semantic rule):** the new resolver `coerceToEngineValue` keeps **date-pattern coercion eager** (date-shaped strings still become serials everywhere, exactly as today) and makes **numeric-string coercion lazy** (numeric-shaped and all other non-empty strings resolve verbatim as text; numeric contexts coerce at point of use via `Number()`). Empty/whitespace strings resolve as text (blank-aware), no longer throwing at resolve.

Resulting behavior deltas — all locked by the design or accepted and documented in ADR 0026:

- **B1 (design-locked):** `=`/`!=` are typed and non-coercing: `42 = "42"` is false, `"42" != 42` is true. A null operand still null-propagates.
- **B2 (accepted edge):** a TEXT field whose content is exactly date-shaped (`YYYY-MM-DD` or ISO datetime) coerces to its serial in every context, including `&` and TEXT one-term formulas. Existing precedent: such content already evaluates as a serial in arithmetic today.
- **B3 (accepted, narrow):** a field whose raw value arrives as a numeric-shaped *string* (e.g. NUMERIC serialization) no longer numerically equals a number literal in `=`/`!=`. Arithmetic, ordering, SUM, and truthiness are observably unchanged (point-of-use coercion). Write-boundary coercion (`"42"` into a NUMBER target) still succeeds.
- **B4 (improvement):** `textFieldA = textFieldB` (no literal involved) now compares text-to-text instead of erroring; a string-vs-number comparison yields false rather than null-propagating via the old raw-resolver channel.
- **B5 (design-locked):** deployed TEXT *mirrors* keep verbatim behavior for everything except B2 content, because numeric-shaped strings stay lazy. `"042"` mirrors as `"042"`.

### Override and heartbeat text conventions (back-compat)

Deployed TEXT-mirror overrides store `overrideValueText = JSON.stringify(raw)` and decode via `decodeMirrorOverrideValue` (`override-repository.ts:232-243`); mirror heartbeats store `lastValueText = mirrorValueText(raw)` (JSON-stringified, 500-cap, `formula-repository.ts:281-296`). The text lane **keeps both JSON conventions unchanged** so deployed TEXT mirrors migrate lanes with zero data rewrite. Slot choice becomes target-kind-driven (TEXT/raw kinds → text slot) instead of expression-re-parse-driven.

## Explicitly out of scope

- Cloud deployment, formulahelp skill `reference.md` refresh (post-deploy step), upstream issue filing.
- SELECT output (explicitly the next version — see the final section of this plan).
- A `TEXT()` formatting function; date formatting in `&` (dates concat as serials, B2).
- Kind-aware field resolution (the escape hatch if B2/B3 edge reports arrive — noted in ADR 0026, not built).
- The pre-existing comparator inconsistency between `valuesEqual` (strict `===`) and `numbersEqual` (1e-9 tolerance in `handle-record-update.ts:48-51`) — pre-existing, unchanged by this plan.
- `variation-sync.ts` `overrideSlotFor` (`:166-174`) — a deliberately different slot convention; do not touch.

## File structure

**Created:**
- `src/engine/text-format.ts` — canonical number→text rendering + computed-text cap (pure, shared by engine and write boundary).
- `src/engine/__tests__/text-format.spec.ts`
- `src/logic-functions/lib/validation-core.ts` — the single shared expression-validation dispatch (backend + frontend consume it).
- `src/logic-functions/lib/__tests__/validation-core.spec.ts`
- `src/front-components/lib/display-value.ts` — `displayValue` extracted from `formula-editor.tsx` so it becomes testable.
- `src/front-components/lib/__tests__/display-value.spec.ts`
- `docs/adr/0026-string-values-and-concatenation.md`

**Modified (by task):**
- T1: `src/engine/errors.ts`
- T2: `src/logic-functions/lib/save-validation.ts`, `src/front-components/lib/validate-expression.ts`, both their specs
- T3: `src/engine/tokenizer.ts`, `src/engine/ast.ts`, `src/engine/parser.ts`, `src/engine/dependencies.ts`, `src/engine/__tests__/tokenizer.spec.ts`, `parser.spec.ts`, `dependencies.spec.ts`, `fuzz.spec.ts`
- T4: `src/engine/evaluator.ts`, `src/logic-functions/lib/coercion.ts`, `src/logic-functions/lib/recompute.ts` (resolver wiring only), `src/engine/__tests__/evaluator.spec.ts`, `src/logic-functions/lib/__tests__/coercion.spec.ts`
- T5: `src/engine/evaluator.ts`, `src/engine/ast.ts` (comment), `evaluator.spec.ts`
- T6: `src/logic-functions/lib/value-io.ts`, `types.ts`, `recompute.ts`, `formula-repository.ts`, `override-repository.ts` (comment only), `handle-record-update.ts`, their specs
- T7: `src/logic-functions/lib/mirror-kinds.ts`, `recompute.ts`, `handle-record-update.ts`, `scan-selection.ts`, `formula-repository.ts`, mirror/regression specs
- T8: `src/front-components/lib/formula-field-formats.ts`, `formula-setup-wizard.tsx`, `format-options-fields.tsx`, `field-settings-editor.tsx`, `formula-editor.tsx`, `formula-definition-editor.tsx`, `formula-field-formats.spec.ts`
- T9: `docs/adr/README.md`, `docs/plans/2026-07-28-string-output-design.md` (status line), `package.json`

## Execution model

**Orchestrator contract:** the orchestrating session handles orchestration and reasoning only — writing dispatch briefs, launching agents/workflows, reading reports, adjudicating review conflicts, deciding sequencing, and maintaining the execution ledger (see `## Progress state and cross-session resume`). It performs no mechanical work: no code edits, no test runs, no greps, no doc authoring. Anything mechanical — including the Task 9 verification commands — is dispatched. At most one targeted Read to sanity-check a disputed agent claim. Ledger and plan-file bookkeeping edits are orchestration, not mechanical work.

**Concurrency caps:** up to 10 sonnet agents concurrently, up to 5 opus agents concurrently — used only where parallelism is real. This plan has exactly two genuinely parallel phases (A and H); everything between is a strict dependency chain and runs one agent at a time. Do not widen fan-out to fill the caps. No `fable` subagents anywhere.

| Phase | Tasks | Mode | Agents (peak concurrency) | Why this mode |
|---|---|---|---|---|
| A | 1, 2, 3 | **Workflow**: `pipeline([T1,T2,T3], implement, review)`, each implementer in `isolation: 'worktree'` | Implementers: T1 sonnet, T2 opus, T3 opus; reviewers: T1 sonnet, T2/T3 opus (peak 3 agents, ≤2 opus + ≤1 sonnet at once via pipeline overlap) | The only independent implementation tasks in the plan; pipeline lets each task's review start as soon as its implementation lands |
| A-int | merge A | Individual agent (sonnet) | 1 | Merge the three worktree branches onto the feature branch in task order (1, 2, 3), resolve trivial overlaps, run the whole suite + lint + typecheck, commit state check |
| B–E | 4 → 5 → 6 → 7 | Individual agents, superpowers:subagent-driven-development (implementer + two-stage review per task) | 1 opus implementer, then 1 opus reviewer, sequential | Each task consumes the previous task's exported contract; no parallelism exists |
| F | 8 | Individual agent, same framework | 1 sonnet implementer + 1 sonnet reviewer | Linear after 7; fully specified, mechanical integration |
| G | 9 | Individual agent, same framework | 1 sonnet implementer + 1 sonnet reviewer | Linear docs + version; verification commands run by the implementer, outputs pasted into the report |
| H | Final whole-branch review | **Workflow**: parallel review lenses → adversarial verify | 5 opus lenses: design conformance (D1–D5), behavior deltas (B1–B5 + B2 edge), mirror-parity regression, test quality/coverage, layering + bundle-weight constraints; each surviving finding verified by 2 sonnet skeptics prompted to refute (peak 5 opus, then ≤10 sonnet) | High-blast-radius arc end (deployed-data semantics); independent lenses catch what one reviewer misses; adversarial verify kills plausible-but-wrong findings before they reach the orchestrator |

Phase A worktree note: T1/T2/T3 touch disjoint files (engine `errors.ts` + new module vs `logic-functions/lib` + `front-components/lib` vs engine grammar files), so merges are clean by construction; the A-int agent exists to serialize the commits and prove the union is green, not to resolve real conflicts. If it does hit a non-trivial conflict, it stops and reports instead of resolving creatively.

Between phases the orchestrator reads every report before dispatching the next phase; confirmed findings from Phase H become fix dispatches (individual agents, model per severity) followed by a re-run of the affected Phase H lens.

## Progress state and cross-session resume

Execution must survive session death at any point. Three durable state carriers:

1. **Git commits** — one per task (plus the A-int merge), conventional messages as specified per task. Code state is always recoverable to the last completed task.
2. **Plan checkboxes** — each implementer ticks its own task's `- [ ]` steps in THIS file as it completes them and includes the plan file in its task commit. The reviewer confirms tick-state matches reality before approving. A step's box is per-step durable progress, committed with the code it describes.
3. **Execution ledger** — `docs/plans/2026-07-31-string-output-execution-ledger.md`, maintained by the orchestrator (inline; bookkeeping, not mechanical work). Append-only, dated entries, one per phase event:

```markdown
## 2026-07-31
- [dispatch] Phase A workflow: T1 impl (sonnet), T2 impl (opus), T3 impl (opus), worktree isolation
- [report] T1 implement OK — engine suite 306 passed; no deviations
- [verdict] T2 review approved; 1 nit fixed by implementer in same worktree
- [deviation] T4 constraint 8: extra churn in recompute.spec.ts — adjudicated: allowed, reason recorded
- [phase-done] A-int merged; whole suite 998 passed; next: dispatch T4
```

Every entry class matters for resume: `dispatch` (what's in flight), `report` (what finished, with test counts), `verdict` (review outcomes), `deviation` (any departure from this plan and its adjudication), `phase-done` (checkpoint + explicit "next:" pointer). Phase H findings are logged individually as confirmed/refuted so re-review scope survives a session boundary. The ledger file is included in the next dispatched agent's commit (implementers are briefed to `git add` the ledger and plan file alongside their changes); if the arc ends a session with no follow-on agent, it may sit uncommitted — it lives on disk and survives the session either way.

**Cold-session resume protocol** (a fresh orchestrating session picks up here):

1. Read the ledger, then this plan. The last `phase-done` entry plus its "next:" pointer is the claimed position.
2. Verify the claim against reality before trusting it: dispatch a checker agent to run `git log --oneline main..HEAD`, compare commits against the per-task commit messages, confirm plan checkbox state matches, and run the whole suite. Discrepancy → trust git + test output over the ledger, log a `deviation` entry.
3. Resume at the first incomplete step of the first unticked task. A `dispatch` entry with no matching `report` means that work is NOT done — inspect its worktree/branch for partial output via a checker agent; either discard it or hand the diff to a fresh implementer, never assume it landed.
4. Interrupted workflows (Phases A/H): do NOT attempt `resumeFromRunId` across sessions — it is same-session only. Re-dispatch the phase as a fresh workflow; tasks already merged and committed are simply omitted from the new fan-out.
5. First action after verifying position: append a ledger entry recording the resume and the verified state.

---

### Task 1: Engine groundwork — `TEXT_TOO_LONG` and canonical number→text rendering

New error code plus the one pure function both the concat evaluator (T5) and the TEXT write boundary (T6) share.

**Files:**
- Create: `src/engine/text-format.ts`, `src/engine/__tests__/text-format.spec.ts`
- Modify: `src/engine/errors.ts:5-12`

**Interfaces:**
- Consumes: `FormulaError` from `src/engine/errors`.
- Produces (T5 and T6 rely on these exact names):

```ts
export const MAX_COMPUTED_TEXT_LENGTH = 10_000;
export const formatNumberAsText: (value: number) => string;
```

- [x] **Step 1: Write the failing test**

Create `src/engine/__tests__/text-format.spec.ts`:

```ts
import { formatNumberAsText, MAX_COMPUTED_TEXT_LENGTH } from 'src/engine/text-format';

describe('formatNumberAsText', () => {
  it('renders integers bare, never with a decimal point', () => {
    expect(formatNumberAsText(42)).toBe('42');
    expect(formatNumberAsText(0)).toBe('0');
    expect(formatNumberAsText(-7)).toBe('-7');
    expect(formatNumberAsText(20665)).toBe('20665');
  });

  it('trims float dust to at most 15 significant digits', () => {
    expect(formatNumberAsText(0.1 + 0.2)).toBe('0.3');
    expect(formatNumberAsText(123.4000000000001)).toBe('123.4');
  });

  it('keeps meaningful fractional digits', () => {
    expect(formatNumberAsText(3.14)).toBe('3.14');
    expect(formatNumberAsText(1 / 3)).toBe('0.333333333333333');
    expect(formatNumberAsText(0.000012)).toBe('0.000012');
  });

  it('falls back to default rendering for exponent-range magnitudes', () => {
    expect(formatNumberAsText(1e21)).toBe('1e+21');
    expect(formatNumberAsText(1e-7)).toBe('1e-7');
  });

  it('exposes the computed-text cap', () => {
    expect(MAX_COMPUTED_TEXT_LENGTH).toBe(10_000);
  });
});
```

- [x] **Step 2: Run it and verify it fails**

Run: `node /home/sasha_shin/twenty/node_modules/vitest/vitest.mjs run src/engine/__tests__/text-format.spec.ts`
Expected: FAIL — cannot resolve `src/engine/text-format`.

- [x] **Step 3: Implement**

Create `src/engine/text-format.ts`:

```ts
// Canonical decimal rendering for text contexts (ADR 0026): integers bare,
// at most 15 significant digits, trailing float dust trimmed. Dates/datetimes
// reach here already coerced to serial numbers, so they render as serials.
export const MAX_COMPUTED_TEXT_LENGTH = 10_000;

export const formatNumberAsText = (value: number): string => {
  if (Number.isInteger(value) && Math.abs(value) < 1e15) {
    return String(value);
  }
  const precise = value.toPrecision(15);
  if (precise.includes('e') || precise.includes('E')) {
    return String(value);
  }
  if (!precise.includes('.')) {
    return precise;
  }
  return precise.replace(/0+$/, '').replace(/\.$/, '');
};
```

- [x] **Step 4: Add the error code**

In `src/engine/errors.ts`, extend the union (after `'CYCLE_DETECTED'`):

```ts
export type FormulaErrorCode =
  | 'TOKENIZE_ERROR'
  | 'PARSE_ERROR'
  | 'DIVISION_BY_ZERO'
  | 'UNKNOWN_VARIABLE'
  | 'NON_NUMERIC_VALUE'
  | 'MAX_DEPTH_EXCEEDED'
  | 'CYCLE_DETECTED'
  | 'TEXT_TOO_LONG';
```

No switch anywhere is exhaustive over this union (verified), so this is additive-safe.

- [x] **Step 5: Run the new spec, then the whole engine subset**

Run: `node /home/sasha_shin/twenty/node_modules/vitest/vitest.mjs run src/engine`
Expected: 301 + 5 = 306 passed.

- [x] **Step 6: Commit**

```bash
git add src/engine/text-format.ts src/engine/__tests__/text-format.spec.ts src/engine/errors.ts
git commit -m "feat(formula-field): TEXT_TOO_LONG error code and canonical number-to-text rendering"
```

---

### Task 2: Shared validation core (pure dedup, zero behavior change)

Collapse the duplicated dispatch in `save-validation.ts:154-225` and `validate-expression.ts:58-95` into one module. This lands **before** any semantic change so Tasks 3–7 edit validation in exactly one place.

**Files:**
- Create: `src/logic-functions/lib/validation-core.ts`, `src/logic-functions/lib/__tests__/validation-core.spec.ts`
- Modify: `src/logic-functions/lib/save-validation.ts`, `src/front-components/lib/validate-expression.ts`, `src/front-components/lib/__tests__/validate-expression.spec.ts` (one message change)

**Interfaces:**
- Consumes: `parse`, `extractDependenciesFromAst`, `collectStringComparisonRefs`, `bareReferenceOf`, `detectCycle`, `isFormulaError`, types `AstNode`/`FormulaDependencies`/`FormulaTarget` from `src/engine`; `ENGINE_FAMILY_KINDS`, `isMirrorTargetKind` from `src/logic-functions/lib/mirror-kinds`.
- Produces (both wrappers and T7 rely on these):

```ts
export type ValidatableFormula = {
  id?: string;
  targetObject: string;
  targetField: string;
  expression: string;
};

export type CoreValidationResult =
  | { valid: true; ast: AstNode; dependencies: FormulaDependencies }
  | { valid: false; error: string };

export const validateExpressionCore = (args: {
  expression: string;
  hostObject: string;
  targetField: string;
  targetFieldType?: string;
  fieldKinds?: (objectName: string) => Map<string, string> | undefined;
  otherFormulas: ValidatableFormula[]; // candidate already excluded by the caller
}) => CoreValidationResult;
```

**Design constraints the implementer must honour:**
1. The module lives under `src/logic-functions/lib/` (frontend already imports from there; the inverse direction is forbidden). It must import nothing beyond `src/engine` and `mirror-kinds` — bundle weight is load-bearing.
2. Move verbatim, in order: (a) parse + dependency extraction (`save-validation.ts:154-167`), (b) the string-comparison field-kind check (`:169-186`), (c) the mirror-validation block (`:188-225`), (d) cycle detection (`:227-244`). Error messages stay character-identical to the backend's, including `` `Dependency cycle detected: ${...}` ``.
3. Candidate exclusion is the **caller's** job (backend excludes by `id`, frontend by `targetObject`/`targetField` pair — both keep their existing exclusion code and pass `otherFormulas` pre-filtered).
4. The backend-only target-name regex check (`save-validation.ts:141-152`) stays in `save-validation.ts`, before the core call. `validateFormula`'s public signature and `SaveValidationResult` do not change; `validateExpression`'s positional signature does not change (it returns `result.valid ? null : result.error`).
5. The frontend's divergent cycle message (`Dependency cycle:` without "detected") unifies to the backend wording — update the one assertion in `validate-expression.spec.ts` that pins it.

- [x] **Step 1: Write the failing test**

Create `src/logic-functions/lib/__tests__/validation-core.spec.ts` with four cases (mirror the fixtures already used in `handlers.spec.ts:280-344`): a valid numeric expression returns `{valid: true}` with dependencies; a string comparison against a NUMBER-kind field returns the exact message `String comparison against "amount" is not supported (field type NUMBER; only SELECT and TEXT fields)`; a non-bare-ref expression targeting a TEXT field returns the mirror-validation error; a two-formula cycle returns a message starting `Dependency cycle detected:`.

- [x] **Step 2: Run it and verify it fails** (module not found).

- [x] **Step 3: Implement the module, rewire both wrappers**

After the move, `save-validation.ts` keeps: name checks → core call → map `CoreValidationResult` into `SaveValidationResult`. `validate-expression.ts` keeps: its definition filtering → core call → `valid ? null : error`. Delete the duplicated blocks from both.

- [x] **Step 4: Run the full unit suite**

Run: `node /home/sasha_shin/twenty/node_modules/vitest/vitest.mjs run`
Expected: 962 + T1's 5 + new core specs, with exactly **one** pre-existing assertion updated (the frontend cycle message). Any other diff in behavior is a bug in the move.

- [x] **Step 5: Lint + typecheck** (`npm run lint`, `npx tsc --noEmit`).

- [x] **Step 6: Commit**

```bash
git add -A src/logic-functions/lib src/front-components/lib
git commit -m "refactor(formula-field): single shared expression-validation core for backend and frontend"
```

---

### Task 3: Grammar — `&` token, concat tier, string primaries

**Files:**
- Modify: `src/engine/tokenizer.ts:10-29,307-316`, `src/engine/ast.ts:145-161`, `src/engine/parser.ts` (grammar comment `:9-57`, `parsePrimary:312-317`, `parseCondition:829-918`, `parseSwitch:669-672`, new tier), `src/engine/dependencies.ts` (three switches), `src/engine/__tests__/tokenizer.spec.ts:227-232`, `parser.spec.ts`, `dependencies.spec.ts`, `fuzz.spec.ts:21-32`

**Interfaces:**
- Produces (T4/T5 rely on):

```ts
// tokenizer.ts — TokenType union gains:
| 'AMPERSAND'
// ast.ts:
export type ConcatNode = {
  type: 'concat';
  // 2+ operands, evaluated left to right; parser flattens a & b & c into one node
  parts: AstNode[];
};
// AstNode union gains ConcatNode.
```

**Design constraints the implementer must honour:**
1. `&` is a single-char token: add `'&': 'AMPERSAND'` to `SINGLE_CHAR_TOKENS` (`tokenizer.ts:307-316`). No lookahead, no `&&`.
2. New precedence tier, loosest of the value grammar, left-to-right: `concat := additive ('&' additive)*`. Add `private parseConcat()` that calls `this.parseExpression()` for operands and flattens into one `ConcatNode` (return the lone operand unchanged when no `&` follows). Mirror `parseExpression`'s `enter()`/depth discipline exactly.
3. **Every current value-context call site of `parseExpression()` switches to `parseConcat()`** — the top-level `parse()` entry, IF/IFS/SWITCH branch and value slots, SUM args, IFBLANK args, and comparison operands in `parseCondition`. Grep for `this.parseExpression()` and audit each site; arithmetic-internal recursion (`parseTerm`/`parseUnary` chain) stays untouched.
4. STRING becomes a legal primary: replace the `case 'STRING':` throw in `parsePrimary` (`:312-317`) with `return { type: 'string', value: token.stringValue ?? '' }` (match the existing StringNode construction at `parseConditionOperand:832-835`). Delete `parseConditionOperand` (`:829-842`) — comparison operands now come from `parseConcat()`. Delete the lone-string rejection in `parseCondition` (`:892-901`), the string-in-default rejection in `parseSwitch` (`:669-672`), and the now-unused `stringOutsideConditionError` factory (`:122-128`).
5. **Keep** the parse-time rejection of a syntactic string operand beside an ordering operator (`parseCondition:908-918`, message `Strings support only = and != comparisons`). It applies only to direct `StringNode` operands, not to concat results.
6. `dependencies.ts`: add a `case 'concat':` that recurses over `node.parts` to all three total switches — `walk` (`:33-129`), `usesToday` (`:136-190`), `walkStringComparisons` (`:224-296`). TypeScript will flag them as non-exhaustive until you do. `walkStringComparisons` recursion must NOT treat concat parts as string-comparison operands — it only descends. `bareReferenceOf` is unchanged (a concat is never a bare reference).
7. Tokenizer hardening test `tokenizer.spec.ts:227-232`: remove `'&'` from the must-reject list and add a positive case asserting `1 & 2` tokenizes to `NUMBER AMPERSAND NUMBER EOF`. Update the stale comment in `fuzz.spec.ts:21-23` (the fuzz invariant itself still holds).
8. Update the grammar comment block (`parser.ts:9-57`) to the new precedence order: parens/primaries, unary, `* / %`, `+ -`, `&`, comparisons (condition slots only).

- [x] **Step 1: Write the failing tests** — in `parser.spec.ts`, new describe `parser concat and string primaries`:

```ts
it('parses & left-associative at loosest value precedence', () => {
  const node = parse('a & "INV" & 1 + amount');
  expect(node.type).toBe('concat');
  expect((node as ConcatNode).parts).toHaveLength(3);
  expect((node as ConcatNode).parts[2].type).toBe('binary'); // + binds tighter than &
});

it('allows string literals in any value position', () => {
  expect(parse('"hello"').type).toBe('string');
  expect(parse('IF(amount > 5, "Hot", "Cold")').type).toBe('if');
  expect(parse('IFBLANK(name, "unknown")').type).toBe('ifblank');
});

it('parses concat operands inside comparisons — & binds tighter than =', () => {
  const node = parse('IF(a & "-x" = code, 1, 0)');
  expect(node.type).toBe('if');
});

it('still rejects string operands beside ordering operators', () => {
  expect(() => parse('IF("a" < "b", 1, 0)')).toThrow('Strings support only = and != comparisons');
});
```

And in `tokenizer.spec.ts` / `dependencies.spec.ts` the cases from constraints 6–7 (dependencies of `a & [company:id:name]` include both refs; `usesToday('TODAY() & ""')` is true).

- [x] **Step 2: Run and verify failures** — `node /home/sasha_shin/twenty/node_modules/vitest/vitest.mjs run src/engine` — new tests fail with tokenize/parse errors; the two known-breaking existing tests (`tokenizer.spec.ts:227`, old string-rejection parser tests in the `:875` describe) show which legacy assertions to update.
- [x] **Step 3: Implement** per constraints 1–8. Legacy parser tests that assert the old rejections (`parser string literals (comparison operands only)` describe) are rewritten to assert the new acceptance.
- [x] **Step 4: Engine subset green** — expected: 306 from T1, minus rewritten assertions, plus new ones; report the exact count. **Note:** evaluator tests still pass because a `ConcatNode` reaching the evaluator hits the `default:` exhaustiveness throw — concat *evaluation* is T5; do not add evaluator cases here.
- [x] **Step 5: Whole suite + lint + typecheck** — `dependencies.ts` switch totality means `tsc` failing is the signal you missed a switch.
- [x] **Step 6: Commit** — `feat(formula-field): & token, concat parse tier, string literals as primaries`

---

### Task 4: Evaluator — typed value domain and single resolver

The engine's runtime domain becomes `number | string | null`; the raw-resolver channel is deleted. **This task preserves observable behavior everywhere except deltas B1/B3/B4** (enumerated below); concat evaluation and the remaining design semantics are T5.

**Files:**
- Modify: `src/engine/evaluator.ts`, `src/logic-functions/lib/coercion.ts`, `src/logic-functions/lib/recompute.ts:187-241,271` (+ `ComputeResult`/plumbing type widening), `src/engine/__tests__/evaluator.spec.ts` (the `:643` string-comparison describe rewrites), `src/logic-functions/lib/__tests__/coercion.spec.ts`, `recompute.spec.ts` (string-comparison cases)

**Interfaces:**
- Produces (T5–T8 rely on):

```ts
// evaluator.ts
export type EngineValue = number | string | null;
export type VariableResolver = (reference: VariableReference) => EngineValue | undefined;
export const evaluate: (node: AstNode, resolve: VariableResolver, options?: EvaluateOptions) => EngineValue;
// EvaluateOptions loses resolveRaw; RawVariableResolver and resolveStringOperand are deleted.

// coercion.ts
export const coerceToEngineValue: (raw: unknown) => EngineValue;
// coerceToNumber stays exported unchanged — the write boundary (T6) still needs it.
```

**Design constraints the implementer must honour:**
1. `coerceToEngineValue` (in `coercion.ts`, beside `coerceToNumber`): strings — empty/whitespace → return the string verbatim; date-shaped (reuse the exact `isDateOnlyString`/`isIsoDateTimeString` checks on the trimmed value) → serial via the existing parsers; anything else → return the string verbatim. Non-strings delegate to `coerceToNumber` (null/number/boolean/currency behavior unchanged).
2. `recompute.ts`: `buildResolver` (`:191-215`) swaps `coerceToNumber` → `coerceToEngineValue`. **Delete `buildRawResolver`** (`:222-241`) and every `resolveRaw` plumbing site (the `evaluate(...)` call at `:355-366` and any others `grep -rn resolveRaw src/` finds). Widen `ComputeResult.value` (`:271`) and the types it flows into to `EngineValue`.
3. **Numeric contexts coerce text at point of use.** Add an evaluator-internal helper:

```ts
// Point-of-use numeric coercion for the text domain. Date-shaped strings were
// already coerced to serials at resolve time, so only Number() applies here.
const toNumber = (value: number | string): number => {
  if (typeof value === 'number') {
    return value;
  }
  const trimmed = value.trim();
  if (trimmed !== '') {
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  throw new FormulaError(
    'NON_NUMERIC_VALUE',
    `Text value is not numeric (${JSON.stringify(value)})`,
  );
};
```

   Apply it (after the existing null-propagation checks) in: binary arithmetic operands, unary operand, SUM args, ordering comparisons (`< <= > >=`), and the numeric-truthiness fallback in `evaluateConditionTruth` (`:234-241`). The `Number('') === 0` trap is why the empty-string guard is mandatory.
4. **Typed equality replaces string mode.** In the comparison case (`evaluateConditionTruth:106-144`): evaluate both operands via `evaluateNode` (value domain); either null → null; for `=`/`!=`, `typeof left !== typeof right` → `=` false / `!=` true, else strict compare; for ordering, `toNumber` both. Delete `resolveStringOperand` (`:74-93`) and the `left.type === 'string' || right.type === 'string'` branch.
5. **ISBLANK moves to the value domain**: delete the raw-resolver special case (`:208-232`); blank is `value === null || (typeof value === 'string' && value.trim() === '')`. Extract that as `const isBlankValue = (value: EngineValue): boolean => ...` — T5 reuses it for IFBLANK. (IFBLANK itself is untouched in this task.)
6. `evaluateNode` `case 'string'` (`:438-445`) returns `node.value` instead of throwing. The `default:` exhaustiveness guard stays (concat still lands there until T5). The top-level finite check (`:474-479`) and the binary/sum finite checks (`:345-350`, `:403-408`) apply **only when the value is a number**.
7. The evaluator header comment (`:5-37`) and the domain-invariant comments (`evaluator.ts:96`, `parser.ts:40`, `ast.ts:55`, `ast.ts:93`) are updated to describe the `number | string | null` domain.
8. **Expected legacy-test churn is confined to:** the `evaluator string comparisons (resolveRaw)` describe (`:643` — rewritten against the typed resolver: field-vs-literal text compare still works, string-vs-number now false instead of null per B4), any evaluator/recompute tests that passed `resolveRaw`, and coercion tests asserting `coerceToNumber('42') === 42` semantics at resolve (now asserted against `coerceToEngineValue` returning `'42'`). Every other one of the 900+ tests must pass unmodified — if a different test breaks, stop and reassess rather than "fixing" the test.

- [x] **Step 1: Write the failing tests** — new describe `evaluator typed value domain` in `evaluator.spec.ts`:

```ts
const resolver = (values: Record<string, EngineValue>): VariableResolver =>
  (ref) => (ref.kind === 'same' ? values[ref.path] : undefined);

it('resolves text fields verbatim and compares typed', () => {
  const resolve = resolver({ zip: '01234', amount: 42 });
  expect(evaluate(parse('IF(zip = "01234", 1, 0)'), resolve)).toBe(1);
  expect(evaluate(parse('IF(amount = "42", 1, 0)'), resolve)).toBe(0); // B1: non-coercing =
  expect(evaluate(parse('IF(amount != "42", 1, 0)'), resolve)).toBe(1);
});

it('coerces numeric-shaped text at point of use in arithmetic', () => {
  const resolve = resolver({ zip: '01234' });
  expect(evaluate(parse('zip + 1'), resolve)).toBe(1235);
  expect(() => evaluate(parse('zip & 1'), resolve)).toThrow(); // concat lands in T5
});

it('treats empty text as non-numeric, not zero', () => {
  const resolve = resolver({ note: '' });
  expect(() => evaluate(parse('note + 1'), resolve)).toThrow(FormulaError);
});

it('ISBLANK sees whitespace-only text as blank via the value domain', () => {
  const resolve = resolver({ note: '   ', name: 'x' });
  expect(evaluate(parse('IF(ISBLANK(note), 1, 0)'), resolve)).toBe(1);
  expect(evaluate(parse('IF(ISBLANK(name), 1, 0)'), resolve)).toBe(0);
});

it('compares two text fields without erroring', () => {
  const resolve = resolver({ a: 'won', b: 'won' });
  expect(evaluate(parse('IF(a = b, 1, 0)'), resolve)).toBe(1); // B4
});
```

And in `coercion.spec.ts`: `coerceToEngineValue('2026-01-15')` → serial number; `coerceToEngineValue('042')` → `'042'`; `coerceToEngineValue('')` → `''`; `coerceToEngineValue(true)` → `1`; `coerceToEngineValue(null)` → `null`.

- [x] **Step 2: Run and verify failures** (type errors on `EngineValue` import first, then behavioral).
- [x] **Step 3: Implement** per constraints 1–7.
- [x] **Step 4: Run the whole suite.** Reconcile churn strictly per constraint 8; report the final count.
- [x] **Step 5: Lint + typecheck.**
- [x] **Step 6: Commit** — `feat(formula-field): typed number|string value domain with single resolver`

---

### Task 5: Evaluator — `&` semantics, computed-text cap, IFBLANK blankness

**Files:**
- Modify: `src/engine/evaluator.ts` (concat case, ifblank case), `src/engine/ast.ts:121-131` (IFBLANK asymmetry comment now false — rewrite it), `evaluator.spec.ts`

**Interfaces:**
- Consumes: `formatNumberAsText`, `MAX_COMPUTED_TEXT_LENGTH` (T1), `ConcatNode` (T3), `EngineValue`/`isBlankValue` (T4).
- Produces: full design-doc language semantics; no new exports.

**Design constraints the implementer must honour:**
1. Concat case in `evaluateNode` (before the `default:` guard):

```ts
case 'concat': {
  // D2: null coerces to '' inside & only; Kleene propagation is untouched elsewhere.
  let result = '';
  for (const part of node.parts) {
    const value = evaluateNode(part, resolve, depth + 1, maxDepth, todayEpochDay);
    if (value !== null) {
      result += typeof value === 'number' ? formatNumberAsText(value) : value;
    }
    if (result.length > MAX_COMPUTED_TEXT_LENGTH) {
      throw new FormulaError(
        'TEXT_TOO_LONG',
        `Computed text exceeds ${MAX_COMPUTED_TEXT_LENGTH} characters`,
      );
    }
  }
  return result;
}
```

   All parts always evaluate (SUM precedent: errors in any operand fire). An all-null concat returns `''`, not null.
2. IFBLANK (`:417-421`) generalizes via T4's `isBlankValue`: `return isBlankValue(value) ? fallback : value;` — both operands still eagerly evaluated. Rewrite the `ast.ts:121-131` comment: the null-vs-blank asymmetry with ISBLANK is now gone by design (ADR 0026).
3. The cap applies only to concat results. A long TEXT field flowing through a one-term formula or IF branch is never truncated or capped (mirror parity).
4. Cross-check discipline (design doc, Testing section): where a case has a defined OpenFormula/Excel answer (`&` null handling, number rendering, non-coercing `=`), verify the expected value against HyperFormula's or Gnumeric's documented behavior before pinning the assertion — behavior only, clean-room, no GPL code copied. If they disagree with the design doc, the design doc wins; note the divergence in the task report.

- [x] **Step 1: Write the failing tests** — describe `evaluator concat (&)`:

```ts
it('concatenates text, numbers, and nulls per the design matrix', () => {
  const resolve = resolver({ aString: 'ACME-', amount: 42, empty: null, flag: 1 });
  expect(evaluate(parse('aString & "INV" & amount'), resolve)).toBe('ACME-INV42');
  expect(evaluate(parse('empty & "x"'), resolve)).toBe('x');          // null -> ''
  expect(evaluate(parse('empty & empty'), resolve)).toBe('');         // all-null -> ''
  expect(evaluate(parse('flag & ""'), resolve)).toBe('1');            // boolean via numeric coercion
  expect(evaluate(parse('1/3 & ""'), resolve)).toBe('0.333333333333333');
});

it('renders date serials in concat (B2)', () => {
  const resolve = resolver({ closeDate: 20665 }); // already serial via coerceToEngineValue
  expect(evaluate(parse('closeDate & ""'), resolve)).toBe('20665');
});

it('raises TEXT_TOO_LONG past 10k chars', () => {
  const resolve = resolver({ big: 'x'.repeat(9_999) });
  expect(() => evaluate(parse('big & "ab"'), resolve)).toThrow(FormulaError);
  try {
    evaluate(parse('big & "ab"'), resolve);
  } catch (error) {
    expect((error as FormulaError).code).toBe('TEXT_TOO_LONG');
  }
});

it('IF branches may return text; IFBLANK falls back on whitespace-only', () => {
  const resolve = resolver({ amount: 60000, note: '   ' });
  expect(evaluate(parse('IF(amount > 50000, "Hot", "Cold")'), resolve)).toBe('Hot');
  expect(evaluate(parse('IFBLANK(note, "unknown")'), resolve)).toBe('unknown');
});

it('concat result compares as text', () => {
  const resolve = resolver({ a: 'AC', code: 'AC-x' });
  expect(evaluate(parse('IF(a & "-x" = code, 1, 0)'), resolve)).toBe(1);
});
```

- [x] **Step 2: Run and verify failures** (concat hits the `default:` exhaustiveness throw from T4).
- [x] **Step 3: Implement** per constraints 1–3.
- [x] **Step 4: Engine subset + whole suite green; report counts.**
- [x] **Step 5: Lint + typecheck.**
- [x] **Step 6: Commit** — `feat(formula-field): concat evaluation, computed-text cap, text-aware IFBLANK`

---

### Task 6: Write boundary — TEXT in value-io, tagged outcome, kind-dispatched bookkeeping

Adds the text column of the design's dispatch table. After this task TEXT is expressible **mechanically** but not yet routable (TEXT is still in `MIRRORABLE_KINDS` until T7), so every existing lane keeps its behavior; the new branches are exercised by direct unit tests.

**Files:**
- Modify: `src/logic-functions/lib/value-io.ts`, `src/logic-functions/lib/types.ts:61-77`, `src/logic-functions/lib/recompute.ts:243-248,622-647,909-932`, `src/logic-functions/lib/formula-repository.ts:281-381`, `src/logic-functions/lib/handle-record-update.ts:166-204`, `src/logic-functions/lib/mirror-kinds.ts:30-35` (ENGINE_FAMILY_KINDS side only), specs: `value-io.spec.ts`, `recompute.spec.ts`, `handlers.spec.ts`, `mirror-target.spec.ts:109` (drift guard)

**Interfaces:**
- Consumes: `EngineValue` (T4), `formatNumberAsText` (T1), `coerceToNumber` (existing).
- Produces (T7/T8 rely on):

```ts
// value-io.ts
export const ENGINE_FAMILY = ['NUMBER', 'CURRENCY', 'DATE', 'DATE_TIME', 'TEXT'] as const; // TEXT added
export type TargetFieldKind = (typeof ENGINE_FAMILY)[number];
export const normalizeStoredValue: (raw: unknown, kind: TargetFieldKind) => EngineValue;
export const normalizeComputedValue: (targetFieldType: string, value: EngineValue, options: { integerBacked: boolean }) => EngineValue;
export const buildTargetWriteData: (targetField: string, targetFieldType: string, value: EngineValue, currentRaw?: unknown, defaultCurrencyCode?: string) => Record<string, unknown>;
// types.ts — F5 dissolves:
export type ComputedValue =
  | { kind: 'number'; value: number | null }
  | { kind: 'text'; value: string | null }
  | { kind: 'raw'; value: unknown };
// RecomputeOutcome.value: ComputedValue (replaces the value/rawValue pair)
```

**Design constraints the implementer must honour:**
1. `normalizeComputedValue` per target kind: numeric/date kinds — a string value first runs `coerceToNumber` (the write-boundary rule: `"42"` succeeds, `"INV42"` throws `NON_NUMERIC_VALUE`, standard eval-error doctrine applies), then the existing per-kind rounding; TEXT — string verbatim, number via `formatNumberAsText`, null stays null. `normalizeStoredValue` for TEXT returns the raw string (or null). `buildTargetWriteData` TEXT branch writes `{ [targetField]: value }` — `''` writes as an empty string (existing mirror behavior for TEXT), null clears.
2. `targetFieldKind('TEXT')` returns `'TEXT'` (no more fallback-to-NUMBER for TEXT); `selectionEntryForFieldKind('TEXT')` selects the scalar. Update the drift guard: `ENGINE_FAMILY_KINDS` in `mirror-kinds.ts` mirrors the new five-member family (the `mirror-target.spec.ts:109` guard asserts set equality — update both sides in this task). **Do NOT remove TEXT from `MIRRORABLE_KINDS` here** — that is T7's lane switch; during this task TEXT is deliberately in both sets and mirror validation still wins for TEXT targets.
3. `valuesEqual` (`recompute.ts:243-248`) widens to `EngineValue` — strict `===` covers both domains; text convergence is strict string equality per the design.
4. `RecomputeOutcome` carries `value: ComputedValue`; the engine lane tags by target kind (TEXT → `{kind:'text'}`, else `{kind:'number'}`), the mirror lane produces `{kind:'raw', value: mirror.rawValue}` (its `rawValue` field folds in). The `sampleValue`/`sampleRawValue` split (`recompute.ts:909-932`) collapses to one sampled `ComputedValue`. Update every outcome consumer `grep -rn "rawValue" src/logic-functions` finds — mechanical, but each site must dispatch on `kind`, not `typeof`.
5. Heartbeat (`formula-repository.ts:329-381`) dispatches on the sampled `ComputedValue.kind`: `number` → `lastValue` numeric path including the ADR 0015 TODAY carve-out; `text` and `raw` → `lastValueText` via the existing `mirrorValueText` JSON convention (keeps deployed TEXT-mirror heartbeats byte-compatible). `isMirrorHeartbeat` (re-parse-based, `:300-309`) is deleted in favor of the kind dispatch.
6. Override slot choice becomes target-kind-driven: TEXT and raw kinds → `{ text: JSON.stringify(value ?? null) }` (the existing mirror convention — deployed TEXT-mirror overrides must round-trip through `decodeMirrorOverrideValue` unchanged); numeric kinds → `{ numeric: value }`. In this task only the numeric-side call site (`handle-record-update.ts:202-204`) is confirmed unchanged; the TEXT routing lands with T7. Add a comment at `override-repository.ts:171-174` stating the convention.
7. Existing suites (`value-io.spec.ts` 22, `currency/date/integer-target`, `mirror-target.spec.ts` 32) must pass with only mechanical updates (type widenings, `ComputedValue` unwrapping in assertions). Behavioral diffs are bugs.

- [x] **Step 1: Write the failing tests** — in `value-io.spec.ts`, describe `TEXT target kind`: `targetFieldKind('TEXT') === 'TEXT'`; `normalizeComputedValue('TEXT', 42, {integerBacked:false}) === '42'`; `normalizeComputedValue('TEXT', 'ACME-INV42', ...) === 'ACME-INV42'`; `normalizeComputedValue('NUMBER', '42', ...) === 42`; `normalizeComputedValue('NUMBER', 'INV42', ...)` throws `NON_NUMERIC_VALUE`; `buildTargetWriteData('code', 'TEXT', '')` → `{ code: '' }`; `buildTargetWriteData('code', 'TEXT', null)` → `{ code: null }`. In `handlers.spec.ts`: a heartbeat for a TEXT-kind outcome writes `lastValueText` (JSON-encoded) and leaves `lastValue` untouched.
- [x] **Step 2: Run and verify failures.**
- [x] **Step 3: Implement** per constraints 1–6.
- [x] **Step 4: Whole suite green; report count and enumerate which existing assertions needed mechanical updates.**
- [x] **Step 5: Lint + typecheck.**
- [x] **Step 6: Commit** — `feat(formula-field): TEXT write boundary, tagged ComputedValue outcome, kind-dispatched bookkeeping`

---

### Task 7: Lane switch — TEXT becomes engine-expressible

The riskiest task: TEXT leaves the mirror lane. Deployed TEXT mirrors (bare-ref expressions) start flowing through the engine as one-term formulas and must produce byte-identical writes for everything except the documented B2 edge.

**Files:**
- Modify: `src/logic-functions/lib/mirror-kinds.ts:16-29,87-91`, `src/logic-functions/lib/recompute.ts:564-604`, `src/logic-functions/lib/handle-record-update.ts:118-164,248-259`, `src/logic-functions/lib/scan-selection.ts:47-85`, specs: `mirror-kinds.spec.ts`, `mirror-target.spec.ts`, `handlers.spec.ts`, `scan-selection.spec.ts`, `syncable-fields.spec.ts`

**Interfaces:**
- Consumes: everything from T4–T6.
- Produces: `MIRRORABLE_KINDS` without `'TEXT'` (11 kinds); `isMirrorDefinition` unchanged in shape but now false for TEXT targets. `SYNCABLE_KINDS` (`syncable-fields.ts:13-16`) is the union of both sets and **must be provably identical before and after** — assert that in a test.

**Design constraints the implementer must honour:**
1. Remove `'TEXT'` from `MIRRORABLE_KINDS` (`mirror-kinds.ts:16-29`). That single edit flips `isMirrorDefinition`/`isMirrorTargetKind` for TEXT at all six call sites; audit each (recompute.ts:565-573, formula-repository.ts — deleted in T6, handle-record-update.ts:123-130 and :253, scan-selection.ts:47, formula-editor.tsx:126 — frontend handled in T8).
2. Engine-lane consequences that must hold for a bare-ref TEXT formula (write parity with the old mirror lane):
   - value: `coerceToEngineValue(raw)` returns the string verbatim for non-date-shaped content (B5); write is `{ [targetField]: value }` — identical payload to the old `mirror.rawValue` write for strings and null.
   - convergence: old lane used `deepJsonEqual(currentRaw, rawValue)`; new lane uses strict `===` on `normalizeStoredValue` — for scalar strings/null these agree (including the null-vs-undefined suppression: confirm `normalizeStoredValue(undefined, 'TEXT')` yields null so an empty-over-empty write stays suppressed).
   - cross-record TEXT mirror `[obj:id:field]`: engine crossref resolution already fetches; the F10 prefetch-trust distinction dissolves for TEXT (engine lane may trust the event `after` for same-record deps — that is an *improvement*: one fewer refetch; assert the write is still correct in the event-driven test).
   - a TEXT mirror whose source holds a **non-string scalar** (number/boolean — possible if the source field kind was TEXT but data is dirty): old lane copied raw verbatim; new lane coerces via `coerceToEngineValue` then renders through `normalizeComputedValue('TEXT', ...)`. Numbers render canonically; booleans become `1`/`0`. Accept and note in ADR 0026 (dirty-data corner).
3. Override detection for TEXT targets (`handle-record-update.ts`): TEXT now takes the *formula* path (`:166-204` shape) but with text comparison — computed text vs stored raw via strict string compare (not `numbersEqual`), storing `{ text: JSON.stringify(currentRaw ?? null) }` on a genuine human edit (the convention from T6 constraint 6). Existing active TEXT-mirror overrides must keep suppressing recompute and keep restoring via `decodeMirrorOverrideValue` — `handlers.spec.ts:536-625` (override round-trip, toggle-off restore) are the regression net; they must pass with at most lane-labeling updates.
4. `scan-selection.ts`: TEXT-target definitions now take the engine branch (`:75-85`). The engine branch must select TEXT deps and the TEXT target scalar correctly (it is path-driven — verify, don't assume; `scan-selection.spec.ts` gets a TEXT-target case).
5. Mirror suites: TEXT fixtures in `mirror-target.spec.ts` move semantics from "mirror lane" to "engine lane, same observable writes". Rewrite those cases to assert the *write payloads* are unchanged rather than which internal function ran. Non-TEXT mirror kinds (SELECT, BOOLEAN, composites…) must be completely untouched — any diff in their assertions is a bug.
6. Save-validation via T2's core: with TEXT out of `MIRRORABLE_KINDS`, the mirror-validation block no longer constrains TEXT targets, so `aString & "INV" & 1+TODAY()` with `targetFieldType: 'TEXT'` now validates. Add exactly that as a `validation-core.spec.ts` case, plus: a non-bare-ref expression targeting a SELECT field still rejects (mirror rule intact for raw kinds).

- [x] **Step 1: Write the failing tests** — `mirror-kinds.spec.ts`: `MIRRORABLE_KINDS` no longer contains TEXT, `SYNCABLE_KINDS` unchanged as a set; `recompute.spec.ts`: a bare-ref TEXT definition writes the source string verbatim and converges (second run writes nothing); a `&` TEXT definition end-to-end (`recomputeForRecord` with a fake client) writes the concatenated string and records a text heartbeat; `validation-core.spec.ts` cases from constraint 6.
- [x] **Step 2: Run and verify failures.**
- [x] **Step 3: Implement** per constraints 1–6.
- [x] **Step 4: Whole suite green.** Explicitly re-run and report: `mirror-target.spec.ts`, `handlers.spec.ts`, `scan-resume.spec.ts`, `pagination.spec.ts`, `batch-write.spec.ts`.
- [x] **Step 5: Lint + typecheck.**
- [x] **Step 6: Commit** — `feat(formula-field): TEXT joins the engine lane; mirrors become one-term formulas`

---

### Task 8: Frontend — Text output format, wizard routing, display fixes

**Files:**
- Create: `src/front-components/lib/display-value.ts`, `src/front-components/lib/__tests__/display-value.spec.ts`
- Modify: `src/front-components/lib/formula-field-formats.ts:12-19,28-41,43-106,154-191`, `src/front-components/formula-setup-wizard.tsx:642-712,716-798`, `src/front-components/format-options-fields.tsx:120-249`, `src/front-components/field-settings-editor.tsx:48-70`, `src/front-components/formula-editor.tsx:134-158,918`, `src/front-components/formula-definition-editor.tsx:68,600-602`, `src/front-components/lib/__tests__/formula-field-formats.spec.ts:22-52`

**Interfaces:**
- Consumes: `ENGINE_FAMILY`/`targetFieldKind` (T6), `isMirrorTargetKind` (T7 semantics), `epochDaysToDateString`/`epochDaysToIsoDateTime` (existing).
- Produces:

```ts
// formula-field-formats.ts
export type OutputFormat = 'integer' | 'decimal' | 'percent' | 'shortNumber' | 'currency' | 'date' | 'datetime' | 'text';
// OutputFormatDefinition.fieldType / .targetFieldType unions gain 'TEXT'
// display-value.ts
export const displayValue: (definition: { targetFieldType: string }, value: unknown) => string;
```

**Design constraints the implementer must honour:**
1. New `OUTPUT_FORMATS` entry, appended after `datetime`:

```ts
{
  key: 'text',
  label: 'Text',
  hint: '"ACME-42"',
  fieldType: 'TEXT',
  targetFieldType: 'TEXT',
  defaultDecimals: 0,
},
```

2. Guard both DATE/DATE_TIME fall-throughs: `buildFieldSettings` (`:154-191`) returns `undefined` for TEXT **before** the date default branch (TEXT fields need no settings; the `createOneField` call already spreads settings conditionally); `format-options-fields.tsx` renders nothing for TEXT (no options in v1) — early-return before its date branch at `:212`. `areFormatOptionsValid` is trivially true for TEXT. `formatKeyForType` (`field-settings-editor.tsx:48-70`) gains `case 'TEXT': return 'text';` before the `default`.
3. Wizard `createMirror` (`:716-798`): when `sourceField.type === 'TEXT'`, write `outputFormat: 'text'` instead of `'mirror'` (expression from `seedMirrorExpression` is already correct). Mirror-mode *resume* detection (`:165-167`) keys on `outputFormat === 'mirror' || persistedMirror` — a persisted TEXT mirror draft still resumes into mirror mode via its mirror block; verify, and keep the `pickMode` clearing logic coherent (leaving mirror mode for a TEXT draft must not strand `outputFormat: 'text'`).
4. Extract `displayValue` from `formula-editor.tsx:134-158` into `src/front-components/lib/display-value.ts` **with a string branch that no longer depends on TEXT being a mirror kind**:

```ts
export const displayValue = (
  definition: { targetFieldType: string },
  value: unknown,
): string => {
  if (value === null || value === undefined) {
    return '—';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (isMirrorTargetKind(definition.targetFieldType)) {
    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }
    return JSON.stringify(value);
  }
  const numericValue = value as number;
  if (definition.targetFieldType === 'CURRENCY') {
    return `${(numericValue / 1_000_000).toFixed(2)}`;
  }
  if (definition.targetFieldType === 'DATE') {
    return epochDaysToDateString(numericValue);
  }
  if (definition.targetFieldType === 'DATE_TIME') {
    return epochDaysToIsoDateTime(numericValue);
  }
  return String(numericValue);
};
```

   `formula-editor.tsx` imports it; the module-private copy is deleted.
5. `formula-definition-editor.tsx`: the `lastValue` display (`:600-602`) falls back to `lastValueText` — decode with a safe `JSON.parse` try/catch (the stored convention is JSON-stringified) and render the decoded string, else `—`. Widen the local `Definition` type at `:68` accordingly. The provenance-line gating (`:571`, `isMirrorTargetKind`) now excludes TEXT — a TEXT mirror renders the standard settings editor instead of the read-only provenance line; that is the accepted UX change of the lane switch.
6. `formula-field-formats.spec.ts:24-33` exact key list gains `'text'` at the end. Add `display-value.spec.ts`: string verbatim, null dash, CURRENCY micros division, TEXT-target number `String()`.
7. No new dependencies; `.tsx` files stay untested (vitest glob) — all asserted logic lives in the two `lib/` modules.

- [ ] **Step 1: Write the failing tests** (formats key list + `display-value.spec.ts`).
- [ ] **Step 2: Run and verify failures.**
- [ ] **Step 3: Implement** per constraints 1–7.
- [ ] **Step 4: Whole suite green + `npx tsc --noEmit`** (the `.tsx` changes are only checked by tsc — treat a clean typecheck as mandatory, not optional).
- [ ] **Step 5: Lint.**
- [ ] **Step 6: Commit** — `feat(formula-field): Text output format, wizard routing, string-aware displays`

---

### Task 9: ADR 0026, ADR index catch-up, version 0.2.0, final verification

**Files:**
- Create: `docs/adr/0026-string-values-and-concatenation.md`
- Modify: `docs/adr/README.md` (rows 0023–0026), `docs/plans/2026-07-28-string-output-design.md:4` (status → `implemented by docs/plans/2026-07-31-string-output-implementation.md`), `package.json:3` (`0.2.0`)

- [ ] **Step 1: Write ADR 0026** following the structural model of `docs/adr/0017-boolean-condition-functions.md` (Context / Decision / Consequences / Not done). It must cover, bullet-by-bullet: D1–D5 as adopted; the `&` grammar tier and precedence; semi-eager coercion (`coerceToEngineValue`: dates eager, numeric strings lazy) with behavior deltas B1–B5 and the B2 date-shaped-TEXT edge; typed non-coercing equality; `TEXT_TOO_LONG` (10k, concat-only); the target-kind dispatch replacing the eleven mirror-vs-engine forks (name them); the JSON conventions kept for `overrideValueText`/`lastValueText` back-compat; the dirty-data corner from T7 constraint 2. Not done: `TEXT()`, date formatting in `&`, kind-aware resolution (escape hatch), SELECT output (next version).
- [ ] **Step 2: Refresh the ADR index** — `docs/adr/README.md` gains four rows in the existing `| [NNNN](NNNN-slug.md) | Title | Status |` format: 0023 (Implemented), 0024 (Implemented), 0025 (Implemented), 0026 (Implemented). Titles verbatim from each file's H1.
- [ ] **Step 3: Flip the design doc status line and bump `package.json` to `0.2.0`** (first language-surface expansion — design doc rollout section).
- [ ] **Step 4: Full verification (see next section); paste the outputs into the task report.**
- [ ] **Step 5: Commit** — `docs(formula-field): ADR 0026 string values and concatenation; ADR index catch-up; v0.2.0`

## Verification before calling this done

- [ ] `node /home/sasha_shin/twenty/node_modules/vitest/vitest.mjs run` — everything green; final count reported (baseline 962; expect roughly +60–90).
- [ ] `npx tsc --noEmit` — clean.
- [ ] `npm run lint` — clean.
- [ ] Anti-regression greps (all must return nothing):
  - `grep -rn "resolveRaw\|RawVariableResolver\|resolveStringOperand\|buildRawResolver\|isMirrorHeartbeat" src/`
  - `grep -rn "parseConditionOperand\|stringOutsideConditionError" src/engine/`
  - `grep -n "'TEXT'" src/logic-functions/lib/mirror-kinds.ts` — TEXT appears only via `ENGINE_FAMILY`, not in `MIRRORABLE_KINDS`.
- [ ] Confirm zero diffs under `src/objects/` (`git diff main --stat -- src/objects` empty).
- [ ] Spot-check the flagship expression end-to-end in a unit test (exists from T7 Step 1): `aString & "INV" & 1+TODAY()` against a fake client writes the expected string.
- [ ] Phase H review workflow (see Execution model): five parallel opus lenses, findings adversarially verified by sonnet skeptics; only confirmed findings come back as fix dispatches. The branch is done when Phase H returns no confirmed findings.

Deployment to cloud (npm twenty-sdk on the hosted platform line), the formulahelp `reference.md` refresh (hard truth #1 — "formulas can never output text" — becomes false), and any workspace verification are **not** part of this plan and need explicit user approval.

## Next version commitment: SELECT output

Per the design doc's closing section, the next planning cycle starts at SELECT output: SELECT joins the expressible bucket as a text-kind target with one extra write-time step (computed string must match a defined option value, else standard eval-error doctrine). Storage, convergence, and override detection already ride the text columns built here — the unified pipeline was chosen partly to make that nearly free on the backend. The remaining work is almost entirely the wizard: an options editor (values, labels, colors) mirroring Twenty's native SELECT creation, plus post-creation settings editing. **Do not silently drop this: when this plan completes, the arc's next step is the SELECT design brainstorm.**
