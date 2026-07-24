# ADR 0025: Full-object recompute scan efficiency — prefetch, batching, and a resumable cursor

**Status: IMPLEMENTED (2026-07-24).** Design doc:
`docs/plans/2026-07-24-recompute-scan-efficiency.md` (repo root). Entry points:
`src/logic-functions/lib/recompute.ts` (`recomputeAllRecords`,
`planRecomputeForRecord`), `src/logic-functions/lib/scan-selection.ts`
(`buildScanSelection`, `scanNodeSelection`), `src/logic-functions/lib/
batch-write.ts` (`flushBatchedWrites`), `src/logic-functions/lib/
formula-repository.ts` (`updateScanCursor`), `src/logic-functions/
formula-sweep.ts`.

## Context

A full-object recompute — the definition-change handlers
(`on-formula-definition-created` / `-updated`) and the hourly `formula-sweep`
convergence backstop — paged the target object with an id-only selection, then
re-fetched every record one at a time to evaluate the formula, and issued up to
one conditional write per record. That is ~2 API requests per record: a
per-record read (`fetchRecord` inside `computeFormulaValueForRecord`) plus a
conditional write when the value changed.

Measured against the live workspace on 2026-07-24 (via the Twenty MCP): 387
opportunities, 19 enabled definitions, all targeting `opportunity`. A
387-record backfill was 4 page queries + 387 reads + up to 387 writes, ~778
requests, which overran the 30s `timeoutSeconds` on the definition-change
handlers.

The scan cursor (`after`) was a local variable inside `recomputeAllRecords`,
reseeded `undefined` on every invocation. A pass that overran restarted at the
first record id on its next invocation, so records past the timeout horizon
were never reached by that trigger at all — only the hourly `formula-sweep`
(120s budget, and itself uncapped per formula) eventually got to them, and even
that could starve later definitions in an unordered 19-definition loop.

## Decision

Four changes, landed as a sequence of tasks against the plan above:

1. **Page nodes carry the dependency and target fields, so the per-record read
   disappears.** `buildScanSelection` (`scan-selection.ts`) builds the same
   field selection `computeFormulaValueForRecord` / `computeMirrorValueForRecord`
   would have fetched per record — branching on mirror vs. engine vocabulary,
   since they select differently — and the scan page's `edges.node` selection
   is built from it. Each node is passed straight into
   `planRecomputeForRecord` as `prefetchedRecord`. A widened page selection
   converts a dropped field from a per-record error into a whole-pass abort (a
   field the live schema removed would throw out of the page query, not out of
   one record's fetch), so `buildScanSelection` returns `null` — and a
   PERMANENT page-query rejection at runtime degrades `scanSelection` to
   `null` — falling back to an id-only page and per-record reads, restoring
   the isolation the widened selection would otherwise cost. A retryable
   failure (rate limit, 5xx) is left to `withRetry`, not treated as a
   permanent-rejection signal.
2. **Cross-record references are cached for the duration of a pass.** A
   cross-record reference bakes a fixed `recordId` into the expression, so
   every target record in a pass resolves the *same* referenced record(s).
   `CrossRecordCache` (a `Map` keyed by object + id + exact field set) is
   created once per `recomputeAllRecords` call and threaded through
   `fetchCrossRecords` and the cross-record mirror source fetch, so a
   referenced record is read once per pass instead of once per target record.
3. **Writes are grouped by serialized payload and flushed through `updateMany`
   in chunks of 100 at each page boundary.** `recomputeForRecord`'s single
   compute-then-write body was split into `planRecomputeForRecord` (compute
   only, returns an outcome plus an optional `PendingWrite`) and a thin
   `recomputeForRecord` wrapper that flushes its one write, preserving the
   exact contract single-record handlers depend on. `recomputeAllRecords`
   collects a page's pending writes and flushes them via
   `flushBatchedWrites`, which groups by the *serialized write payload* (not
   the computed value — `buildTargetWriteData` folds in the record's current
   raw value for currency-code preservation, so two records with an identical
   computed value can still need different payloads), chunks each group to
   `MUTATION_CHUNK_SIZE` (100, `MUTATION_MAXIMUM_AFFECTED_RECORDS`), and falls
   back to per-record writes for any chunk whose batch mutation is rejected —
   so one bad record never fails 99 good ones. Flushing per page, not per
   pass, keeps memory bounded and means an overrun loses at most one page's
   writes.
4. **The scan cursor is persisted on the definition and the scan yields at a
   page boundary when its budget expires.** `FormulaDefinition` gained a
   `scanCursor` TEXT field (Task 6) and an `updateScanCursor(client, formulaId,
   cursor)` writer. `recomputeAllRecords` seeds `after` from
   `formula.scanCursor || undefined` and accepts an optional `deadlineAt`
   (epoch ms). At the end of each page — after that page's writes are flushed,
   never mid-page — `Date.now()` is checked against the deadline; if it has
   passed and another page remains, the just-completed page's `endCursor` is
   persisted and the function returns early, skipping the heartbeat. A
   completed pass (`hasNextPage` false) clears the cursor, but only when
   `formula.scanCursor` was non-empty — write-avoidant, so a pass that
   completed with no stored cursor issues no write. `formula-sweep` passes
   `deadlineAt: startedAt + SWEEP_BUDGET_MS` (100s, inside the function's
   declared 120s `timeoutSeconds`, leaving headroom for the bookkeeping writes
   that follow each formula's scan) per formula in its loop, so a formula that
   cannot finish in one hourly pass resumes from where it left off on the
   next, instead of restarting at record zero and potentially never reaching
   the tail.

   The cursor is populated only on the load-constant path (`FORMULA_FIELDS`,
   used by `formula-sweep` and `handle-record-update`), not on the
   definition-change-handler path (which passes the trigger's raw `after`
   record and has no `scanCursor` on it). That is by design: a genuine
   definition change — a new/changed `expression`, a toggled `enabled` — must
   restart the scan from the first record, since the values at any stale
   cursor position no longer reflect the new expression. A cursor-only write
   is short-circuited before reaching recompute at all
   (`handleFormulaChange`'s bookkeeping check, `scanCursor` in
   `BOOKKEEPING_FIELDS`), so the trigger path never even sees its own cursor
   writes as a reason to re-run.

`loadEnabledFormulas` also gained a stable `orderBy: [{ id: AscNullsFirst }]`
(Task 4), so the sweep's definition order — and therefore which formula's
budget-bounded scan gets to run first — is deterministic instead of starving
whichever definition happened to land late in an unordered page.

## Consequences

- **Reads collapse to page-count; writes stay per-changed-record when
  computed values are all distinct.** Measured 2026-07-24 with the real
  `FakeClient`, seeding 387 previously-null `opportunity` records and running
  one unbounded `recomputeAllRecords` pass for a same-record formula
  (`amount + 1`, distinct `amount` per record — kept as a regression test,
  `scan-resume.spec.ts`, "measured request counts for a 387-record scan"):
  **`client.queries` = 5** (4 page reads at the default `pageSize` of 100 —
  100+100+100+87 — plus 1 override-record-id load; zero per-record reads),
  **`client.mutations` = 388** (387 value-write mutations, one per changed
  record, plus 1 heartbeat write). Reads dropped from ~391 (4 pages + 387
  per-record fetches) to 5 — a ~78x reduction. Writes did **not** collapse in
  this dataset: `amount + 1` over 387 distinct amounts produces 387 distinct
  computed values, so payload-grouping cannot batch them into fewer mutation
  calls — each group has exactly one member, so batching provides chunking
  headroom (relevant once a group exceeds 100) but no call-count win here.
  `batch-write.spec.ts` covers the case where outputs cluster (e.g. several
  records computing the same value): there, the mutation count does collapse
  below the record count. The write side's real-world win depends on how much
  a given formula's outputs cluster across records — arithmetic formulas over
  varying inputs (the common case) get little to no write-count reduction; a
  formula that mostly produces one of a few values (a status flag, a mirrored
  categorical field) can see the same collapse `batch-write.spec.ts`
  demonstrates.
- **A widened page selection converts a per-record fault into a whole-pass
  risk if the fallback is ever removed.** The id-only degrade path
  (`scanSelection = null` on a permanent page-query rejection) is load-bearing
  and must not be treated as dead code — it is what keeps a single dropped
  field from taking down every remaining formula in a sweep.
- **Batched writes still emit one `record.updated` event per record.** The
  `updateMany`-style mutation (filter `id: { in: [...] }`, one shared `data`
  payload) is one GraphQL request but core still fires the per-record trigger
  and timeline row for each affected record, exactly as the old per-record
  `updateOne` calls did. Downstream trigger load (`on-record-updated`, the
  timeline) is unchanged by this ADR; only the *request count between this app
  and the server* dropped.
- **`scanCursor` is bookkeeping and must stay in `BOOKKEEPING_FIELDS`.** A
  cursor write firing `handleFormulaChange`'s full recompute path again would
  make the resumable scan self-defeating — every page-boundary cursor
  persist would trigger a fresh pass from the first record. This is enforced
  today by `handle-formula-change.ts`'s bookkeeping-only short-circuit,
  exercised in `scan-resume.spec.ts`'s "scanCursor bookkeeping" suite; there
  is no compiler-level guard against `scanCursor` being dropped from that set
  by a future edit.
- **The definition-change-handler path (30s budget) still restarts from the
  first record on every invocation**, by design (see Decision, point 4) — a
  real expression/enabled change must re-evaluate every record against the
  new logic. If a single definition-change pass still cannot finish 387
  records in 30s, only the hourly sweep's persisted cursor carries it forward
  incrementally; the definition-change handler itself has no `deadlineAt`
  wired in (out of scope for this ADR — its budget is the platform's
  `timeoutSeconds`, not a resumable one).

## Not done

- **Single-pass multi-formula evaluation per object.** All 19 definitions
  target `opportunity`. In principle `formula-sweep` could page the object
  once, select the union of every definition's dependency and target fields,
  evaluate all 19 per record, and issue one write per record carrying every
  changed field — collapsing 19 separate scans (each with its own page reads)
  into one. That is the real architectural ceiling beyond this ADR's
  per-scan optimizations, and it is roughly a further 10x reduction in page
  reads for the sweep specifically. It needs topological ordering across
  formula-on-formula chains: when definition B reads the field definition A
  writes, a combined pass must evaluate in topological order and feed A's
  freshly computed value to B within the same pass, rather than relying on
  A's write firing `on-record-updated` to converge B on a later pass. The
  dependency graph needed for that ordering already exists (`findCyclicTargets`,
  `refreshFormulaStatuses`). This is the identified next step, deferred to its
  own ADR and its own plan once this one's measurements are in.
