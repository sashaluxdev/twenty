# ADR 0030: Blank-TEXT convergence — equality-side widening, not read-side folding

**Status: IMPLEMENTED (design reviewed 2026-08-13, opus; implemented 2026-08-13).**
Implementation plan: `docs/superpowers/plans/2026-08-13-formula-fix-wave.md`
(repo root `docs/`, Task 1, "F3 — blank-equivalent TEXT convergence on both
lanes"). Live verification pending (plan Task 4). Record-lane sibling of the
definition-row F4 fix (`storedValueText`, `formula-repository.ts:392-401`).

## Context

The platform's write path collapses both `''` and `null` to SQL NULL for a
TEXT column (`transform-text-field.util.ts`, via
`isNullEquivalentTextFieldValue`), and its read path expands a stored SQL NULL
TEXT column back to `''` (`DEFAULT_TEXT_FIELD_NULL_EQUIVALENT_VALUE`). A TEXT
column can therefore never actually hold `''` in storage — stored-blank and
stored-empty are ONE indistinguishable state, always read back as `''`.

The two convergence checks that compare a freshly computed engine value
against that stored read — the recompute no-op guard (`valuesEqual`,
`recompute.ts`) and the event lane's `storedValuesEqual`
(`handle-record-update.ts`) — used plain strict `===` before this fix. A TEXT
formula that legitimately computes `null` (blank) against a target column
whose stored blank always reads back as `''` therefore compared `null !==
''` and rewrote the column on every pass, forever: the compared value never
changes, so the no-op guard never fires.

This is finding F3: observed live 2026-08-12/13 on the RECOMPUTE lane, 301
rows rewritten every sweep pass, `updatedAt`/`updatedBy` falsified on each
pass. The event lane has the same shape of exposure — an event's `after`
payload carries a NULLed TEXT column as post-`formatResult` `''`, never
`null` — but that manifestation is code-verified only; no live event-lane
incident was observed, and this ADR does not claim one.

Prior art: the definition-row heartbeat (`lastValueText`) hit an adjacent
shape of the same platform behavior and was fixed first (F4, `storedValueText`,
`formula-repository.ts:392-401`). See "Why not read-side folding" below for
why that fix's shape does not transfer to this one.

## Decision

`textValuesConverged` (`value-io.ts`) widens equality for kind TEXT only, at
exactly the two convergence checks above:

```ts
export const textValuesConverged = (a: EngineValue, b: EngineValue): boolean =>
  a === b || ((a === null || a === '') && (b === null || b === ''));
```

`null` and `''` compare equal in either operand position — the two call
sites pass (computed, stored) and (stored, computed) at different points, so
the rule is symmetric by construction rather than relying on argument order.
It is wired in at exactly two sites, both on the equality side, nowhere else:

- **Recompute no-op guard** (`recompute.ts`, `valuesEqual`): dispatches to
  `textValuesConverged` when `kind === 'TEXT'`, else falls back to plain
  `===`.
- **Event-lane `storedValuesEqual`** (`handle-record-update.ts`): same
  dispatch, guarding both the "is this event echoing our own write" check and
  override detection.

Read (`normalizeStoredValue`) and write (`buildTargetWriteData`) are
UNCHANGED. A stored `''` still reads back as `''`, not folded to `null`, and
a computed `''` is still written as `''` in the mutation payload. The fix is
an equality-side rule only; nothing about what is stored or read changes.

### Why not read-side folding (the forcing cell)

The obvious-looking alternative is to fold the stored read itself — treat a
stored `''` as `null` before comparing, the same shape as the F4 fix
(`storedValueText`) folds `lastValueText`. That shape does not transfer here,
and the reason is the one cell the F4 heartbeat never has to worry about: a
genuinely computed `''`.

`storedValueText`'s bookkeeping column (`lastValueText`) legitimately holds
`null` and never `''` — every non-null value is JSON-encoded to at least two
characters, so `''` on that column can only mean "nothing stored." Folding it
to `null` is lossless.

The record-lane VALUE column has no such guarantee. A TEXT formula can
genuinely compute `''` — an all-blank `&` concat (ADR 0026 D2) or a bare `""`
literal — and that computed `''`, written and read back, is a real,
meaningful result, not an absence. If the read side folded a stored `''` to
`null` before comparing, that cell would compare `null` (folded stored)
against `''` (freshly computed) on every pass and never converge — trading
F3's infinite loop for a new one over a different cell of the same matrix.
Equality-side widening is the only rule that terminates in every cell: (`null`
computed, stored reads `''`), (`''` computed, stored reads `''`), and every
kind other than TEXT untouched.

One clarification about `buildTargetWriteData`'s own comment ("an empty
string is written AS an empty string … not collapsed to null — only a null
result clears the field"): that describes the shape of the MUTATION PAYLOAD
this app builds, not final storage. The platform's own write-side transform
(`transform-text-field.util.ts`) still collapses that payload's `''` to SQL
NULL before it lands in the column — the distinction between a written `''`
and a written `null` exists only in the mutation payload, never in what ends
up on disk. This ADR does not change that comment or the payload it
describes; it only widens how a stored read compares against a computed
value.

## Consequences

- A blank-computing TEXT formula (e.g. an `IF` branch that resolves to `""`
  or `null`, or any other blank-producing expression) now performs ZERO
  writes over an already-blank column, on both lanes, indefinitely — no more
  per-pass rewrite, no falsified `updatedAt`/`updatedBy`, no spurious
  override pin on the event lane.
- The app still never tries to distinguish a stored SQL NULL from a stored
  `''` — it cannot, since the platform makes that distinction
  unrepresentable for TEXT. `textValuesConverged` treats them as the same
  value for convergence purposes; it does not pretend to recover which one is
  actually in the column.
- SELECT, NUMBER, CURRENCY, DATE, and DATE_TIME targets keep strict `===`
  identity — the widening is TEXT-only, gated on `kind === 'TEXT'` at both
  call sites, and the boundary is pinned by test (`value-io.spec.ts`,
  `recompute.spec.ts`, `handlers.spec.ts`) so a future change cannot silently
  widen it to SELECT (which shares the text-domain read/write helpers but not
  this equality rule) or narrow it back to strict identity for TEXT.
- Blank-over-blank is now indistinguishable from the app's own write, so a
  human edit that leaves a TEXT field blank while the formula also computes
  blank no longer creates or refreshes an override pin; an existing ACTIVE
  pin whose holder clears the field goes stale (a later reactivate/restore
  writes the old pinned value back over the blank). This is inherent to
  equality-side convergence and accepted: the alternative — folding the
  widening out of override detection — pins records the user never actually
  touched.
