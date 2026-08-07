# Live Verification Handoff — string-output arc (pre-deploy)

For: an opus orchestrator session. Written 2026-08-04 at the end of the arc-completion session.
Mode: superpowers:subagent-driven-development discipline — the orchestrator dispatches every mechanical step (server starts, seeding, UI driving, DB queries) to subagents and does only briefs, adjudication, and ledger upkeep. This document is the plan; keep a ledger section at the bottom of this file (append-only) so a stalled session can resume.

## Context — where things stand

- The string-output arc (TEXT formula output, `&` concat, ADR 0026, v0.2.0) is **merged to local main** at `bb30c16bc7`. Nothing pushed, nothing deployed.
- All verification so far was **code-only**: 1084 vitest unit tests / 66 files, tsc, oxlint, greps. The "end-to-end" tests use a fake client. No live server, no real Postgres writes through the SDK, no browser, no real upgrade of persisted v0.1.x data. `.tsx` files have typecheck-only coverage.
- Purpose of this pass: exercise the riskiest behaviors against a real running instance before the user decides on cloud deploy. The two highest-risk items (Phase H): deployed TEXT mirrors over dirty date-shaped data (H1 fix), and the first post-upgrade pass rewriting stored date-shaped TEXT mirror values in place (B2/B5).
- Dev environment is **already up**: local Postgres :5432 and Redis :6379 (native, not Docker), `default` + `test` databases ready, `.env` files in place, schema initialized. Do not re-run setup unless something is broken; the script is `bash packages/twenty-utils/setup-dev-env.sh` (idempotent).
- Package root: `packages/twenty-apps/community/formula-field`. History and all adjudications: `docs/plans/2026-07-31-string-output-execution-ledger.md` (the final `[status]` entry lists ~20 triaged non-blocking follow-ups). Deltas: ADR 0026 Consequences (B1-B8 + H2 same-record caveat).

## Hard constraints

- **No cloud deploy.** Deploy needs explicit user approval and the SDK version must match the hosted platform line.
- **No formulahelp skill edits** (separate user approval).
- **No schema changes, no field UID edits, no push to any remote.**
- Local writes to the dev workspace are fine — that is the point. Note anything destructive in the ledger before doing it.
- Twenty CRM login for UI work: click "Continue with Email", use the prefilled credentials.
- Apps SDK local dev: auth lives on `/metadata`, app served against local `:3000`; the formula-field app must be synced into the local workspace via the SDK CLI before any of this works (check whether it already is before re-syncing).

## Toolbox

- `mcp__postgres__*` — read-only Postgres MCP for verifying rows (workspace schemas hold `formula_definitions`, `formula_overrides`, target tables).
- Playwright MCP (`mcp__playwright__*`) — browser driving for wizard/editor checks.
- `yarn start` / `npx nx start twenty-server` / `npx nx run twenty-server:worker` — app processes. Run them via a background-capable subagent or `run_in_background` Bash; they never terminate on their own.
- Unit suite (regression backstop): `npx vitest run` from the package root — 1084/66 green at merge.

## Model roster (per task)

Dispatch with explicit models: haiku for pure-mechanical (process starts, single-script seeding from a complete spec), sonnet for multi-step drive-and-observe work (UI flows, seed-then-query), opus only where the subagent must judge observed behavior against the ADR in the field. The orchestrator (opus) adjudicates every observation report against the expectations table below — subagents report what happened, the orchestrator decides pass/delta/fail.

## Tasks

Linear except where noted. Each task: one dispatch, report file under the scratchpad or a `verification-reports/` dir the orchestrator chooses, ledger line here on completion.

### T1 — Bring the stack up and confirm the app is live (haiku)
Start server, worker, and front (background). Verify: server GraphQL responds, worker connects to Redis, front serves, login works with prefilled creds. Confirm the formula-field app (v0.2.0 code) is installed/synced in the local workspace — if the local workspace has no formula objects (`formula_definitions` etc. absent from the workspace schema), sync the app with the SDK CLI first and report what that took. Output: process handles/ports, workspace schema name carrying the formula objects.

