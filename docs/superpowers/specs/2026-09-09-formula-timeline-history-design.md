# Formula timeline history: keep transitions and formula-change recomputes

Status: DESIGN APPROVED 2026-09-09, NOT IMPLEMENTED. Next build for the formula-field app
(`packages/twenty-apps/community/formula-field`), after the ADR 0032 branch
(`feat/formula-field-timeline-cleanup-schema`) is merged and deployed. Fact-checked against
the code on 2026-09-09; file:line references are to that branch.

## Problem

ADR 0020 / 0022 / 0031 / 0032 treat every app-authored `recordUpdated` row on a managed field
as noise and soft-delete it. That is right for most rows but wrong for two kinds of event whose
cause is recorded nowhere the reader can reach:

| # | Event on a record | Where the cause lives today | Today |
|---|---|---|---|
| 1 | Recompute because an input field changed | The input edit is its own row on the same record | deleted (correct) |
| 2 | Recompute because the formula expression changed or the formula was enabled | Only on the formulaDefinition object's timeline | deleted (history lost) |
| 3 | First compute / backfill when a formula is created | On the definition object | deleted (kept out of scope, high volume) |
| 4 | Human overrides the formula (manual edit) | It is the human's own row (`workspaceMemberId` set) | kept |
| 5 | Override released, formula retakes the field | Nowhere | deleted (history lost) |
| 6 | Definition bookkeeping (`lastValue`, `lastEvaluatedAt`, ...) | Not history | deleted (correct) |
| 7 | Variation mirror writes onto variation records | On the primary record | deleted (correct) |

Principle agreed: a derived write is noise when its cause is already recorded on a timeline
the reader can reach, and history when it is not. Scope of this spec: events 5 and 2 only.
Explicitly NOT in scope (decided 2026-09-09, "keep it simple"): reason stamps of any kind
(`updatedBy.context`, a per-object reason field), event 3, any UI work. Known limitation,
accepted: a kept row still shows only "value changed"; the reader opens the definition's
timeline for the why.

## Design

### Event 5: override released (classifier rule, plus a write economy)

Facts. The marker `fxOverrides` (`MARKER_FIELD_NAME`, `override-marker.ts`) is written through
one server funnel, `marker-converge.ts:123`, and one front path,
`src/front-components/lib/marker-toggle.ts:80-85`. Exactly two sites also write a recomputed
value for the same record in the same invocation: `handle-record-update.ts` (value at `:553`
via `recomputeForRecord`, marker at `:594`) and `formula-editor.tsx` (release recompute at
`:826`, marker at `:867`). The other four marker writers (`handle-formula-change.ts:188`,
`handle-definition-lifecycle.ts:129/207/253`, `marker-sweep.ts:297`) write no value.
The platform merges same-record, same-author, same-type rows inside a 10-minute window and
merges their diffs (`twenty-server/.../timeline-activity.repository.ts:242-259`, window
`:372`; ADR 0031:90-97 saw this live). So the two app writes at a paired site normally land
as ONE row already carrying both `fxOverrides` and the value, and that merged row is deleted
today only because every key in it is managed. ADR 0031:81-97 put the marker in the managed
set precisely so marker writes leave no permanent row; this spec reverses that on purpose.

Change:

1. In `timeline-cleanup.ts`, split the managed key set into two classes:
   - TRANSITION keys: `fxOverrides` (and nothing else today). A row whose diff contains any
     TRANSITION key is KEPT WHOLE; no stripping of co-occurring managed-value keys.
   - MANAGED-VALUE keys: the target field, its companion field, definition bookkeeping keys,
     variation-config bookkeeping keys, variation-synced fields. Unchanged behavior: deleted
     when the diff is only these, stripped when mixed with OTHER keys.
   - OTHER keys: everything else, kept (unchanged).
   This rule alone delivers event 5 for the merged-row case.
2. Write economy (optional, ADR 0022 spirit, not a correctness prerequisite): at the two
   paired sites, thread the marker key into the value write so one mutation carries both.
   Values go through `recompute.ts` → `batch-write.ts` (`PendingWrite.data`); markers through
   `marker-converge`. Doable, not a one-liner; the implementer decides per site whether the
   plumbing is worth one saved request.

Results: `formulaProbe: 543 -> 5432` alone is deleted; a row with `formulaProbe` and
`fxOverrides: "Formula Probe" -> ""` survives whole and reads "override released, value
recomputed". Marker-only rows (a converge that fixes only the marker, or a disable that clears
it) also survive; they are rare and are real ownership events. ADR 0031:425-429's "transient
row on definition-less objects" becomes permanent under this rule; accepted.

Residue, accepted: when the value write and the marker write straddle the 10-minute merge
window, the value row has no marker key and is deleted as jitter. Coalescing (step 2)
removes this residue at the two paired sites.

### Event 2: formula changed (classifier only)

