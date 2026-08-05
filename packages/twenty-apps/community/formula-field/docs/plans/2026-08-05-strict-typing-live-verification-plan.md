# Strict Typing Live Verification Phase (v0.3.0)

**Status:** AMENDED per design review (opus code-cross-referencing pass, 2026-08-05) — pending
user approval
**Branch under test:** `strict-typing` at `49eff11edd` (20 commits off local main `3e2be6f670`)
**Environment:** local dev stack; dev workspace schema `workspace_1wgvd1injqtife6y4rvfbu3h5`;
the workspace currently runs app version **0.2.0** (`core.application`) — load-bearing, see P0.
**Companion reference:** `2026-08-05-strict-typing-live-surface-inventory.md` (same directory)
— exact templates, DB state, observability facts. Read its CORRECTIONS section FIRST; it
overrides the body where they conflict. Where this plan and code disagree, re-derive from code.

## Purpose and doctrine

The unit/integration suite (1184 tests) proves the logic against a mocked client. This phase
proves the same semantics through the REAL stack: the deployed app in the dev workspace, the
GraphQL/REST client, the DB trigger pipeline, the hourly sweep cron, and the wizard/editor in a
real browser. Every check is empirical: **seed → act → observe a concrete artifact**. No check
passes on the absence of an error alone; every check names its observable AND its failure
signature, and every "the pass ran" claim has a positive witness (see the perturbation
protocol) — a vacuous pass is structurally impossible.

Rigor mirrors the implementation arc: per-phase evidence reports audited by an opus evidence
auditor against raw artifacts; FINDINGs enter a fix loop where fixes are re-verified live and
fixes-to-fixes re-verified again; orchestration by workflows (haiku/sonnet executors, opus
judges; never fable), controller adjudicating between phases.

## Load-bearing mechanics (from the design review — executors must internalize these)

1. **Save is asynchronous validation.** An API create/update with a violating expression
   SUCCEEDS at the mutation layer; `handle-formula-change` (DB-trigger logic function) then
   writes `enabled: false` + `lastError` to the row. The api-lane rejection observable is:
   poll the row until `lastError` byte-equals the expected string AND `enabled = false`
   (timeout 60s; fail-sig: row unchanged).
2. **Every non-bookkeeping save re-validates.** A touch-save of a gate-FAILING definition
   exercises the save gate (and disables the row — destroying the fixture), NOT the D6
   recompute gate. Touch-saves may only be used as pass triggers for gate-PASSING definitions.
   The D6 recompute gate is observable only via: the hourly sweep, the event path, or
   `recomputeForRecord` (widget override toggle-off / TODAY refresh).
3. **No gate-failing definition can be saved under 0.3.0.** Legacy gated fixtures can only be
   created BEFORE the deploy, against the installed 0.2.0 app (whose validation checks only
   same-record string comparisons). This inverts the phase order: seeding precedes deploy.
4. **Write-avoidance means a converged pass writes nothing** — not even `lastEvaluatedAt`
   (heartbeat writes only on value/error change, except a TODAY-staleness carve-out).
   **Perturbation protocol** (the standard pass witness): perturb the formula's target value
   via API using a token with NO workspace-member actor (no override row results, since
   override detection requires `actorWorkspaceMemberId`); a pass that ran RESTORES the value;
   a pass that didn't leaves it perturbed. Record value + record `updatedAt` are the witness.
5. **The wizard never submits an expression on the engine path** (it creates the field + an
   expressionless definition; the editor is the pre-save surface). The wizard cannot display a
   save-gate rejection — it has no channel to the async trigger. Wizard checks are handoff
   checks, not gate checks.
6. **Remote pinning:** `~/.twenty/config.json` has `defaultRemote: "cloud"` (PRODUCTION).
   Every CLI/script invocation in this phase MUST pass the remote explicitly (`-r dev` /
   `dev` arg). An unqualified invocation targets production — treat as an incident, stop.
