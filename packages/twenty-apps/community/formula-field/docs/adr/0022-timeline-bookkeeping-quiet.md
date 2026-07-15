# ADR 0022: Quiet the timeline further — deterministic sampling, write-avoidant bookkeeping, wider cleanup scope

**Status: IMPLEMENTED (2026-07-15), ships as v0.1.8.** Successor increment to
ADR 0020 (the original 10-minute cleanup cron). Design doc:
`docs/superpowers/specs/2026-07-15-timeline-spam-fix-and-description-design.md`
(repo root). Entry points: `src/logic-functions/lib/recompute.ts`
(`recomputeAllRecords`), `src/logic-functions/lib/variation-config-repository.ts`
(`updateVariationConfigBookkeepingIfChanged`), `src/logic-functions/lib/
timeline-cleanup.ts` (classifier extension), `scripts/retro-purge-timeline.ts`
(one-time historical purge).

## Context

ADR 0020 shipped a cron that sweeps app-authored `<target-object>.updated`
noise out of the Timeline. It worked for the object the formula/variation
*writes to* — but measured against the cloud workspace on 2026-07-15 (via the
Twenty MCP), three sources of noise remained outside its scope or its
write-avoidance guards:

| Offender | Count | Rate | Root cause |
|---|---|---|---|
| `formulaDefinition.updated` | 3,770 | ~1,000–1,800/day | Unstable representative `lastValue` sample defeats the heartbeat's own write-avoidance guard |
| `variationConfig.updated` | 177 | 24/day per enabled config | Unconditional hourly bookkeeping write, no change check |
| `<target-object>.updated` (`updatedBy`-only diff) | ≤671 | sporadic | Recompute-race no-op writes, turned into diffs by core's unconditional actor re-stamp |

Three separate, verified root causes:

