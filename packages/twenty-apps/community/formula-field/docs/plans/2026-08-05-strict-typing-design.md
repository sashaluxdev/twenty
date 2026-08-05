# Strict kind typing — design

Date: 2026-08-05. Status: approved by user (interactive brainstorm, eight decisions locked), then
amended per an opus efficiency review adjudicated with the user (decisions 9-10 in the log).
Standing principle governing this and all formula-app design: **every operation pays rent** —
efficiency is a substrate-level design priority; each section below states what it costs per-save,
per-record, per-sweep, or per-event.
Supersedes: ADR 0026 decisions B2 (eager date-coercion of text content) and B6 (silent cross-kind
comparison flip), plus the lazy numeric coercion B3 preserved in arithmetic. Will become ADR 0027
when the implementation arc completes, per the 0026 precedent.

## Context

Live verification of v0.2.0 (2026-08-04, `verification-reports/T6-verdict.md`) surfaced two deltas
the user rejected as design: B6/H2 (a DATE value or date-shaped text compared `=` against a text
literal silently returns false, with no save-time signal) and, underlying it, B2 (the engine treats
date-shaped-and-valid TEXT content as a date in every context). The user ruling: the engine should
never treat date-shaped text as a date; comparisons must be strictly kind-matched; cloud deploy of
the v0.2.0 line is held until this ships so the deployed semantics are the intended ones.

ADR 0026's Not-done section pre-named the starting point ("kind-aware field resolution"). This
design goes further than that escape hatch: during the brainstorm the user chose full strictness
across the whole language, not just comparisons.

## Decisions

### D1 — Kind lattice

Five kinds, assigned statically to every AST node:

| Kind | Sources |
|---|---|
| number | NUMBER and CURRENCY fields, numeric literals, arithmetic results, SUM, NUMBER() |
| date | DATE fields, TODAY(), DATE("YYYY-MM-DD") |
| datetime | DATE_TIME fields |
| text | TEXT and SELECT fields, string literals, `&` results, TEXT() |
| boolean | BOOLEAN fields, comparison results, AND/OR/NOT, ISBLANK |

date and datetime are distinct kinds; comparing them to each other is a mismatch. CURRENCY keeps
its current numeric resolution (no semantic change; the implementation plan pins the exact unit).

### D2 — One rule: kinds must match the operation

- `=` / `!=`: both sides the same kind. Any kind may participate (boolean = boolean is legal).
- Ordering (`<`, `<=`, `>`, `>=`): both sides the same kind, and only number, date, or datetime.
  Text and boolean ordering is rejected.
- Arithmetic (`+ - * /`, unary minus) and SUM: number operands only, plus four typed
  date-arithmetic signatures (these are signature-table entries, not coercions — the runtime
  values are already serials, so they cost nothing at eval time):
  `date ± number → date`, `datetime ± number → datetime`, `date − date → number` (days),
  `datetime − datetime → number` (fractional days). This keeps `closeDate + 30` and
  `TODAY() - closeDate` expressible and preserves every deployed date formula. date and datetime
  never mix in one operation.
- `&`: text operands only.
- Condition positions (IF and IFS conditions, AND/OR/NOT operands): boolean only. Truthiness
  coercion is removed; `IF(numField, …)` must be written `IF(numField != 0, …)`. SWITCH's subject
  is not a condition — it may be any kind, and its case values must match it (next bullet).
- Branch unification: IF/IFS result branches, SWITCH result branches, and IFBLANK's two arguments
  must share one kind, so every expression has a single inferable result kind. SWITCH case values
  must match the subject's kind.
- Output gate: the expression's inferred kind must match the target field's kind at save. A
  Text-format formula must infer text (use TEXT() to emit numbers); a numeric target must infer
  number; and so on.
- Kleene three-valued null logic (ADR 0017/0018) is untouched. Null propagation happens within the
  kind rules; ISBLANK still accepts any kind and returns boolean.

### D3 — Explicit casts are the only crossings

