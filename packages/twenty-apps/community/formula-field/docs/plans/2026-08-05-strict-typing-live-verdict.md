# Strict typing live verification — verdict archive (v0.3.0)

Executed 2026-08-06 (09:35-13:06 JST) against the dev workspace
(`workspace_1wgvd1injqtife6y4rvfbu3h5`), branch `strict-typing`, deployed app version 0.3.0
(version-gated at every phase; final audit 13:06 JST). Plan:
`2026-08-05-strict-typing-live-verification-plan.md`. Untracked evidence:
`verification-reports/2026-08-05-strict-typing-live/` (P<N>-report-*.md, P1/P2 judge verdicts,
raw-p0..p5/, seed/ scripts). Orchestration: controller + 2 workflows (P1: 4 executors + opus
judge; P2: 4 executors + opus judge) + 1 UI executor thread; judges re-derived checks from the
live DB.

## Verdict table

| check | verdict | evidence |
|---|---|---|
| P0.1 stack up | PASS | P0-report; formula-sweep/timeline-cleanup cron registered |
| P0.2 fields (40) / records (6) | PASS | P0-seeding-report (a)(b) |
| P0.3 pre-deploy seeds (8) | PASS | created under 0.2.0; final legacy sweep (11:00) evaluated all 8, all stayed enabled (P0-report) |
| P0.4 deploy 0.3.0 | PASS | 12 changed / 0 destroyed; core.application = 0.3.0 |
| P0.5 baseline snapshot | PASS | raw-p0/07-p05-baseline.md |
| P0.6 baseline audit | PASS | 12 defs: 8 GATED / 4 PASS, byte-equal predictions |
| P1.1r-P1.11r save-gate rejects (ui+api) | PASS (byte-exact) except P1.1r/P1.5r -> F1 | P1-judge-verdict: 25/30 halves CONFIRMED, 0 evidence-insufficient |
| P1.1c-P1.6c, P1.7c, P1.13a/b controls | PASS except P1.7c -> F2 | P1-judge-verdict |
| P1.12 cross-record divergence | EXPECTED-DELTA (ADR 0027 D5) CONFIRMED | editor blind, async reject byte-exact |
| P1.5r-bis (F1 remediation) | PASS | `Cannot compare number with text using "=" (kinds must match)`, 60 bytes, live row |
| P2.1-P2.11 runtime semantics | PASS 15/15 CONFIRMED | P2-judge-verdict (incl. convergence protocol, all fail-sigs negative) |
| P3.1 T4 Text Greeting first-gating | PASS | 12:00 tick; error byte-exact; lastValueText -> null; records untouched |
| P3.2 seeds first-pass gating, zero writes | PASS | 5 same-record via 12:00 tick; 2 cross-record via P4.4 event (amendment); all target columns byte-stable vs baseline |
| P3.3 write-avoidance on gated defs | PASS error-rewrite avoidance (sweep + event lanes); heartbeat lane -> F4 | P3-report-controller; S4/S1x/S1xb byte-stable through tick+event |
| P3.4 editor recovery (S1xb) | PASS | re-enabled, error cleared, 15 records recomputed to 0 |
| P3.5 cron witness | PASS | perturbation restored by the 13:00 tick with no manual trigger (amended arm: F3 made backdating unreachable) |
| P4.1 affected event | PASS | Muffin lv3P25Num=101 in <=15s |
| P4.2 unaffected-event discrimination | PASS | perturbed value survived unrelated event; affected event restored |
| P4.3 override detection | PARTIAL | toggle path witnessed (member-actor override row created + deactivated cleanly, gate-passing def); field-edit lane not re-verified (playwright could not open Twenty's inline cell edit — automation limitation, control-tested; unchanged code path live-verified in the 2026-08-04 arc). Follow-up: 1-minute manual check |
| P4.4 cross-record event gate (carry-forward #1) | PASS | executed pre-first-sweep by design; both defs gated byte-exact in ~1s, zero recomputes across 15 records |
| P5.1 autocomplete | PASS | 3 entries byte-exact; DATE inserts `DATE("` |
| P5.2 error copy full render | PASS | full-DOM screenshots of the two longest strings, no truncation |
| P5.3 gated-definition surfacing | PASS | S1x renders definition.lastError with no liveError |
| P5.4 stale-widget | FOLDED into P4.3 toggle observation + F3's live self-heal evidence; staleness arm unreachable (F3) | no stale render observed on toggle; natural->2.5h fallback documented |
| P5.5 wizard handoff | PASS | field + expressionless definition + editor gate pairs with P1.11 |
| P6.1 audit-vs-live mapping | PASS | 32 defs: 25 PASS / 7 GATED, each mapped to a live observation |
| P7.1 teardown | PASS | all LV3 defs/records/fields/override removed; residue byte-stable; post-teardown audit 4 = 3 PASS + 1 GATED (T4 Text Greeting) |

## Findings

- **F1 (spec defect, CLOSED):** bare top-level comparisons are parse-rejected
  (`PARSE_ERROR: Comparison "=" is only allowed in the condition of IF(condition, then, else)`)
  before kind inference — P1.1r/P1.5r literals were unreachable as authored. App behavior
  correct. Closed via IF-wrapped P1.5r-bis; date-vs-text class already witnessed by P1.12 + P0
  fixtures.
- **F2 (product, PARKED, low-medium):** a definition with blank `targetFieldType` (API-only
  seed) skips the gate as designed but stays enabled while its write fails every pass
  (`Failed to write lv3C7bText: Invalid string value 3 for text field "lv3C7bText"`) —
  permanent evaluation+failed-write rent for zero output. Needs a design ruling (disable?
  gate?) — efficiency-first violation.
- **F3 (plan premise + product, PARKED):** external "bookkeeping-only" API updates do NOT
  short-circuit (`lastEvaluatedAt` write triggered a full validate+recompute burst twice,
  ~1s re-stamp, browser excluded as cause) despite `lastEvaluatedAt` being in
  BOOKKEEPING_FIELDS (handle-formula-change.ts:16-24). Hypothesis: event `updatedFields`
  semantics vs `isPureBookkeepingUpdate`. Cost: one validate+recompute burst per external
  bookkeeping write. Positive: TODAY-staleness carve-out live-verified twice via the self-heal.
  Related to the parked SDD ruling on `updatedFields !== undefined` style.
- **F4 (product, PARKED, low — recommend fixing before cloud deploy):** TEXT-target GATED
  definitions receive a pure heartbeat write (`lastEvaluatedAt`+`updatedAt`, no data change)
  every sweep (S5, output-gate, T4 Text Greeting at the 13:00 tick), while NUMBER-target gated
  defs and converged TEXT-target PASSING defs write nothing. Hypothesis: SQL-NULL vs `''`
  sentinel mismatch in the gate-write's write-avoidance comparison on the text lane. Cost: 1
  row write per gated TEXT def per hour. Contradicts the D6 "converged pass writes nothing"
  claim on exactly this lane.
- **Judge evidence-method notes (E1, E2 — P2):** one timeline query used a wrong column
  (never-matching filter), one convergence observation recorded a stale pre-existing value;
  both conclusions re-derived correct by the judge. Recommendation adopted: per-column
  timelineActivity diffs as the standard no-write instrument next phase.

## Environment findings

- Worktree servers have no `.local-storage` (untracked; not carried by `git worktree add`) —
  all logic functions failed until it was copied from the main checkout (221 exceptions,
  including the 10:00 tick). Fixed 10:27 JST; witnessed clean at 10:30. Session-setup note for
  any future worktree live phase.
- Playwright cannot open Twenty's record-page inline cell editor (all click strategies,
  control-tested on ordinary fields) — blocks UI field-edit flows; the Formulas-tab editor and
  override toggle work fine.

## Controller amendments (all recorded in-line in reports)

Two cross-record S1 seeds (P3.4 recovery vs P4.4 subject); P4.4 executed pre-first-sweep
(write-avoidance would otherwise erase its observable); P3.2 first-gating split (same-record
via tick, cross-record via event); P3.5 arm pivoted to perturbation-restore (F3); P5.4 folded
into P4.3; P1.1/P1.5 reject forms amended to IF-wrapped (F1); S8 control asserts equal-kind
ordering (no rewrite exists per ADR 0027 Not-done); record `updatedAt` dropped as a P3.2
witness after P1 activity (seed target columns byte-compared instead).

## Known-issue sightings

None. The F1-empty-string symptom (empty-string TEXT dependency reverting to NULL) was not
observed in any lane.

## Residue map (post-teardown)

6 definitions: T2 mirror, T2 numeric control, T4 Tab Enabler (all PASS, byte-stable vs
baseline), T4 Text Greeting (intended permanent deltas: gate error string + lastValueText
null; target record values untouched), T5 demo 1 + 2 (disabled, byte-stable). 2 original
override pins intact and live-verified. Post-teardown audit: Total 4, PASS 3, GATED 1,
PARSE 0.

## Exit

All checks CONFIRMED / EXPECTED-DELTA / FINDING-closed except the P4.3 field-edit lane
(PARTIAL, prior-arc coverage + 1-minute manual follow-up). Remaining gates before cloud:
merge decision, F4 fix (recommended), cloud audit + gated-list review, deploy v0.3.0,
formulahelp refresh.