1. **Unstable `lastValue` sample.** `recordEvaluationHeartbeat`
   (`formula-repository.ts:244-296`) is already write-avoidant — it compares
   the incoming outcome against the definition's stored `lastValue`/`lastError`
   and skips the write when neither changed. But the value it compares against
   sweep-to-sweep is sampled as "first non-error, non-null outcome" of a
   paginated scan over the target object's records
   (`recompute.ts:663-729`), and that scan had **no `orderBy`**. Page order
   varies run-to-run, so the sample flips between different records' values
   (observed `0 → X` and `null → X` diffs on definitions whose actual computed
   values hadn't changed), defeating the guard on nearly every hourly sweep
   *and* every `*.updated` event-triggered recompute
   (`on-record-updated.ts:60`) — which is why the volume far exceeded
   26 definitions × 24 hourly sweeps.
2. **Unconditional variation bookkeeping.** `sweepVariationConfig`
   (`variation-sync.ts`, both the early-return relation-health path and the
   end-of-sweep path) called `updateVariationConfigBookkeeping` with a fresh
   `lastSyncedAt` on every hourly sweep and every config-change event — no
   change check, unlike the formula side's heartbeat contract.
3. **`updatedBy`-only diffs on target records.** The per-record value guard
   exists on both the engine path (`recompute.ts:596-609`) and the mirror path
   (`:553-557`), but the event-trigger path and the hourly cron sweep can both
   read stale state and both write the same value with no locking or version
   check. Core re-stamps `updatedBy` unconditionally on every accepted
   `updateOne`, regardless of whether any other column actually changed
   (`updated-by.update-one.pre-query-hook.ts:18-49`), so a redundant write
   after a human or third-party edit yields a non-empty diff whose only key is
   `updatedBy` — which core turns into a real timeline row. ADR 0020's cron
   kept these rows on purpose: `updatedBy` was not in its app-managed key set
   (fail-safe posture toward keeping ambiguous rows).
4. **The ADR 0020 cron's scope gap.** Its classifier only ever registered
   *target objects* (the object a formula's value field or a variation's
   mirrored fields live on) — `formulaDefinition` and `variationConfig`
   records themselves, which the engine also writes bookkeeping fields onto
   every sweep, were never in its managed-object model, so their `.updated`
   rows were outside its reach by construction.

Reconfirmed per ADR 0020: neither core nor the Apps SDK exposes any
field-level or object-level timeline/audit exclusion for app writes
(`objectRecordChangedValues` still excludes only `updatedAt` / `searchVector` /
relation-typed fields). All four fixes below are app-side.

## Decision

### F1 — Deterministic `lastValue` sampling
Added a stable `orderBy: [{ id: AscNullsFirst }]` to the target-record
pagination query in `recomputeAllRecords` (`recompute.ts`). The scan now
visits records in the same order every run, so "first non-error, non-null
outcome" is a deterministic sample and `recordEvaluationHeartbeat`'s existing
guard collapses definition writes down to genuine value/error changes. The
ADR 0015 carve-out (hourly `lastEvaluatedAt`-only heartbeat for `TODAY()`
formulas, to prove liveness without a value change) is unchanged — F3 handles
its residual timeline rows, not F1.

*Rejected alternative:* stop persisting `lastValue` altogether — the widget
surfaces it directly; sampling instability was the bug, not the field.

### F2 — Write-avoidant variation bookkeeping, with a 24h heartbeat
`updateVariationConfigBookkeepingIfChanged` (`variation-config-repository.ts`)
now mirrors the formula-repository contract: before writing, it compares
`lastError`/`status`/`statusReason` against the config's current stored
values. A no-op sweep — nothing changed — performs **zero** writes.

The spec's original plan was to drop `lastSyncedAt` bookkeeping down to "only
stamped as part of a real content write." That fallback path was taken
instead: the variation config editor renders `lastSyncedAt` as a "last synced"
freshness signal, so it cannot go silently stale — a config that has been
healthy and unchanging for days must still show a recent timestamp, not one
frozen at its last real change. `updateVariationConfigBookkeepingIfChanged`
therefore also writes once per `VARIATION_BOOKKEEPING_HEARTBEAT_MS` (24h) even
when nothing else changed, so `lastSyncedAt` stays honest without reverting to
an hourly write. An unparsable or missing `lastSyncedAt` (`Number.isFinite`
guard on `Date.parse`) reads as heartbeat-due rather than fresh, same posture
as the existing `TODAY()` staleness guard (ADR 0015). Net effect: up to 24
writes/day collapses to at most 1 write/day per unchanging config — a 24×
reduction, not a full elimination, and that's a deliberate trade for a
freshness signal the UI actually depends on.

### F3 — Extend the ADR 0020 cleanup classifier
Two additions to `timeline-cleanup.ts`'s managed-object model, same
soft-delete + strip-mixed-rows + fail-safe-keep posture ADR 0020 established:

1. **Definition/config bookkeeping rows.** `formulaDefinition` and
   `variationConfig` are now registered in the classifier's managed model
   (whenever the workspace has any definitions at all) with their own
   bookkeeping key sets: `DEFINITION_BOOKKEEPING_KEYS` (`lastValue`,
   `lastValueText`, `lastEvaluatedAt`, `lastError`, `status`, `statusReason`,
   `dependencies`) and `VARIATION_CONFIG_BOOKKEEPING_KEYS` (`lastSyncedAt`,
   `lastError`, `status`, `statusReason`). `order` is deliberately **not**
   in the definition set — the widget's drag-to-reorder (ADR 0013) writes it
   on the user's behalf, so a row touching only `order` stays keep-side.
   The uniform strip machinery handles these rows exactly like any other
   managed object: a row whose diff is *entirely* bookkeeping keys is
   soft-deleted; a row that mixes a bookkeeping key with a human-editable one
   (`expression`, `name`, `enabled`, `targetField`, `description`, …) is
   **stripped**, not kept whole — the bookkeeping key is removed from the
   diff and the row survives with the human key(s) intact.

   **This is a deliberate correction from the design spec**, which described
   this class as "mixed rows kept whole (no key-stripping needed... bookkeeping
   keys never mix with human edits in one write)." The implementation instead
   reuses the same generic strip-mixed-row path every other managed object
   already goes through, rather than special-casing definition/config rows to
   skip stripping. In practice a bookkeeping key and a human key landing in
   the *same* diff is not expected to occur from a single write path — the
   spec's premise mostly holds — but where it could (e.g. a hand-written
   script or future code path that writes both in one mutation), the shipped
   behavior is the strictly safer one: it never deletes a row or a human key,
   and it still gets the bookkeeping noise out, rather than leaving a
   bookkeeping key sitting forever in a row that also happens to carry a real
   edit. Also carried over from ADR 0020's existing `stripKeysFromRow`
   codepath but newly *reachable* by this class: stripping every key from a
   row now **deletes** the row instead of writing back an empty-diff stub —
   core itself never creates an empty-diff update row, and a stub row was
   pure noise with nothing left to show.
