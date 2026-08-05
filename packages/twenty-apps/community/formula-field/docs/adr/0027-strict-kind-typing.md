# ADR 0027: Strict kind typing

**Status: IMPLEMENTED (design approved 2026-08-05; implemented 2026-08-05).**
Design doc: `docs/plans/2026-08-05-strict-typing-design.md`. Implementation plan:
`docs/plans/2026-08-05-strict-typing-implementation.md` (10 tasks; execution
ledger `docs/plans/2026-08-05-strict-typing-execution-ledger.md`).
Supersedes ADR 0026 decisions **B2** (eager date-coercion of date-shaped text
content) and **B6** (silent cross-kind `=` flip to false), plus the lazy
numeric coercion **B3** preserved in arithmetic (`textField * 2` no longer
resolves numeric-shaped text implicitly).

## Context

Live verification of v0.2.0 (2026-08-04, `verification-reports/T6-verdict.md`)
surfaced two deltas the user rejected as design: B6/H2 (a DATE value or
date-shaped text compared `=` against a text literal silently returns false,
with no save-time signal) and, underlying it, B2 (the engine treats
date-shaped-and-valid TEXT content as a date in every context). The ruling:
the engine should never treat date-shaped text as a date; comparisons must be
strictly kind-matched. Cloud deploy of the v0.2.0 line was held until this
shipped, so the deployed semantics are the intended ones from day one.

ADR 0026's Not-done section pre-named the starting point ("kind-aware field
resolution"). This ADR goes further than that escape hatch: the user chose
full strictness across the whole language during the design brainstorm, not
just comparisons — arithmetic and conditions are typed too.

## Decision

### D1 — Kind lattice

Seven kinds, assigned statically to every AST node — five *lattice* kinds
that participate in operations, plus two non-lattice kinds:

| Kind | Sources |
|---|---|
| number | NUMBER and CURRENCY fields, numeric literals, arithmetic results, SUM, NUMBER() |
| date | DATE fields, TODAY(), DATE("YYYY-MM-DD") |
| datetime | DATE_TIME fields |
| text | TEXT and SELECT fields, string literals, `&` results, TEXT() |
| boolean | BOOLEAN fields, comparison results, AND/OR/NOT, ISBLANK |
| opaque | KNOWN field types outside the lattice (LINKS, MULTI_SELECT, ADDRESS, RATING, …) — mismatches every operation, preserving the 1b/1d rejections the retired pattern branches provided |
| unknown | kind not resolvable (metadata absent) — every constraint skipped, never rejected |

`date` and `datetime` are distinct kinds; comparing them to each other is a
mismatch. CURRENCY keeps its current numeric resolution (a bare `price`
reference is `number` in micros; dotted subpaths are ungated — see D1's
dotted-path rule below).

`boolean` is an unreachable *output* kind: no engine-family target field
holds boolean (a BOOLEAN target is the mirror lane, which the gate never
touches), so the output gate can infer boolean but never expect it — a
boolean-inferring expression onto any engine-family target is always a
mismatch.

**Dotted paths infer `unknown` (skip, never reject).** Only a bare root
reference maps through the field-type-to-kind table; a dotted path
(`price.currencyCode`, `myLinks.primaryLinkUrl`) infers `unknown` rather than
inheriting the root's kind, which would otherwise be wrong (the root CURRENCY
maps to `number`, but `price.currencyCode` holds text) and would turn
expressions that evaluate correctly today into unrejectable save failures.
This loosens save-time rejection for dotted paths relative to the retired
branch 1b, which is the safe direction — 1b was over-rejecting on paths it
never actually resolved.

### D2 — One rule: kinds must match the operation

- `=` / `!=`: both sides the same kind. Any kind may participate (boolean =
  boolean is legal).
- Ordering (`<`, `<=`, `>`, `>=`): both sides the same kind, and only number,
  date, or datetime. Text and boolean ordering is rejected. Two distinct
  failure messages, not collapsed: unequal kinds reuse the `=`/`!=` mismatch
  message; equal kinds outside {number, date, datetime} get their own
  ordering message.