7. **Front cache:** after any deploy, the frontend serves stale front-component code from
   IndexedDB (`twenty-front-metadata-store`); hard-refresh/clear before judging any UI
   behavior.
8. **Editor save is two-click** (arm, then confirm within 5s), and an editor save always sends
   `enabled: true` (re-enables a disabled definition).
9. **Deployed-version discipline:** `SELECT version FROM core.application WHERE name =
   'Formula Field'` must equal the branch `package.json` version at every evidence capture;
   the evidence auditor re-checks this per phase. After any code fix: redeploy, re-verify
   version, hard-refresh — a re-run against stale deployed code is evidence of nothing.
10. **Timeline rows:** the app's `timeline-cleanup` cron soft-deletes formula noise every 10
    minutes; timeline observables must be read within that window (or rely on record-write
    absence, which already implies no platform timeline row).
11. **Test runner in this environment:** `node <repo>/node_modules/vitest/vitest.mjs run`
    (README ops note; `npx vitest` is not the working path here).

## Ground rules

1. **Fixtures:** display name `LV3.<check-id> - <description>` (provenance legible from a DB
   dump). Pre-existing residue (6 definitions + 2 overrides, inventoried) is snapshot in P0
   and never modified — with ONE deliberate exception: T4 Text Greeting is the natural
   first-gating subject (P3.1); its `lastError` and `lastValueText` changes are intended
   permanent deltas, listed in P7. T5 rows stay untouched entirely.
2. **Concurrency:** the browser is a singleton → UI checks serial. API/DB checks parallel only
   on disjoint definitions/records. The sweep is GLOBAL — the P3.5 cron-tick window is
   exclusive: no other mutations during it, all definition rows snapshot before it.
3. **Out of scope** (ADR 0027 Not-done): `DATE(textExpr)`, TEXT() format args, datetime↔date
   bridging, migration tooling, SELECT output, formulahelp refresh, truthiness escape hatches.
   The **F1-empty-string** bug (empty-string TEXT dependency reverting to NULL via API/event
   path — known pre-existing, unrelated to any S-rule) is not tested and not fixed here; if
   its symptoms appear, record under "known-issue sightings" and continue.
4. **Evidence:** `verification-reports/2026-08-05-strict-typing-live/` (untracked):
   `P<N>-report.md` + raw artifacts. Committed verdict archive at P7.
5. **Suite parity:** after any code fix, full vitest suite green before live re-verification.
6. **Verdicts:** `PASS` / `EXPECTED-DELTA (ADR cite)` / `FINDING`. Only FINDINGs enter the fix
   loop.

## Check format

```
id / surface / seed / act / observe (exact copy or value) / fail-sig / lane (ui|api|sweep) / evidence
```

## Authoritative error strings

Templates (byte-verified against kind-inference.ts, parser.ts, evaluator.ts by the design
review). **Surface prefix rule:** parse errors display as `PARSE_ERROR: <message>` at both
save surfaces (validation-core prefixes `${code}: ${message}`); kind-inference messages
display bare. The output-gate suggestion carries a LEADING space. P1's check specs must state
the fully-instantiated literal string per fixture (executors never instantiate templates).

| Violation | Template |
|---|---|
| `=`/`!=` unequal kinds (S1/S6/S8) | `Cannot compare ${left} with ${right} using "${op}" (kinds must match)` |
| Ordering on equal-but-unorderable kinds | `Cannot order ${left} values with "${op}"` |
| Arithmetic mismatch (S3) | `Cannot apply "${op}" to ${left} and ${right}` |
| Unary `-` on non-number | `Cannot apply unary "${op}" to ${kind}` |
| SUM arg not number | `SUM args must be number, got ${kind}` |
| `&` non-text part (S5) | `"&" joins text; wrap ${kind} values in TEXT()` |
| Condition non-boolean (S4) | `Condition must be a comparison or boolean field, got ${kind}` |
| Branch disagreement | `IF branches disagree: ${a} vs ${b}` |
| Output gate | `Formula computes ${kind} but the target field holds ${expected}` + ` Wrap it in TEXT(...) to fix this.` iff expected=text (leading space) |
| NUMBER() operand not text | `NUMBER() takes text, got ${kind}` |
| TEXT() on opaque | `TEXT() cannot render a ${RAW_FIELD_TYPE} field` |
| DATE() misuse | save surfaces: `PARSE_ERROR: DATE() requires a literal "YYYY-MM-DD" date`; recompute path: bare |
| NUMBER() runtime non-numeric | `NON_NUMERIC_VALUE: Text value is not numeric ("…"≤80ch)` |