2. **App-authored `updatedBy`-only rows on target objects.** Existing
   managed-object name set, diff's *only* key is `updatedBy`, and
   `updatedBy.after` is exactly `{source: "APPLICATION", name: "Formula
   Field"}` (the actor name core stamps on this app's own writes). Any other
   actor — a human, Supabase, another app — leaves the row untouched; the
   check is on the actor identity, not just the key shape, so a genuine
   third-party `updatedBy`-only write is never touched.

This closes the scope gap ADR 0020 left (fix #4 in Context): the cron now
reaches the definition/config objects, not just their targets. It remains
required, not just insurance — ADR 0015's `TODAY()` heartbeats and any
F1-legitimate value change still write rows; the cron is what keeps the
timeline quiet around them.

### F4 — One-time retro purge (approved 2026-07-15)
`cleanupFormulaTimelineNoise` gained an optional `options: { lookbackMs?;
maxPages? }` parameter; the 10-minute cron calls it with no options, so its
production behavior (48h lookback, 20-page cap) is unchanged. A new standalone
script, `scripts/retro-purge-timeline.ts` (run via `yarn retro-purge
<remoteName>`, reading `apiUrl`/`apiKey` for that remote out of
`~/.twenty/config.json`), runs the same classifier with a 10-year lookback and
a 50-page cap per pass, looping until a pass reports no truncation. Soft-delete
only — same fail-safe classifier the cron uses, so genuine user edits
(`formulaOverride.updated`, real stage/amount changes, definition field edits)
are untouched by construction.

The retro purge itself is scheduled to run once, after the v0.1.8 deploy is
confirmed live (a separate, later step — not part of this docs task). After it
runs, the 2026-07-15 investigation's MCP/GraphQL counts should be re-issued to
confirm: `formulaDefinition.updated` residue ≈ genuine edits only (creates +
real expression/config edits), `variationConfig.updated` ≈ genuine config
edits, app-authored `updatedBy`-only rows = 0.

## Consequences

- **`lastSyncedAt` is a 24h-bounded heartbeat, not a true "only writes on
  real change" field** (F2). This is a smaller reduction (24×) than the
  formula side's full write-avoidance, traded deliberately to keep the
  editor's freshness display honest. If a future change removes or reworks
  that UI, the heartbeat can be dropped entirely for the full reduction.
- **Mixed bookkeeping/human-key rows on `formulaDefinition`/`variationConfig`
  are stripped, not preserved whole**, diverging from the original design
  spec's text (see F3 above). Documented here as the deliberate as-shipped
  behavior; the outcome for a user is identical either way (the human edit
  survives, visible), the difference is only that the bookkeeping key
  disappears from that historical diff instead of lingering in it.
- **Up to ~10 minutes of visible bookkeeping noise between cron runs**,
  same acceptance as ADR 0020, now extended to definition/config rows too.
- **A `TODAY()` formula's hourly ADR 0015 heartbeat still produces a
  `lastEvaluatedAt`-only row every hour** — F1 does not touch it (it's a
  genuine liveness write, not a sampling artifact) — but it's covered by
  F3's bookkeeping-key set, so the cron removes it within its cadence.
- **Historical noise (3,770 + 177 + up to 671 rows measured 2026-07-15) is
  cleaned up only after the retro purge (F4) actually runs**, which happens
  post-deploy, not as part of shipping this code. Until then those rows
  remain.
- **Retire this ADR's mechanisms (and ADR 0020's) together if the platform
  ever ships field-level or object-level audit exclusion for app writes.**
  Suppressing at birth is strictly better than sampling stability tricks,
  write-avoidance guards, and a sweeping cleanup cron — this whole family of
  fixes exists only because that platform capability doesn't exist. This is
  the same standing caveat ADR 0020 established; it now covers F1-F4 as well.

## Not in scope (backlog)

- An upstream twenty-server PR adding field-level audit exclusion (still the
  proper fix; still deferred by user choice, per ADR 0020).
- Actually running the F4 retro purge and verifying its counts — approved,
  scripted, not yet executed against the cloud workspace.
- A true "no periodic write at all" version of F2, contingent on the editor
  no longer needing `lastSyncedAt` as a freshness signal.