- Arithmetic (`+ - * /`, unary minus) and SUM: number operands only, plus
  four typed date-arithmetic signatures — signature-table entries, not
  coercions, since the runtime values are already serials and cost nothing
  at eval time: `date ± number → date`, `datetime ± number → datetime`,
  `date − date → number` (days), `datetime − datetime → number` (fractional
  days). This keeps `closeDate + 30` and `TODAY() - closeDate` expressible
  and preserves every deployed date formula. date and datetime never mix in
  one operation.
- `&`: text operands only.
- Condition positions (IF and IFS conditions, AND/OR/NOT operands): boolean
  only. Truthiness coercion is removed; `IF(numField, …)` must be written
  `IF(numField != 0, …)`. SWITCH's subject is not a condition — it may be any
  kind, and its case values must match it.
- Branch unification: IF/IFS result branches, SWITCH result branches, and
  IFBLANK's two arguments must share one kind, so every expression has a
  single inferable result kind. SWITCH case values must match the subject's
  kind. SWITCH/IFS desugar to nested IFs at parse time (ADR 0018), so this
  falls out of IF's own rule with no separate machinery.
- Output gate: the expression's inferred kind must match the target field's
  kind at save. A Text-format formula must infer text (use TEXT() to emit
  numbers); a numeric target must infer number; and so on.
- Kleene three-valued null logic (ADR 0017/0018) is untouched. Null
  propagation happens within the kind rules; ISBLANK still accepts any kind
  and returns boolean.

### D3 — Explicit casts are the only crossings

Three new functions in the language: **NUMBER**, **TEXT**, **DATE**.

- `NUMBER(text)` — parses numeric text to a number; non-numeric content is a
  per-record eval error (`NON_NUMERIC_VALUE`). Reuses the evaluator's
  existing `toNumber`. Cast error messages are length-bounded (80 characters,
  trailing `…`) before landing in `lastError` — this bound covers the
  **evaluator's** arithmetic and `NUMBER()` paths (`toNumber`, evaluator.ts)
  and, applied identically in Task 4, the resolver's `coerceToNumber`
  (`coercion.ts:109`), which built the same class of unbounded message on a
  separate path.
- `TEXT(value)` — canonical rendering: numbers as plain decimal, dates as
  `YYYY-MM-DD`, datetimes as ISO 8601, booleans as `true`/`false`. No
  formatting arguments in this arc. Because the runtime domain is
  `number | string | null`, the evaluator cannot tell a date serial from a
  plain number at runtime — so the kind-inference walk stamps each TEXT node
  with its argument's inferred kind (`renderAs`) at compile time, and the
  evaluator dispatches on that annotation: zero per-record cost. TEXT()
  results are not length-capped (matching the existing one-term-formula
  stance; only `&` results are capped, ADR 0026).
- `DATE("YYYY-MM-DD")` — fixed-date literal only. The argument must be a
  literal string, validated at save (an invalid or non-literal argument is a
  save error). It is **not** a general text→date cast — see Not done. A
  valid literal constant-folds to its epoch-day number node at parse time
  (the IFS/SWITCH desugaring precedent, ADR 0018), so the evaluator gains no
  new runtime case and the parse cost is paid once per compile, not per
  record.
- **Reserved-word lookahead (deliberate departure from IF/SUM precedent).**
  `NUMBER`/`TEXT`/`DATE` dispatch as functions only when the identifier is
  immediately followed by `(` — a bare `date`, `text`, or `number` stays an
  ordinary field reference, so fields with those names keep working. IF, SUM,
  and the other function keywords are hard-reserved regardless of what
  follows them; these three are not, because "date"/"text"/"number" are far
  more likely pre-existing field names than "if" or "sum" are.

### D4 — Zero shape-sniffing in the resolver; kind-directed parsing at the storage boundary

Date-shaped or numeric-shaped text is just text: in comparisons, in `&`, in
mirrors, everywhere. The **resolver** stops inferring kind from value shape —
`coerceToEngineValue`'s per-value trim plus date-shape regex pair is gone from
the per-record hot path, replaced by one kind lookup per reference.
`coerceToNumber` loses its two date-shape branches the same way; its string
branch keeps `Number(trimmed)` parsing only.

