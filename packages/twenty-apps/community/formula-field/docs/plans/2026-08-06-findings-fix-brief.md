# Findings fix brief — post-live-verification session (F2, F3, F4)

User directive (2026-08-06, end of live session): fix ALL parked findings, re-verify IN CODE
ONLY (no further live testing), then merge and deploy v0.3.0. This brief carries the
fix-critical context out of the live session. Companion: the verdict archive
(`2026-08-05-strict-typing-live-verdict.md`) and untracked evidence under
`verification-reports/2026-08-05-strict-typing-live/` in THIS worktree (raw-p1/, raw-p3/ hold
the only surviving F2/F4 exhibits — the live fixture rows were torn down; do not delete the
directory until the fixes merge).

## F4 — TEXT-lane gated-definition heartbeat churn (fix first; smallest, clearest)

Symptom (live, 13:00 JST tick 2026-08-06): gated defs with TEXT targets (S5, output-gate,
T4 Text Greeting) each got a pure heartbeat write (`lastEvaluatedAt` + `updatedAt` advanced,
every data column unchanged) on their SECOND gate pass. Discriminators, same tick: gated
NUMBER-target defs (S3, S4, S8, S1x) wrote NOTHING; converged PASSING TEXT-target defs
(T2 mirror, T4 Tab Enabler) wrote NOTHING. So: gated ∧ TEXT-target ⇒ one row write per sweep.

Hypothesis chain (verify in code, in this order):
1. GraphQL round-trips SQL-NULL TEXT columns as `''` (observed repeatedly: p2a lane, P0
   record read-backs). `loadAllEnabledFormulas` therefore holds `lastValueText: ''` in memory
   for a gated def whose stored column is NULL.