### T2 — Seed pre-upgrade-shaped state (sonnet)
Goal: rows that look like what a v0.1.x deployment would have on disk the moment v0.2.0 code starts. Since local code is already v0.2.0, simulate by writing definitions/records whose STORED shape matches the old lane, then letting the new code take over:
- A TEXT mirror definition (`outputFormat: 'mirror'`, TEXT source → TEXT target) over records whose source values include: dirty date-shaped strings `8801-25-03`, `1234-56-78`; a valid date-shaped string `2026-01-15`; an ISO datetime-shaped string; a >600-char string; an empty string; a normal string `ACME-42`.
- A numeric formula definition (control — must be untouched by everything below).
- A TEXT-target definition with an active override (pinned value in `overrideValueText`, old JSON convention) — plus one override row hand-written with a NON-string JSON payload (e.g. `123`) to exercise the H4 unrestorable path.
Seeding may go through the app's own APIs where possible; direct SQL only where the old shape cannot be produced by new code (document each direct write). Postgres MCP is read-only — direct writes need the server-side path or a psql call; prefer API-created rows then targeted UPDATEs. Report: exact record ids, definition ids, workspace schema.

### T3 — Upgrade-path observation (sonnet drive, opus adjudication)
Trigger recompute (worker cron or the app's recompute entry point) over the seeded data. Then query and compare against expectations:

| Check | Expectation (source) |
|---|---|
| Dirty date-shaped values (`8801-25-03`, `1234-56-78`) | Copied VERBATIM to target, `error: null`, definition keeps converging — no freeze (H1 fix) |
| Valid date-shaped `2026-01-15` through the TEXT mirror | REWRITTEN in place to the canonical rendering of its epoch-day serial — this is expected delta B2/B5, confirm it matches the ADR's description exactly |
| >600-char value | Target holds full text; `lastValueText` holds a truncated but VALID-JSON envelope that decodes to a string preview (H7) |
| Empty string, `ACME-42` | Verbatim, converging |
| Numeric control definition | Bit-for-bit no change in behavior, heartbeat advancing |
| Overridden TEXT record | Skipped by the sweep (override suppression), stored pin untouched |

Any mismatch that is not literally described in ADR 0026 is a STOP-and-report finding, not something to fix inline.

### T4 — Wizard and editor UI pass (sonnet, Playwright)
1. Create a new formula via the wizard with the **Text** output format; expression with `&` concat; verify save, display of the computed value, and that the Field settings section for TEXT is sane (known cosmetic issue: header/Save over empty body — confirm it is only cosmetic).
2. Confirm TEXT fields are absent from the mirror-source picker (B8) and that the Text-format path replaces it.
3. Override lifecycle on a TEXT row: pin a value (goes to the text slot), disable, re-enable — the pinned value must be restored, not nulled (H4). Repeat with the hand-seeded non-string pin from T2: re-enable must RE-PIN THE CURRENT value, never write null.
4. Editor validation live: bare BOOLEAN ref onto a TEXT target rejected at save with the kinds-must-match message (H3); `isActive & ""` accepted; a TEXT definition's Current-value line renders the decoded heartbeat.
Screenshots for each numbered item into the report dir.

### T5 — Known-delta live demonstrations (sonnet)
Reproduce, on purpose, the two sharp edges the user must see before deploy, and capture them:
- H2: same-record TEXT field holding `2026-01-15` compared `= "2026-01-15"` → false where v0.1.x string mode returned true (silent flip; no save-time protection).
- Lone-string-literal condition (`IF("a", 1, 2)`) now saves and errors per-record at runtime instead of failing at save (undocumented-delta follow-up in the ledger).
These are documentation demos, not bugs to fix.

### T6 — Verdict synthesis (orchestrator, inline)
Collate T3-T5 into a single verdict table: PASS / EXPECTED-DELTA (with ADR cite) / FINDING. Any FINDING: adjudicate — real regressions get one fix dispatch + scoped re-review per SDD, doc-only gaps get appended to the execution ledger's follow-up list. Then present the user the deploy decision: verdict table + ADR 0026 Consequences + the H2/lone-literal demos. **Do not deploy.** Tear down or leave the dev processes per user preference; note which in the ledger.

## Ledger (append-only — orchestrator maintains)

- 2026-08-04 [setup] Handoff written; dev env up (local Postgres/Redis, schema initialized); nothing dispatched yet.
- 2026-08-04 [reset] A first T1 attempt (opus session) was discarded as unreliable; its `verification-reports/` output (T1-stack-up.md + login screenshot) was deleted. Full env reset via `setup-dev-env.sh --reset` (destructive DB wipe, user-authorized), then rebuilt from scratch: server :3000 healthy, worker processing (BullMQ), front :3001 serving. Fresh API key token minted from the seeded key (auth via /metadata as tim@apple.dev — credentials verified server-side; browser login NOT yet exercised) and written to the CLI `dev` remote (stale appRegistration fields dropped). formula-field v0.2.0 published + installed to the Apple workspace: schema `workspace_1wgvd1injqtife6y4rvfbu3h5` holds `_formulaDefinition`/`_formulaOverride`/`_variationConfig`; 16 logic functions registered, builds up to date; crons formula-sweep `0 * * * *`, timeline-cleanup `*/10 * * * *`, variation-sweep `0 * * * *`. Browser check: front loads the Apple workspace companies view authenticated, 0 console errors. T1 satisfied; T2 not started.
- 2026-08-04 [T2] complete (sonnet). Seed verified read-only by orchestrator against DB. Report: verification-reports/T2-seed.md. Candidate finding F1: empty-string TEXT dependency reverts to NULL via API/event path. Agent tripped a harness security flag (retried denied writes); all writes audited clean.
- 2026-08-04 [T3] complete (sonnet drive, orchestrator adjudication). 07:00 sweep did not fire (→F2); fallback definition-update trigger used. All 6 checks PASS or expected-delta; B2/B5 rewrite confirmed verbatim against ADR 0026. Report: T3-upgrade-observation.md.
- 2026-08-04 [F2/F3] classified (sonnet investigator): F2 = local-dev gap (cron:register:all only in Docker entrypoint) — fixed locally 07:28 UTC, sweep verified live 08:00; F3 = designed write-avoidance (ADR 0022 M3). Report: F23-classification.md.
- 2026-08-04 [incident] Orchestrator's cron:register:all run wiped twenty-server dist under the watch processes; server+worker crash-looped 07:28-07:41, restarted clean. Rule: never run server command targets with the stack up.
- 2026-08-04 [T4] complete (sonnet, Playwright; BLOCKED interlude from the incident, resumed). Items 1-4 all PASS; known cosmetic Field-settings issue RETRACTED (dead-backend artifact); H4 unrestorable pin re-baselines silently (per plan wording, doc-note added). Report: T4-ui-pass.md + 10 screenshots.
- 2026-08-04 [T5] complete (sonnet). Both delta demos captured: H2 flip (silent, no save-time signal) and lone-literal runtime error (non-destructive across all 13 rows). Demo definitions disabled. Report: T5-delta-demos.md.
- 2026-08-04 [T6] verdict synthesized: 12 PASS, 3 EXPECTED-DELTA, 1 observation gap (H7 preview, unit-covered), 1 open finding (F1). NO deploy performed. Report: T6-verdict.md. Dev stack left running; T2/T4/T5 residue left in workspace, documented. Deploy decision handed to user.
- 2026-08-04 [user rulings on the verdict] (1) B2/B5 rewrite delta: accepted — user stores dates only in DATE fields. (2) B6/H2 REJECTED as design: user directs strict kind-matched comparisons (date-to-date, text-to-text, number-to-number; no bare hard-coded date literals against fields) and questions B2's eager date-coercion of TEXT content entirely — engine should not treat date-shaped text as a date. This overrides ADR 0026's design-locked B2/B6; needs a new ADR + design pass (the kind-aware-resolver alternative is pre-named in ADR 0026's Not-done section). (3) F1: backlogged — investigate + patch AFTER the strict-comparison work and BEFORE the SELECT output arc. (4) H7 gap: dismissed by user.