**Scope guard (F1-scope-guard — not to be confused with the unrelated
F1-empty-string bug from `verification-reports/T6-verdict.md`, which is a
separate arc queued after this one; the two share a label only by
coincidence of numbering):** shape detection is **not** removed from the
read/write boundary. `normalizeStoredValue` (`value-io.ts`) still receives
the target kind and parses stored DATE/DATE_TIME scalars by calling
`date-serial` directly — kind-directed, no pattern branch. Removing that path
entirely would break `valuesEqual` convergence and put every DATE-target
formula into an infinite rewrite loop (a write per record per sweep,
forever, plus timeline rows — the exact ADR 0022 failure mode). Net: the
boundary gets cheaper (one enum branch instead of two regex tests per stored
value), and convergence is untouched — pinned by a two-pass zero-write
convergence test for both DATE and DATE_TIME targets, guarding the
fractional-day float-identity edge specifically.

TEXT-target bare-ref formulas copy verbatim, always — the B2/B5 rewrite-in-
place of stored date-shaped values (ADR 0026) is gone. (Mechanism note: this
rewrite lived in the engine-lane resolver, not the mirror lane, which was
always a raw passthrough.)

### D5 — Enforcement architecture

- **Save time:** a static kind-inference walk over the AST
  (`src/logic-functions/lib/kind-inference.ts`) inside `validateExpressionCore`
  (`src/logic-functions/lib/validation-core.ts`), driven by field metadata for
  references, literal type for literals, and a per-function/per-operator
  signature table. Any mismatch fails the save with an error naming the
  operator and the mismatched kinds. Front and back share the gate for free,
  as they already share validation-core, and validation runs only at
  save/editor time — no hot path invokes it. The two retired pattern
  branches — 1b (string-comparison check) and 1d (bare-ref source-kind
  guard) — are subsumed by the inference walk; subsuming 1b deletes a whole
  per-save AST traversal (`collectStringComparisonRefs` and its private
  helpers), so the net save cost is one walk replacing two.
- **Unknown-kind policy:** a node whose field kind cannot be resolved has its
  constraint **skipped, never rejected** (the existing 1b/1c/1d posture). The
  server-side gate preloads kinds for every object in the expression's
  cross-record refs (all served by one cached metadata pull — zero extra
  network); **the editor keeps only its host-object kinds map.** This is a
  first-class consequence, not an incidental gap: **cross-record kind
  mismatches are an editor-accepts / server-rejects class** — the
  pre-existing divergence posture from before this ADR, now reachable by a
  new rule, since D5 types cross-record operands for the first time (the
  retired branch 1b exempted them entirely). A formula referencing a
  mismatched cross-record field can pass the editor's live check and still
  fail at actual save.
- **Compilation:** kind inference is a **per-definition compilation product,
  never per-record.** The recompute paths hoist one compiled program (AST +
  dependencies + kinds) per definition per pass and reuse it across records —
  which also pays back the pre-existing per-record re-parse waste (parse
  count per pass for a valid formula drops to exactly 1, regardless of
  record count).
- **Runtime (efficiency-review F3):** the resolver becomes kind-aware — it
  resolves each field strictly by its metadata kind, never by inspecting the
  value's shape. Kinds are resolved **once per pass / once per event** into a
  plain synchronous map and threaded into the resolver (the sweep path
  already resolves field kinds for scan selection — piggyback, zero added
  I/O; the event path resolves once per event, not per formula per record).
  This is the finding that produced Task 5's hoist: `recomputeAllRecords`
  calls `resolveKindsForFormula` exactly once before its record loop, and
  `handleRecordUpdate` builds its kinds map once per event before either of
  its two loops, matching the same once-per-definition-per-pass discipline
  compilation gets. Metadata-unavailable degradation: kind-unknown at runtime
  resolves by JS
  value type and skips kind-dependent transforms — never a hard error, so a
  metadata blip cannot error every formula in a workspace.
- The engine (`src/engine/`) stays kind-agnostic with one narrow, deliberate
  softening: the evaluator reads the compile-time `renderAs` annotation on
  TEXT nodes (D3). It never computes kinds and never sees metadata.
- Bundle note: `validation-core.ts` ships in the front-component bundle,
  whose weight is load-bearing (ADR 0024). The signature table stays a
  compact data table; no heavyweight machinery, no new dependencies.

### D6 — Legacy definitions: per-definition static gate, per-record errors only where statics can't decide