- `NUMBER(text)` — parses numeric text to a number; non-numeric content is a per-record eval error.
  Implementation reuses the evaluator's existing `toNumber` unchanged. Cast error messages must be
  length-bounded before landing in `lastError` (no unbounded record content in messages).
- `TEXT(value)` — canonical rendering: numbers as plain decimal, dates as `YYYY-MM-DD`, datetimes
  as ISO 8601, booleans as `true`/`false`. No formatting arguments in this arc. Because the runtime
  domain is `number | string | null`, the evaluator cannot tell a date serial from a number at
  runtime — so the kind-inference walk stamps each TEXT node with its argument's inferred kind
  (`renderAs`) at compile time and the evaluator dispatches on that annotation: zero per-record
  cost. TEXT() results are not length-capped (matching the existing one-term-formula stance; only
  `&` results are capped).
- `DATE("YYYY-MM-DD")` — fixed-date literal only. The argument must be a literal string, validated
  at save (an invalid or non-literal argument is a save error). It is not a general text→date cast.
  A valid literal constant-folds to its epoch-day number node at parse time (IFS/SWITCH desugaring
  precedent), so the evaluator gains no new case and the parse cost is paid once per compile, not
  per record.

### D4 — Zero shape-sniffing in the resolver; kind-directed parsing at the storage boundary

Date-shaped or numeric-shaped text is just text: in comparisons, in `&`, in mirrors, everywhere.
The **resolver** stops inferring kind from value shape — `coerceToEngineValue`'s per-value trim +
date-shape regex pair disappears from the per-record hot path, replaced by one kind lookup per
reference.

Scope guard (efficiency review F1): shape detection is NOT removed from the read/write boundary.
`normalizeStoredValue` already receives the target kind and must parse stored DATE/DATE_TIME
scalars by calling `date-serial` directly (kind-directed, no pattern branch) — removing that path
entirely would break `valuesEqual` convergence and put every DATE-target formula into an infinite
rewrite loop (a write per record per sweep, forever, plus timeline rows — the exact ADR 0022
failure mode). Net: the boundary gets cheaper (one enum branch instead of two regex tests per
stored value), and convergence is untouched.

TEXT-target bare-ref formulas copy verbatim, always — the B2/B5 rewrite-in-place of stored
date-shaped values is gone. (Mechanism note: this rewrite lived in the engine-lane resolver, not
the mirror lane; the mirror lane was always a raw passthrough.)

### D5 — Enforcement architecture

- Save time: a static kind-inference walk over the AST inside `validateExpressionCore`
  (`src/logic-functions/lib/validation-core.ts`), driven by field metadata for references, literal
  type for literals, and a per-function signature table. Any mismatch fails the save with an error
  naming the node and the expected vs actual kind. Front and back share the gate for free, as they
  already share validation-core, and validation runs only at save/editor time — no hot path
  invokes it. Existing pattern branches (1b string-comparison check, 1d bare-ref guard) are
  subsumed where the inference walk covers them; subsuming 1b deletes a whole per-save AST
  traversal, so the net save cost is one walk replacing two. Orthogonal guards stay.
- Unknown-kind policy: a node whose field kind cannot be resolved has its constraint **skipped,
  never rejected** (the existing 1b/1c/1d posture). The server-side gate preloads kinds for every
  object in the expression's cross-record refs (all served by one cached metadata pull — zero
  extra network); the editor keeps its host-object map, so the only possible divergence is
  server-rejects-what-editor-accepted, which is the pre-existing posture.
- Compilation: kind inference is a **per-definition compilation product, never per-record**. The
  recompute paths hoist one compiled program (AST + dependencies + kinds) per definition per pass
  and reuse it across records — which also pays back today's per-record re-parse waste.