2. The gate-write path (recompute.ts, D6 gate + the "heartbeat write syncs the in-memory
   record" ADR 0027 fix) compares computed-vs-stored before writing. For the gated case the
   payload carries `lastValueText: null` vs in-memory `''` → inequality → write, every pass.
3. Related sentinel note from the P1 judge: `formula-repository.ts:375` writes
   `outcome.error ?? ''` on the validate branch (the `''`→NULL normalization two-step) — the
   same NULL/`''` ambiguity family.
NUMBER lane is immune because `lastValue` (float) round-trips null correctly.

Fix shape: normalize the comparison (treat `''` and null as equal for lastValueText /
lastError in the write-avoidance check, or normalize at load). TDD: unit test with a mocked
client asserting the SECOND gate pass over an already-gated TEXT-target definition performs
ZERO update calls (and equally for the event path and widget/recomputeForRecord path — blast
radius is every strictKindGateError caller). Also pin: PASSING TEXT-target converged pass
still writes nothing, and a genuine error-string CHANGE still writes once.

## F3 — external bookkeeping-only updates do not short-circuit

Symptom (live, twice): an API update writing ONLY `lastEvaluatedAt` on a definition row was
followed ~1s later by a full validate+recompute burst that re-stamped `lastEvaluatedAt`
(worker log: LogicFunctionTriggerJob bursts at 11:50:08 and 12:52:44 JST; browser excluded as
cause on the second run — it was parked on about:blank).

Code anchors: `handle-formula-change.ts:16-34` — `lastEvaluatedAt` IS in BOOKKEEPING_FIELDS
and `isPureBookkeepingUpdate(updatedFields)` should have returned true. Therefore the
`updatedFields` array the platform delivers for an external GraphQL update either is
undefined, or contains extra entries (e.g. `updatedAt`), failing `.every(...)`. First step:
instrument/inspect what `on-formula-definition-updated`'s trigger payload actually carries
for (a) an external single-field update, (b) the app's own bookkeeping writes — find why the
app's own writes do not loop (observed: bursts self-terminate after ~2 generations via
write-avoidance, which after F4's fix becomes the only terminator on the TEXT lane too).
Fix shape depends on the payload finding: likely ignore platform-managed fields (updatedAt)
in the guard, or treat undefined updatedFields on UPDATE events as "diff the before/after
images". Related parked SDD ruling: `handle-record-update.ts:183` tests
`updatedFields !== undefined` while siblings use `!updatedFields` — fold that style ruling in.
TDD: unit tests for isPureBookkeepingUpdate against the REAL payload shapes discovered (do
not invent shapes). Positive side effect to preserve: the TODAY-staleness carve-out works
(live-verified twice via the self-heal).

## F2 — blank-targetFieldType definitions: permanently enabled, permanently failing writes

Symptom (live exhibit, raw-p1/api-C JSONs): definition created via API with
`targetFieldType: ''` (stored as SQL NULL) and a real TEXT `targetField`. Gate correctly
skips (kind-inference.ts:334-340, blank/non-family targets are skip-never-reject). The
runtime then evaluates `1 + 2` and attempts the record write, which fails
(`Failed to write lv3C7bText: Invalid string value 3 for text field "lv3C7bText"`), stays
enabled, and repeats every pass — evaluation + failed-write rent for guaranteed-zero output.
API-only reachable (the UI always sets targetFieldType).

DESIGN RULING NEEDED FIRST (present to user before coding): options —
(a) save-validation rejects blank targetFieldType when targetField is set (async disable,
    consistent with the save gate; smallest blast radius);
(b) recompute lane treats blank-target defs as no-op (skip evaluation entirely, definition-row
    error once, write-avoidant);
(c) disable-on-persistent-write-failure (bigger semantics change; touches error taxonomy).
Efficiency-first bias suggests (a) + (b)'s definition-row error once. Whatever the ruling:
TDD the chosen behavior; pin that the blank-target GATE SKIP itself stays intact (it is the
verified P1.7c mechanism).

## P4.3 field-edit override lane — waived

User waived further live testing. Confirm (read-only) that the existing unit suite covers the
override-detection loop for human-actor field edits (`handle-record-update.ts` override loop,
`actorWorkspaceMemberId` present) — it was live-verified in the 2026-08-04 arc and this arc
did not change it except the gated-def exclusion (both halves of which ARE live-verified:
gated defs skip override creation by code path P4.4; passing defs create overrides via the
toggle exhibit raw-p4/p4.3-override-row.json). No code change expected.

## Re-verification recipe (code-only, per user directive)

Per fix: SDD-style mini-loop (failing test → fix → full suite green → task-scoped review).
Suite: `node <worktree>/node_modules/vitest/vitest.mjs run` from the app dir (1184+ tests at
branch head; `npx vitest` is not the working path here). Lint: oxlint as configured. Then:
1. Merge decision executes against LOCAL main `3e2be6f670` (never origin/main).
2. Cloud audit: `npx tsx scripts/audit-strict-gate.ts cloud` — fresh-worktree gotcha: needs
   `node node_modules/twenty-sdk/dist/cli.cjs -r <remote> dev:generate-client` + the
   `twenty-client-sdk` symlink if node_modules was cleaned (currently present).
3. Show the user the cloud gated list, then deploy v0.3.0 (SDK version must match the hosted
   platform line), then formulahelp refresh.

## Environment notes for the next session

- Dev stack (server :3000 / worker / front :3001) was LEFT RUNNING at session end from the
  worktree; processes may survive. Check `curl :3000/healthz` before `npx nx start ...` to
  avoid port-conflict confusion. Postgres/Redis are systemd services.
- The dev workspace has 0.3.0 (pre-fix) deployed and is post-teardown clean (6 residue defs,
  2 pins). No live re-deploy is required by this plan; the fixes ship via the CLOUD deploy.
- Worktree `packages/twenty-server/.local-storage` (56M, untracked) was copied from the main
  checkout on 2026-08-06 — without it, ALL logic functions fail (FileStorageException). Do
  not delete; any fresh worktree needs the same copy.
- Cross-record refs are literal `[object:uuid:fieldPath]` tokens (tokenizer.ts readCrossRef),
  not relation traversal.
- `~/.twenty/config.json` defaultRemote is PRODUCTION cloud: pin `-r dev`/`dev` on every CLI
  or script invocation that should hit local.