Definitions saved before this redesign whose expressions violate the new
rules are **not** migrated, grandfathered, or auto-disabled — and they are
**not scanned either**. Every new rule in D2/D3 is decidable from
`(AST, field kinds)`, both pass-invariant, so the recompute paths run the
same static gate **once per definition per pass** (the cyclic-definition
skip, `formula-sweep.ts:66-75`, is the *posture* precedent — record the
problem, skip the work — not the code shape): the error is recorded
write-avoidantly on the definition row and the record scan is skipped
entirely. This replaces an unbounded permanent tax (full scan + N
evaluations per broken definition per sweep — 387 evals/def/hour at ADR
0025's measured scale) with one static check, and surfaces the error on the
definition within one sweep instead of burying it per-record.

**The gate applies to every write path, not only the sweep.** Two
single-record call sites reach `recomputeForRecord` outside
`handleRecordUpdate` — the record-page widget's override toggle-off and its
per-record TODAY staleness refresh — and both gate on entry the same way the
sweep does, so a legacy-shaped definition like `closeDate = "2026-01-15"`
cannot silently write a wrong value through either of them while the sweep
correctly refuses. `handleRecordUpdate` gates once per event, before both its
override-detection loop and its per-formula recompute loop, so a gated
formula never turns a human edit into a spurious override row.

Per-record eval errors remain only for what statics cannot decide: cast
runtime failures (`NUMBER()` on non-numeric content) and kind-unknown
references. Eval errors produce zero record writes and zero target-record
timeline rows (existing `write: null` posture), and definition-row
bookkeeping is already write-avoidant. The sweep's heartbeat write now syncs
the in-memory definition record after each write, so a subsequent write in
the same pass sees fresh state instead of comparing against a stale
in-memory value and double-writing.

The moment the user opens the editor to fix such a definition, the save gate
explains exactly what is wrong. One semantics, no second engine.

## Consequences

- **S1: B6/H2 reversed.** `dateField = "2026-01-15"` no longer silently
  returns false — it is rejected at save (`dateField = DATE("2026-01-15")`
  is the sanctioned form). The silent flip class is gone.
- **S2: B2/B5 rewrite reversed.** Since the v0.2.0 line never deployed, the
  concrete win is avoiding a one-time write storm — N record writes plus N
  `.updated` timeline rows across every bare-ref TEXT definition whose source
  column holds date-shaped content — on the first post-deploy pass. Stored
  values stay verbatim forever.
- **S3: Numeric-text arithmetic requires an explicit cast.**
  `textField * 2` (content `"42"`) now requires `NUMBER(textField) * 2`.
  Previously-working formulas relying on lazy numeric coercion fail the
  static gate (definition-level error, no scan) until edited.
- **S4: Lone-literal and non-boolean conditions are save-rejected.**
  `IF("a", 1, 2)`, `IF(numField, …)` go from accepted (runtime error /
  truthy) to save-rejected.
- **S5: Non-text operands in `&` are save-rejected.** v0.2.0 accepted
  `isActive & ""`; this arc requires `TEXT(isActive) & ""`.
- **S6: Cross-kind `=` is save-rejected.** `42 = "42"`, `textFieldA =
  numFieldB` go from silent false (ADR 0026 B1/B4) to save-rejected; legacy
  defs hit the definition-level static gate.
- **S7: Three new functions in the language:** NUMBER, TEXT, DATE.
- **S8: date vs datetime comparisons are rejected.** Previously numerically
  comparable in principle (both are serials), they no longer are —
  `closeDate < syncedAt` and `syncedAt > TODAY()` both fail the gate.
- **S9: Per-record CPU drops on every engine-lane evaluation.** The
  resolver's per-value trim plus up to two regex executions per field
  reference per record are eliminated (replaced by one map lookup), and
  hoisted compilation removes the pre-existing per-record re-parse of the
  same expression.
- **Cross-record kind mismatches are an editor-accepts / server-rejects
  class (D5).** Recorded above as a first-class consequence, not a defect:
  the editor's live-typing feedback only ever sees the host object's kinds,
  so a cross-record mismatch can pass editor-side checking and still fail
  the real save — the same pre-existing divergence posture the app has
  always had for other server-only checks, now reachable through a new rule
  because cross-record operands were never typed before this ADR.
- **`opaque` renders differently depending on which message speaks.**
  Generic mismatch messages interpolate the bare kind label `opaque`
  (`Cannot compare opaque with text using "=" (kinds must match)`), because
  the generic path holds only a kind, not the originating field type.
  `TEXT()`'s dedicated rejection message interpolates the raw field type
  instead (`TEXT() cannot render a LINKS field`), because that call site
  still has the field in hand. Deliberate, not an inconsistency to silently
  unify.

## Not done

- **`DATE(textExpr)` as a general text→date cast.** `DATE()` stays
  literal-only this arc.
- **datetime↔date bridging.** S8 rejects `syncedAt > TODAY()` and every
  other date/datetime comparison, and — unlike S1/S3/S5, each of which ships
  a sanctioned rewrite (`DATE(...)`, `NUMBER(...)`, `TEXT(...)`) — this arc
  ships **none**. There is no `DATEVALUE(datetime)` / `DATETIME(date)`
  bridge, so a user with a legitimate "was this synced after today started?"
  formula has no expressible form until a future arc adds one. Accepted
  knowingly: the alternative (implicit widening) is exactly the silent-flip
  class S1 exists to kill.
- **Formatting arguments to TEXT()** (Excel-style format strings).
- **Any truthiness escape hatch or lint-level "warn instead of reject" mode.**
- **Migration tooling for legacy definitions.** The definition-level gate
  error plus editor explanation is the story; the pre-deploy blast-radius
  audit (`scripts/audit-strict-gate.ts`) tells us whether that stance holds
  at real scale before cloud deploy.
- **SELECT output.** Still the explicitly designated next-version feature,
  unaffected by this arc (ADR 0026's closing section).
- **formulahelp reference refresh.** Gated on deploy, separate approval —
  not part of this arc.
- **Note (disambiguation):** this ADR's D4 "F1-scope-guard" and the
  unrelated **F1-empty-string** bug named in `verification-reports/T6-verdict.md`
  are two different items that happen to share a label by coincidence of
  numbering. F1-empty-string is a separate, later arc.

## Testing

- Unit pins per rule in D2/D3: save-gate acceptance and rejection cases per
  operation, cast behaviors including cast runtime errors, branch
  unification, output gate per target kind (`kind-inference.spec.ts`,
  `validation-core.spec.ts`).
- Existing specs pinning B2/B6 behavior (`coercion.spec.ts`,
  `evaluator.spec.ts`, `recompute.spec.ts`) were rewritten to pin the new
  semantics — reversals made test-visible, called out per-task in the
  execution ledger.
- Legacy-doctrine test: an expression that predates the gate is skipped by
  the sweep with a single write-avoidant definition-level error and no
  record scan (cyclic-skip parity); a cast runtime failure produces the
  standard per-record error with `write: null` and keeps converging.
- Convergence pin for D4's scope guard: a DATE-target and a DATE_TIME-target
  formula whose computed value equals the stored value perform zero writes
  across two consecutive passes (the anti-rewrite-loop test, guarding the
  fractional-day float-identity edge for DATE_TIME specifically).
- Hot-path pins: `validateExpressionCore`/`validateFormula` are never called
  from the recompute paths (a static grep assertion); compilation and kind
  resolution happen once per definition per pass (call-count pins, not
  timings).
- Pre-deploy blast-radius audit (read-only, zero writes):
  `scripts/audit-strict-gate.ts` runs the inference offline over every
  enabled deployed definition and produces the list of gate failures, so the
  deploy ships with a known — not guessed — population of definition-level
  errors. A dev-remote run found 4 enabled formulas: 3 PASS, 1 GATED (a
  BOOLEAN concatenated into a TEXT target via `&`, correctly caught).
- A short live verification pass (T3-style seed + observe) is still pending
  before cloud deploy, focused on: mirror verbatim behavior over date-shaped
  content, DATE-target convergence (no rewrite loop), legacy-def gate
  surfacing, and the save gate in the wizard editor — see the implementation
  plan's "Post-plan gates."

## Versioning and sequencing

v0.3.0. Zero schema changes. After this ships and live-verifies, the held
cloud deploy proceeds (deploying v0.3.0 semantics directly — the v0.2.0 line
never deploys alone, per user ruling). Then: the F1-empty-string
investigation (the T6-verdict bug, distinct from D4's F1-scope-guard above),
then the SELECT output arc.