- Runtime: the resolver becomes kind-aware — it resolves each field strictly by its metadata kind,
  never by inspecting the value's shape. Kinds are resolved **once per pass / once per event**
  into a plain synchronous map and threaded into the resolver (the sweep path already resolves
  field kinds for scan selection — piggyback, zero added I/O; the event path resolves once per
  event, not per formula per record). Metadata-unavailable degradation: kind-unknown at runtime
  resolves by JS value type and skips kind-dependent transforms — never a hard error, so a
  metadata blip cannot error every formula in a workspace.
- The engine (`src/engine/`) stays kind-agnostic with one narrow, deliberate softening: the
  evaluator reads the compile-time `renderAs` annotation on TEXT nodes (D3). It never computes
  kinds and never sees metadata.
- Bundle note: validation-core ships in the front-component bundle, whose weight is load-bearing
  (ADR 0024). The signature table stays a compact data table; no heavyweight machinery.

### D6 — Legacy definitions: per-definition static gate, per-record errors only where statics can't decide

Definitions saved before this redesign whose expressions violate the new rules are not migrated,
grandfathered, or auto-disabled — and they are not scanned either. Every new rule in D2/D3 is
decidable from (AST, field kinds), both pass-invariant, so the recompute paths run the same static
gate **once per definition per pass** (the existing cyclic-definition skip is the exact precedent
and mechanism): the error is recorded write-avoidantly on the definition row and the record scan
is skipped entirely. This replaces an unbounded permanent tax (full scan + N evaluations per
broken definition per sweep — 387 evals/def/hour at ADR 0025's measured scale) with one static
check, and surfaces the error on the definition within one sweep instead of burying it per-record.

Per-record eval errors remain only for what statics cannot decide: cast runtime failures
(NUMBER() on non-numeric content) and kind-unknown references. Eval errors produce zero record
writes and zero target-record timeline rows (existing `write: null` posture, verified), and
definition-row bookkeeping is already write-avoidant. Known wrinkle to fix in implementation: the
sweep's first-error write currently double-writes the definition row against a stale in-memory
value; return the written error from the scan (one line) so a newly-broken definition costs one
write, once.

The moment the user opens the editor to fix such a definition, the save gate explains exactly what
is wrong. One semantics, no second engine.

## Consequences — visible deltas vs v0.2.0

- S1: B6/H2 reversed. `dateField = "2026-01-15"` no longer silently returns false — it is rejected
  at save (`dateField = DATE("2026-01-15")` is the sanctioned form). The silent flip class is gone.
- S2: B2/B5 rewrite reversed. Since the v0.2.0 line never deployed, the concrete win is avoiding a
  one-time write storm — N record writes plus N `.updated` timeline rows across every bare-ref
  TEXT definition whose source column holds date-shaped content — on the first post-deploy pass.
  Stored values stay verbatim forever. (Mechanism was the engine-lane resolver, not the mirror
  lane.)
- S3: Numeric-text arithmetic (`textField * 2` with content "42") now requires
  `NUMBER(textField) * 2`. Previously-working formulas relying on lazy numeric coercion fail the
  static gate (definition-level error, no scan) until edited.
- S4: Lone-literal and non-boolean conditions (`IF("a", 1, 2)`, `IF(numField, …)`) go from
  accepted (runtime error / truthy) to save-rejected.
- S5: Non-text operands in `&` (v0.2.0 accepted `isActive & ""`) are save-rejected; write
  `TEXT(isActive) & ""`.
- S6: Cross-kind `=` (`42 = "42"`, `textFieldA = numFieldB`) goes from silent false (B1/B4) to
  save-rejected; legacy defs hit the definition-level static gate.
- S7: Three new functions in the language: NUMBER, TEXT, DATE.
- S8: date vs datetime comparisons, previously numerically comparable in principle, are rejected.
- S9: Per-record CPU drops on every engine-lane evaluation: the resolver's per-value trim plus up
  to two regex executions per field reference per record are eliminated (replaced by one map
  lookup), and hoisted compilation removes today's per-record re-parse of the same expression.

## Not done (named for future arcs)

- `DATE(textExpr)` as a general text→date cast.
- Formatting arguments to TEXT() (Excel-style format strings).
- Any truthiness escape hatch or lint-level "warn instead of reject" mode.
- Migration tooling for legacy definitions (the definition-level gate error + editor explanation
  is the story; the pre-deploy blast-radius audit tells us whether that stance holds at real scale).

## Testing

- Unit pins per rule in D2/D3: save-gate acceptance and rejection cases per operation, cast
  behaviors including cast runtime errors, branch unification, output gate per target kind.
- Existing specs pinning B2/B6 behavior (`coercion.spec.ts`, `evaluator.spec.ts`,
  `recompute.spec.ts`) are updated to pin the new semantics — these edits are the reversal made
  test-visible and must be called out in review.
- Legacy-doctrine test: an expression that predates the gate (injected below the save path) is
  skipped by the sweep with a single write-avoidant definition-level error and no record scan
  (cyclic-skip parity); a cast runtime failure produces the standard per-record error with
  `write: null` and keeps converging.
- Convergence pin for D4's scope guard: a DATE-target formula whose computed value equals the
  stored value performs zero writes across two consecutive passes (the anti-rewrite-loop test).
- Hot-path pins: `validateExpressionCore` is never called from recompute paths; compilation and
  kind resolution happen once per definition per pass (assert call counts, not timings).
- Pre-deploy blast-radius audit (read-only, zero writes): run the inference offline over every
  deployed definition and produce the list of gate failures, so the deploy ships with a known —
  not guessed — population of definition-level errors. Script under `scripts/`, existing offline
  precedent.
- A short live verification pass (T3-style seed + observe) before cloud deploy, focused on: mirror
  verbatim behavior over date-shaped content, DATE-target convergence (no rewrite loop),
  legacy-def gate surfacing, and the save gate in the wizard editor.

## Versioning and sequencing

v0.3.0. Zero schema changes. After this ships and live-verifies, the held cloud deploy proceeds
(deploying v0.3.0 semantics directly — the v0.2.0 line never deploys alone, per user ruling).
Then: F1 empty-string investigation, then the SELECT output arc.

## Decision log (brainstorm, 2026-08-05)

1. Kind mismatch in comparisons → reject at save time.
2. Legacy mismatching definitions → per-record eval error (no grandfathering, no auto-disable).
3. Strictness scope → full strict everywhere (arithmetic and conditions included), not
   comparisons-only.
4. Casts shipping this arc → NUMBER(text) and TEXT(value); DATE stays literal-only.
5. Condition positions → boolean-kind only.
6. Architecture → static inference pass in validation-core; engine stays kind-agnostic.
7. `&` → text-kind only, casts explicit.
8. Design presented as a whole and approved.
9. (Post-review, user-adjudicated) Typed date-arithmetic signatures added: date ± number,
   datetime ± number, date − date, datetime − datetime. Zero runtime cost; preserves deployed
   date formulas.
10. (Post-review, user-adjudicated) Legacy enforcement moved from per-record eval errors to a
    per-definition static gate with scan skip (cyclic-skip precedent); per-record errors reserved
    for statically-undecidable failures. Driven by the opus efficiency review (findings F1-F12),
    which also produced the D4 scope guard, hoisted compilation, once-per-pass kind resolution,
    the unknown-kind skip policy, TEXT `renderAs` annotation, and DATE() constant folding.
11. (Implementation-plan review, user-adjudicated) NUMBER/TEXT/DATE are reserved only when
    immediately followed by "(" — a bare `date`/`text`/`number` stays a field reference, so
    fields with those names keep working. Deliberate departure from the hard-reserved IF/SUM
    precedent.
12. (Implementation-plan review) The kind lattice gains `opaque` for known-but-non-lattice field
    types (LINKS, MULTI_SELECT, ADDRESS, RATING, ...): opaque mismatches every operation,
    preserving the save-time rejections the retired pattern branches 1b/1d provided; `unknown`
    (metadata unavailable) still skips. Without this, retiring 1b/1d would have silently
    loosened validation.