## Phases

### P0 — Preflight, pre-deploy seeding, deploy, baseline (BLOCKING for everything)

- **P0.1 Stack up** from the worktree: server (healthz 200), **worker** (cron registration),
  front (record page loads; cache cleared).
- **P0.2 Field provisioning** (the workspace lacks what P2 needs): on `pet`: two DATE fields,
  one DATE_TIME, dedicated NUMBER and TEXT target fields for LV3 definitions (no collisions
  with T2's `pet.age`), and one TEXT field literally named `date` (for the reserved-word
  lookahead control). All listed for P7 teardown.
- **P0.3 PRE-DEPLOY LEGACY SEEDING (one-time opportunity — dev runs 0.2.0, whose validation
  accepts these):** create the gate-failing fixtures the D6 checks need, one per class:
  S3 arithmetic (`textField * 2`), S4 condition (`IF(numField, …)`), S5 concat
  (`isGoodWithKids & ""` shape beyond the existing T4 one), S8 date-vs-datetime compare,
  output-gate (number expr onto TEXT target), and the cross-record S1 form
  (`crossRef.textField = "2026-01-15"` — 0.2.0's check exempts cross-refs; this fixture
  doubles as P4.4's seed). Verify each SAVED and enabled under 0.2.0. Also seed one
  TODAY()-using gate-PASSING fixture (the cron witness + P5.4 subject).
- **P0.4 Deploy 0.3.0:** `node <repo>/node_modules/twenty-sdk/dist/cli.cjs dev --once` from
  the app dir with the remote pinned to `dev` (mechanic #6). Gate artifact:
  `core.application.version` = branch package.json version (0.3.0). Hard-refresh front.
- **P0.5 Baseline snapshot:** full `_formulaDefinition` dump (now 6 residue + P0.3 seeds),
  `_formulaOverride` (2 rows), timeline table row count (table confirmed to exist in this
  schema). Teardown diff-reference.
- **P0.6 Baseline audit:** `npx tsx scripts/audit-strict-gate.ts dev` — expect the P0.3 seeds
  GATED alongside T4 Text Greeting; T2/controls PASS.
- **Gate to P1:** all P0 checks PASS. P0 failures are environment fixes, never code fixes.

### P1 — Save-gate matrix (workflow: 4-6 executors + 1 opus judge)

Each rejection rule on both live surfaces, exact literal strings stated per check spec:

- **Editor (ui):** typing the violating expression shows `liveError` inline (client-side,
  pre-network) with the literal string; Save disabled.
- **API (api):** async rejection per mechanic #1 (poll to `enabled:false` + byte-equal
  `lastError`).
- **Acceptance controls (api):** each rule's sanctioned rewrite saves, stays enabled, and
  computes the expected value INTO a record (asserted on the record row).

Checks: P1.1-P1.6 = S1 (`birthday = "2026-01-15"` → literal: `Cannot compare date with text
using "=" (kinds must match)`; control `birthday = DATE("2026-01-15")`), S3, S4, S5, S6, S8 —
each ui + api + control. P1.7 output gate incl. the leading-space suggestion; blank-target
skip control via API create with `targetFieldType: ''` (the only reachable seed — UI always
sets a type). P1.8 `NUMBER(numericField)` → `NUMBER() takes text, got number`. P1.9
`TEXT(pictures)` → `TEXT() cannot render a LINKS field`. P1.10 `DATE(shortNotes)` →
`PARSE_ERROR: DATE() requires a literal "YYYY-MM-DD" date` (prefix rule). P1.11 system-field
parity (carry-forward #2): `IF(createdAt > TODAY(), 1, 0)` onto NUMBER → literal:
`Cannot compare datetime with date using ">" (kinds must match)` — inline as typed AND via
api lane. P1.12 cross-record divergence (ADR 0027 D5, EXPECTED-DELTA): cross-object kind
mismatch passes editor live-validate, async-rejected at real save — assert both halves, cite
the ADR. P1.13 boundary controls (design-review N1): dotted subpath (`price.currencyCode`
ref) infers unknown → saves (skip-never-reject); bare field named `date` resolves as a field
reference (lookahead: only `DATE(` dispatches as a function).

### P2 — Runtime semantics on real records (workflow: 3-5 executors + 1 opus judge)

- P2.1-P2.4 TEXT rendering by kind on TEXT targets: `TEXT(dateField)` → `YYYY-MM-DD` (not the
  serial), `TEXT(dateTimeField)` → ISO 8601, `TEXT(booleanField)` → `true`/`false`,
  `TEXT(numberField)` → canonical decimal.
- P2.5 `NUMBER(zipText) + 1` computes. P2.6 `NUMBER(garbage)` → per-record `write: null`
  (record untouched, no timeline row within the 10-min window), definition STAYS ENABLED
  (discriminator: only the save path disables), other records converge; `lastError` carries
  the bounded NON_NUMERIC_VALUE excerpt.
- P2.7 `DATE("2026-01-15")` comparison drives IF correctly on records either side.
- P2.8 Date arithmetic on the provisioned fields: `dateA + 7` onto a DATE target (distinct
  from source — self-target is a cycle), `dateA - dateB` onto NUMBER (day count), DATE_TIME
  variants.
- P2.9 Convergence (anti-rewrite-loop): perturbation protocol — perturb target (no actor),
  touch-save-trigger a pass (gate-passing def), observe RESTORE (witness); second pass:
  record `updatedAt` AND definition row entirely stable — a converged pass writes NOTHING.
  DATE and DATE_TIME targets.
- P2.10 Date-shaped text is text (S2/D4, EXPECTED-DELTA — the old H2 known-delta is now
  defined behavior): LV3 clone of the T5-demo-1 shape (`textField = "2026-01-15"` comparison)
  against an LV3 target — saves (legal text comparison), computes correctly. T5 demo 1 itself
  stays untouched.
- P2.11 Text passthrough on TEXT target (corrected from "mirror lane" by the design review:
  TEXT is NOT mirrorable; the T2 `outputFormat:'mirror'` row actually runs the engine lane):
  a bare text ref onto a TEXT target passes date-shaped content through byte-identically, and
  the existing overrides still pin. NOTE: the workspace has zero true mirror-lane
  definitions; mirror-lane behavior is out of this phase's live scope (unchanged by ADR
  0027 — MIRRORABLE_KINDS ∩ ENGINE_FAMILY = ∅ is unit-pinned).

### P3 — D6 gate on legacy definitions (sweep/event/widget paths only — never touch-save a gated fixture)

- P3.1 **T4 Text Greeting first-gating:** first 0.3.0 pass over it (cron tick or a pet-record
  event) writes the GATED error (`"&" joins text; wrap boolean values in TEXT()`) to
  `lastError`; `lastValueText` goes null (both = intended permanent deltas, P7-listed).
  Target `pet.t4TextGreeting` values untouched.
- P3.2 P0.3 legacy seeds gate on their first pass: definition-row error per seed (literal
  strings from the table), ZERO record writes for them (targets + record `updatedAt`
  untouched vs the P0.5 snapshot).
- P3.3 Heartbeat write-avoidance on a gated definition: pass 2 writes NOTHING (`lastError`
  AND `lastEvaluatedAt` both identical). Pass-ran witness: a sibling gate-passing
  definition's perturbation restore in the same sweep.
- P3.4 Recovery (D6 UX story): fix one gated seed in the editor (S1→`DATE(...)` rewrite;
  two-click save; save re-enables per mechanic #8) → error clears → records compute on the
  next pass.
- P3.5 Real cron tick (exclusive window, all rows snapshot before): the TODAY()-fixture with
  backdated `lastEvaluatedAt` (bookkeeping-only API update — short-circuits validation)
  refreshes on the tick without any manual trigger; gated fixtures stay byte-stable.

### P4 — Event path & overrides (workflow: 3-4 executors + 1 opus judge)

- P4.1 Affected event: update a dependency field → recompute lands promptly with P2-correct
  rendering.
- P4.2 Unaffected event (fix-wave [B] lazy gate) — perturbation-discriminated: perturb the
  target (no actor); fire an UNAFFECTED event (unrelated field, same object) → value STAYS
  perturbed (no recompute ran — the positive witness of absence); then fire an AFFECTED
  event → value restored (pipeline-works discriminator). DB evidence only; log lines are
  unconfirmed at INFO and must not carry the check.
- P4.3 Override detection: human-actor edit of a formula's target field → `_formulaOverride`
  row (`overrideValueText` for TEXT lane), formula stops writing that record; a gate-PASSING
  definition still creates overrides.
- P4.4 Carry-forward #1: the P0.3 cross-record S1 seed — fire an event on the referenced
  object's records → the cross-object definition (excluded from the event's gate map by
  construction) reaches `recomputeAllRecords`, which gates it: definition-row error written,
  zero record recomputes. (Mechanism verified sound by the design review; the seed is the
  pre-deploy fixture.)

### P5 — Editor & wizard UX (serial ui lane: 1-2 executors + 1 opus judge)

- P5.1 Autocomplete: `NUM`/`TEX`/`DAT` surface the new entries with exact labels; insertText
  lands (`DATE` inserts the opening quote: `DATE("`).
- P5.2 Error copy renders fully in the editor (no truncation; sentence case; kinds named).
- P5.3 Gated-definition surfacing: `definition.lastError` renders in the editor when no
  `liveError` (precedence rule) — the "user learns via the definition row" half of D6.
- P5.4 Carry-forward #3 (stale-widget): the P0.3 TODAY()-fixture, `lastEvaluatedAt` backdated
  >2.5h → visit the FormulaDefinition page (the one surface passing `sweepAllRecords: true`)
  → refresh fires; widget does NOT render stale values after the heartbeat mutates React-held
  definitions (screenshot before/after). Document the 60s module-global throttle so a re-run
  isn't misread as failure.
- P5.5 Wizard handoff (replaces the impossible wizard-rejection check): wizard creates field +
  expressionless definition; editor is where the expression is entered and validated — assert
  the handoff lands and the editor's live gate covers it (pairs with P1.11's ui half).