Facts. formulaDefinition fields are named exactly `expression`, `enabled`, `allowOverride`,
`targetField`, `targetObject` (`src/objects/formula-definition.object.ts`). Definition rows
whose diff touches these survive today because `DEFINITION_BOOKKEEPING_KEYS`
(`timeline-cleanup.ts:77-85`) excludes them. `allowOverride` is immutable after create
(`INERT_FIELDS`, ADR 0028) and never triggers a recompute; `enabled` triggers one only on
false → true. `buildManagedModel` currently discards definition ids
(`loadFormulaManagedByObject`, `timeline-cleanup.ts:200` selects only
`targetObject`/`targetField`), while a definition timeline row carries only
`targetFormulaDefinitionId`.

Change, in `cleanupFormulaTimelineNoise`:

1. `loadFormulaManagedByObject` additionally selects `id` and returns a definition-id →
   `targetObject` map alongside the model.
2. Once per run, after `buildManagedModel`, load formulaDefinition `recordUpdated` rows (any
   author) in `[now - lookbackMs - CAUSE_WINDOW_MS, now]`: server filter = type id `eq` +
   `targetFormulaDefinitionId IS NOT NULL` + `happensAt gte`, `orderBy happensAt desc`, page
   size 100, capped at `CAUSE_MAX_PAGES = 5` (500 rows). The diff test (touches `expression`,
   `enabled`, `targetField`, or `targetObject`) runs in-process because the server cannot
   filter inside `properties`. Bookkeeping churn (`lastValue`, `lastEvaluatedAt`) shares this
   query, so the set is NOT tiny; the cap bounds it. Hitting the cap loses the oldest cause
   windows in the lookback (fail-safe direction: rows get deleted, not over-kept) and is logged
   like `truncated`. For the retro purge's 10-year lookback the cap means only the most recent
   500 definition rows contribute windows; documented in the script's header.
3. For each qualifying row, derive a cause window `[happensAt, happensAt + CAUSE_WINDOW_MS]`
   keyed by the definition's `targetObject` via the id map (unknown id → no window).
   `CAUSE_WINDOW_MS = 15 * 60 * 1000`, with this WHY comment: the definition lane runs
   `recomputeAllRecords` inside a 30 s trigger budget (`on-formula-definition-updated.ts:41`),
   so an in-band pass is far shorter than 15 min; a pass that overruns is killed without a
   cursor and its tail is finished by the hourly `formula-sweep` (ADR 0025:89-92), whose rows
   land hours later, outside every window, and are deleted. Accepted: large objects lose that
   tail of history in the fail-safe direction.
4. In `processRow`, after object/model resolution (`:590-594`) and before the strip/delete
   decision (`:626`, `:640`): parse `row.happensAt` (typed `unknown`; guard with
   `Number.isFinite(Date.parse(...))`, else no window applies) and return `kept` when the
   row's object has a window containing it. `processRow` gains the window map as a parameter
   (no module state).

Trade-offs, accepted: input-jitter rows inside a window are also kept (fail-safe direction,
bounded by 15 minutes per definition edit). A definition edit touching N records keeps N rows,
the same footprint as any bulk edit in the CRM.

### Not changing

`LOOKBACK_MS`, `PAGE_SIZE`, `MAX_PAGES`; the `recordUpdated` type gate; the
`workspaceMemberId IS NULL` filter; the target-column object resolution; the scripts' CLI.

## Efficiency (standing rule: every operation pays rent)

- Event 5: classifier cost is one more Set membership test per row. Coalescing, if done,
  removes one request per transition at the two paired sites.
- Event 2: one extra paginated query per run, capped at 5 pages; per-row cost is a Map lookup
  plus a numeric range test. No per-row requests.

## Testing

Unit (`timeline-cleanup.spec.ts`, fake client):
- merged single row (`fxOverrides` + target field in one diff) kept whole, no mutation;
- marker-only row kept; target-field-only row still deleted; target field + human key still
  stripped;
- a value row and a marker row split across the merge window: value row deleted, marker row
  kept (documents the residue);
- cause window: row inside window kept; row 1 ms outside deleted; row on a different object
  during the window deleted; window built from an `expression` change but not from a
  `lastValue`-only definition row; no windows when there are no qualifying rows; cap reached
  → logged, oldest windows dropped; unparsable `happensAt` → no window applies;
- if coalescing is implemented: one mutation per transition carrying both keys at each paired
  site.

Live on dev (dry-run first, then `--yes`): release an override on a seed company and edit a
definition's expression; confirm the merged transition row and the recompute rows inside the
window are `kept`, plain recomputes outside it are `deleted`, and counts match between dry-run
and wet.

## Delivery

One ADR (0033) recording the principle table and the two rules, stating that it amends
ADR 0031:81-97 (marker in the managed set) and ADR 0031:425-429 (transient marker row), and
extends ADR 0020/0022/0032. Subagent-driven development from a plan derived from this spec;
final opus review; dev live check; then the normal cloud deploy flow
(`app:publish --private -r cloud`, `app:install -r cloud`).