### P6 — Audit-vs-live consistency (1-2 executors)

- P6.1 Re-run `audit-strict-gate.ts dev`: every GATED verdict maps to live-observed gating
  (P3/P4), every PASS to live-observed computation (P1/P2). **Population caveat:** the audit
  walks enabled definitions only; P1's api-lane rejects end disabled and are invisible to it
  by construction — the mapping covers P0.3 legacy seeds + acceptance controls + residue.

### P7 — Teardown & verdict archive (controller + 1 executor)

- P7.1 Delete all LV3 definitions, records, overrides AND the P0.2 provisioned fields; T5
  rows verified untouched; post-teardown snapshot + audit diff vs P0.5 — only the listed
  intended deltas: T4 Text Greeting `lastError` (gate error) + `lastValueText` (null), plus
  any P3.4-recovered seed left enabled-and-valid (delete those too).
- P7.2 Verdict archive committed to `docs/plans/2026-08-05-strict-typing-live-verdict.md`:
  check table (id, verdict, evidence pointer), fix-loop history, known-issue sightings,
  residue map. Evidence reports stay untracked.

## Review passes (per phase)

Opus evidence auditor per phase: verify every PASS/EXPECTED-DELTA against its raw artifact
(re-derive ≥2 checks per phase from the artifact, not the report); flag vacuous evidence;
confirm `core.application.version` matched the branch at capture time (mechanic #9); verdict
each check CONFIRMED / EVIDENCE-INSUFFICIENT / FINDING. EVIDENCE-INSUFFICIENT → executor
re-captures; **a re-capture that changes the verdict escalates to FINDING** (failures are
never laundered as capture problems).

## Fix loop (checks → fixes checked → fixes-to-fixes checked)

Max 3 rounds per FINDING, then breaker to the user:

1. **Root-cause** (opus, systematic-debugging): (a) app bug on the branch, (b) plan/check
   defect, (c) environment/fixture artifact.
2. **Fix:** (a) SDD-style mini-loop (implementer brief, full suite green, task-scoped opus
   review for gate/hot-path surfaces, commit, **redeploy + version check + hard refresh**);
   (b) controller amends the check, recorded in the verdict archive; (c) fix environment,
   document.
3. **Fixes checked:** re-run the failed check live PLUS every previously-passed check whose
   surface the fix touched (blast radius named by the code reviewer).
4. **Fixes-to-fixes checked:** any re-run failure starts the next round with a FRESH
   root-cause (never "probably the same issue"); re-run the union of both rounds' sets.
5. **Exit:** a fully-green round closes the finding; history goes in the verdict archive.

**Cross-phase invariant:** a code fix during P\<k\> forces re-runs of earlier-phase checks
sharing the fixed surface; later phases run against the fixed (redeployed, version-verified)
code.

## Exit criteria

All checks CONFIRMED or EXPECTED-DELTA (or FINDING-closed with green re-runs); teardown diff
clean; verdict archive committed. Then: cloud audit → user shown the gated list → cloud
deploy v0.3.0 → formulahelp refresh.

## Execution quickstart (session pickup)

State as of 2026-08-05 end of planning session:

- Worktree: `/home/sasha_shin/twenty/.claude/worktrees/strict-typing` (enter via EnterWorktree
  `path:`), branch `strict-typing`; suite 1184/67 green at the plan commit.
- Postgres/Redis: systemd system services on this WSL host (auto-start with WSL). First step
  of any session: `bash packages/twenty-utils/setup-dev-env.sh` (idempotent — ensures
  services + databases). Server/worker/front: STOPPED — start all three from the worktree
  (`npx nx start twenty-server`, `npx nx run twenty-server:worker`,
  `npx nx start twenty-front`); `.env` files already in place (copied from the main checkout);
  server healthz on `:3000`.
- SDK client: already generated in the worktree `node_modules` (gitignored; survives on disk).
  If missing after a clean: `node node_modules/twenty-sdk/dist/cli.cjs -r dev
  dev:generate-client` + the `twenty-client-sdk` symlink (Task 8 note in the SDD ledger).
- MCP needed: playwright (UI lanes) + postgres read-only (DB evidence). Both configured in
  `.mcp.json`.
- Dev workspace app version is 0.2.0 until P0.4 — do NOT deploy before P0.3's pre-deploy
  seeding. `defaultRemote` is `cloud` (PRODUCTION): pin `-r dev` / `dev` on every invocation.
- SDD ledger (parked rulings, fix history): `<worktree>/.superpowers/sdd/
  2026-08-05-strict-typing-implementation/progress.md` — git-ignored; keep until merge.
- The unanswered integration decision (merge to local main `3e2be6f670` / PR / keep) is
  independent of this phase and still pending.
