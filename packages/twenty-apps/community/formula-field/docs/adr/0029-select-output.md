# ADR 0029: SELECT output — engine lane and the option-membership gate

**Status: IMPLEMENTED (design approved 2026-08-10; implemented 2026-08-12).**
Design spec: `docs/superpowers/specs/2026-08-10-select-output-design.md`
(repo root `docs/`, §§1–10, sections cited below).
Implementation plan: `docs/superpowers/plans/2026-08-10-select-output.md`.
Sharpens ADR 0026's closing commitment on SELECT; supersedes nothing.

## Context and contract

ADR 0026 closed with a verbatim commitment (its lines 327–338, restated in
ADR 0027:320–321 and the v0.4.0 spec's §7 backlog): "SELECT joins the
expressible bucket as a text-kind target with one extra write-time step (the
computed string must match a defined option value, else standard eval-error
doctrine applies). Storage, convergence, and override detection already ride
the text columns built here. The remaining work is almost entirely the
wizard: an options editor (values, labels, colors) mirroring Twenty's native
SELECT creation, plus post-creation settings editing." (spec §1.)

This ADR honors that contract and sharpens it in two places. First, membership
checking is two-tier rather than runtime-only, because a runtime-only check
violates the standing efficiency doctrine for the most common formula shape —
a typo'd literal in an IF/SWITCH ladder would otherwise re-fail every record
on every sweep pass forever instead of freezing once, for free (spec §2,
approach A vs. B). Second, the ADR's "post-creation settings editing" clause
is narrowed by user ruling: options are data-model-owned, and the app defines
them exactly once at field creation and never edits them afterward (D7 below;
spec §9 ruling 4) — stricter than the add-plus-rename editor ADR 0026 had
sketched.

## Decision: lane move

SELECT leaves the mirror lane and joins the engine family (spec D1):

- `ENGINE_FAMILY` gains `'SELECT'`; `MIRRORABLE_KINDS` drops it. The two sets
  stay disjoint and `SYNCABLE_KINDS` (their union) is unchanged — the same
  invariant the ADR 0026 TEXT move pinned.
- `EXPECTED_KIND_BY_TARGET` gains `SELECT: 'text'`, compiler-forced the moment
  `TargetFieldKind` grows a `'SELECT'` member; the existing
  `ENGINE_FAMILY_KINDS.has()` guard in `strictKindGateError` flips SELECT
  targets from always-skip to gated automatically, with no bespoke branch.
- `fieldTypeToKind` is untouched: SELECT stays kind `'text'` as an input. A
  SELECT target accepts any text-kind expression at the kind tier; membership
  is the extra gate (D3 below).
- A bare reference onto a SELECT target stops being a mirror definition
  (`isMirrorDefinition` returns false once SELECT leaves `MIRRORABLE_KINDS`)
  and becomes a one-term engine formula instead — same verbatim string write,
  better failure modes. The mirror lane keeps MULTI_SELECT, BOOLEAN, RATING,
  LINKS, FULL_NAME, ADDRESS, EMAILS, PHONES, ARRAY, RAW_JSON.

## Decision: `usesTextDomain`

Four places in the codebase hard-coded `'TEXT'` as "the string-domain target"
and would have silently corrupted SELECT data if missed on the lane move:
`tagEngineValue` (a SELECT string would fall into the number lane and null
out), `overrideSlotForKind` (pin misrouted to the numeric column),
`pinnedOverrideValue` (pinned SELECT read from the wrong column), and
`usesTextSlot`/`pinnedEngineOverrideValue` (spec D2).

Decision: one predicate, not a second literal. `usesTextDomain(kind:
TargetFieldKind | 'raw'): boolean` in `value-io.ts`, true for
`'TEXT' | 'SELECT' | 'raw'`, and every literal `kind === 'TEXT'` domain check
rewritten through it — the four sites above plus the TEXT arms of
`normalizeStoredValue`, `normalizeComputedValue`, and `buildTargetWriteData`.
The `'raw'` arm is load-bearing: two call sites type their slot as
`OverrideSlotKind = TargetFieldKind | 'raw'`, and `'raw'` carries every
deployed mirror override (MULTI_SELECT, LINKS, ...), so it has to stay true; a
drift-guard test pins all three members. `pinnedEngineOverrideValue`'s guard
is a direct `slot !== 'TEXT'` comparison, not a `usesTextSlot` call — a third,
separate edit in that file, not covered by rewriting `usesTextSlot` alone.
This closes the whole "second text-domain target" trap class structurally
instead of patching call sites one at a time. `ComputedValue` keeps its
existing `'number' | 'text' | 'raw'` tags unchanged: a SELECT result tags
`'text'`, so the heartbeat lane works with no edit.

## Decision: two-tier membership gate

A computed SELECT value must name a defined option, checked two ways (spec
D3):

**The walker.** A new pure engine function, `staticTextOutputs(ast):
ReadonlySet<string> | null`, where `null` means "open set" (statically
undecidable). A `string` node contributes its literal value; an `if` node
contributes the union of its `then`/`else` outputs (never the condition);
`ifblank` contributes the union of both arguments; everything else in a value
position — field refs, crossrefs, `&`, `TEXT()`, `NUMBER()`, arithmetic,
`SUM`, `TODAY`, number literals — poisons the whole result to `null`. IFS and
SWITCH desugar to `if` ladders before the walker runs, so label ladders come
for free. It runs only for SELECT targets, only after the kind gate has
already passed, and costs O(nodes) — save-time and pass-time only, never per
record.

**Tier 1a — save gate.** With a closed literal set and options in hand, every
non-blank literal must be a member of the option value set (blank literals
mean "clear", D4). A violation follows the standard save posture: the
definition saves but is **disabled**, with the error on `lastError` — same
save-vs-recompute asymmetry the kind gate already has. An open set is
accepted (tier 2 covers it); unresolvable options skip rather than reject
(the standing ADR 0027 posture). Because validation-core is the single shared
dispatch, the editor's live check gets this gate for free.

**Tier 1b — per-pass static re-gate.** The recompute paths already re-run the
static gates once per definition per pass before any record work; a new
`selectMembershipGateError` runs alongside `strictKindGateError` there. For a
closed set, it re-validates against the *current* option set, so deleting an
option a formula's literal names **freezes the whole definition
write-avoidantly** through the existing whole-definition-refusal path: zero
record scans, error on the definition row, zero repeat-pass writes. This is
where the two-tier design structurally beats runtime-only checking: option
drift on the common formula shape costs one static check per pass instead of
N failed evaluations per pass, forever.

The freeze's blast radius was disclosed to and accepted by the user (ruling
3, spec §9.3, posture (a)): the membership gate joins the same gate-error map
that override detection and the v0.4.0 locked-definition revert already
consult, so **both lanes freeze together**. While frozen, a definition
records no overrides and performs no lock reverts; outside writes to the
target field stick until the options are fixed. This is not permanent —
the gate reads the same 60-second-TTL metadata cache as everything else, so
it **self-heals within that window** once the option is restored natively,
with no redeploy and no manual unfreeze.

**Tier 2 — per-record membership check.** At the existing normalize-then-write
choke point, a `Set.has` against the hoisted option set runs unconditionally
for SELECT targets (defense in depth against mid-pass metadata drift; O(1),
no I/O). A miss raises a new `NOT_AN_OPTION` eval error under standard
doctrine: value not written, last value kept, error on `lastError`, record
save never blocked, zero timeline rows. `null` bypasses the check and writes
through (clears the field), matching the platform's own SELECT semantics.
The platform independently validates SELECT writes on the GraphQL path and
rejects non-members loudly, so tier 2 never risks silent corruption — its job
is a formula-doctrine error instead of a generic write-failure wrapper, and
keeping a non-member value out of a batch so the batch write path never falls
back to its costlier per-record retry.

## Decision: blank-clears and option plumbing

**Blank-clears (D4, ruling 2, confirmed).** Computed `null` writes `null` and
clears the field (wizard-created value fields are always nullable). Computed
blank text (empty or whitespace-only) normalizes to `null` in the SELECT arm
of `normalizeComputedValue`, because the platform makes `''` structurally
impossible as an option value — without this rule, every `&`-chain whose
parts are all null would be a permanent per-record error. Blankness already
means "null or empty/whitespace text" everywhere in the language
(ISBLANK/IFBLANK doctrine), so this is the consistent reading, not a new
coercion. Consequence for the static tier: blank string literals in branches
are legal, and the walker's membership check applies to non-blank literals
only. No interaction with the F1 empty-string bug: that concerns `""`
persistence on TEXT dependency fields, and a SELECT target never legitimately
holds `""` under this design.

**Option plumbing (D5).** No new queries, no new hot-path I/O. The option
data is already resident in the existing 60-second-TTL, process-global,
workspace-keyed metadata cache (`loadAllObjectsWithFields`) — the same cache
entry the kinds map reads. What was missing was an accessor: a new
`targetFieldOptions(objectName, fieldName)` in `metadata-objects.ts`, null
when the field or its options cannot be resolved. The recompute pass resolves
it once alongside the kinds map, builds it into a `ReadonlySet<string>` once,
and threads it through the existing args plumbing to the static re-gate and
the per-record check — once per pass, once per event, never per record, the
same discipline ADR 0027 established for the kinds map. The save path stays
synchronous: validation-core takes options as plain data, and
`handle-formula-change.ts` preloads them alongside its existing kinds
preload. Undefined options at any call site degrade to skip-never-reject; the
recompute paths always resolve them, so a definition cannot permanently dodge
the gate. An empty options array is treated as unresolvable (skip) everywhere,
since the platform guarantees a created SELECT field has at least one option.

## Decision: errors

- **Static gate message**, identical across the editor's live check, save,
  and the per-pass re-gate: `Formula can produce "Hot", which is not an
  option of the target field (options: HOT, COLD, NEW)` — the option list
  bounded to the first 6 values plus an ellipsis. When the offending literal
  case-insensitively matches an option value or label, the message appends
  `Did you mean "HOT"?`, catching the label-vs-value trap (users think in
  labels; the platform forces UPPER_SNAKE values) at zero runtime cost.
- **Runtime error**: new `FormulaError` code `NOT_AN_OPTION`; the existing
  funnel prefixes the code, so the surfaced string is `NOT_AN_OPTION: "WARM"
  is not an option of dealStage` (value excerpt bounded to 80 chars),
  matching the `NON_NUMERIC_VALUE`/`TEXT_TOO_LONG` precedent.
- **Staleness honesty**: gate results read the same 60-second-TTL metadata
  cache as everything else, so after an options edit the worker-side gates
  self-heal within a minute — freeze and error copy must not read as
  permanent state.
- No new UI surface: both strings ride the existing `liveError`/`lastError`
  channel into both editors' error display. The kind-gate mismatch message
  for SELECT targets stays generic (a SELECT holds text values, so the
  existing text-mismatch copy is accurate); the membership gate carries the
  SELECT-specific vocabulary. Matching is by option **value**, case-sensitive,
  exactly like every other string comparison in the language — no label
  matching, no case folding at runtime.

## Decision: one-time options

The wizard's format flow gains a 9th `select` entry with an options editor:
ordered rows of label + color, with the option value auto-derived from the
label (uppercase, non-alphanumerics collapsed to `_`, no leading digit or
double underscore, 63-char cap) to satisfy the platform's validator, shown
read-only per row. The draft persists in `targetFieldSettings` JSON the same
way the mirror draft does, so the wizard resumes mid-draft. Creation sends
`options` with no ids — the server assigns v4 ids.

**Post-creation, the app never touches options again.** This is stricter than
the design's own earlier draft, which had proposed an add-plus-rename
settings editor; ruling 4 (spec §9.4) overrode it explicitly: options are
data-model-owned, the app must not be able to change dropdown options at all,
and the wizard's one-time creation step is confirmed as the field's origin.
The drafted add-plus-rename editor is **deleted from scope, not deferred** —
this deletes from the app's surface the options load/save in the field
settings editor, the id-preserving full-replace dance, and any exposure to
the server-side enum rebuild (the platform update is full-replace keyed by
id; omitting an id is a silent delete-and-recreate, and removal silently
remaps records to default/NULL — exactly the risk class the ruling keeps out
of the app). The field settings editor keeps label editing and gains only a
dispatch case so it stops falling through to the wrong settings form; options
render read-only at most and the app never sends an `options` key again. The
per-pass static gate plus tier 2 turn native option drift into visible
freezes/errors instead of silent damage, and gate error copy points the user
at native field settings.

**Mirror-flow reroute (D8).** The wizard's "Mirror another field" flow keeps
offering SELECT sources, but the created definition now rides the engine
lane: an `isSelectTarget` check routes to `outputFormat: 'select'`, clones
the source's options onto the new field, and seeds a one-term formula (bare
ref same-record, crossref cross-record) with an open literal set, so tier 2
covers post-creation drift between source and target. This deliberately
diverges from the TEXT precedent (ADR 0026's B8, which dropped TEXT from the
mirror picker entirely): a TEXT copy loses nothing by being typed as a
one-term formula in the format flow, but dropping SELECT from the picker
would lose option cloning, which is real setup work the mirror flow is the
only place that does.

## Back-compat

Zero data rewrite, zero schema changes, no migration — matching ADR 0026's
posture (spec §4):

- **Deployed SELECT mirrors become one-term engine formulas** automatically
  at the lane move: same verbatim string write, same convergence compare, and
  the override slot is encoding-compatible (a deployed SELECT-mirror override
  or heartbeat round-trips through the new lane unchanged). Their behavior
  improves: the kind gate now applies, and membership violations become
  doctrine errors instead of generic write failures.
- **One save-time check loosens**: SELECT targets leave mirror branch 1c, so
  its same-kind rule ("Cannot mirror TEXT field onto a SELECT field") no
  longer applies. A TEXT-source bare ref onto a SELECT target now validates
  at save (both are kind `text`) and is covered only by tier 2 per record —
  intended, since any text-kind expression is legal at the kind tier and
  membership is the real gate.
- Legacy `outputFormat: 'mirror'` values on SELECT definitions stay as-is:
  **front-end dispatch treats `targetFieldType` as authoritative**, not
  `outputFormat` (the ADR 0026 TEXT precedent left existing rows' outputFormat
  untouched the same way). One user-visible change: the definition editor's
  read-only "Mirrors X" provenance panel is gated on mirror-target kind, so
  deployed SELECT mirrors flip to the field-settings-editor branch after the
  move; the new SELECT dispatch case is what keeps that panel from rendering
  a NUMBER settings form over a SELECT field.
- Old definitions whose expression now violates the membership gate (e.g. a
  closed literal set naming a deleted option) are not migrated or
  auto-disabled: they freeze under the per-pass static gate with the reason
  on the definition row, the same ADR 0027 legacy-gating doctrine verbatim.
- `formula-definition.object.ts`'s `targetFieldType` is free text (no enum
  constraint), so `'SELECT'` stores with no schema work; only the description
  string needed updating.

## Cost model (every operation pays rent)

Reproduced from spec §5:

| Path | Added cost | Notes |
|---|---|---|
| Save / live edit (SELECT targets only) | 1 AST walk O(nodes) + O(literals) set lookups | Editor and server share one code path; zero cost for other targets |
| Recompute pass, per SELECT-target definition | 1 metadata cache read (usually hot), 1 Set build O(options), 1 closed-set re-check O(literals) | The options read and the kinds read ride two 60s caches with independent clocks; worst case one shared, in-flight-deduped metadata pull per worker per 60s, cache-hit in the common case |
| Per record (SELECT targets only) | 1 `Set.has` at the existing normalize-then-write choke point | O(1), no I/O, no allocation |
| Event path, per event | Same as per-pass, once | Same once-per-event discipline as the kinds map |
| Broken definition (closed set, e.g. typo or option drift) | 1 static check per pass, zero record scans, zero writes | vs. approach A's N failed evaluations per pass forever |
| Broken records under an open set | 1 eval + 1 failed membership check per record per pass, zero writes | Irreducible: statics cannot decide; error string stable so heartbeat writes nothing on repeat passes |
| Options create | 0 extra mutations (rides the existing `createOneField`) | |
| Options edit (post-creation) | Zero: the app never edits options (user ruling); native settings own them | The server-side enum rebuild cost lives entirely outside the app |
| Non-SELECT formulas | Zero | Every new branch is behind a `targetFieldType === 'SELECT'` guard |

No new queries on any hot path; no per-record metadata access; no new writes
on converged state.

## Residue

Reproduced from spec §8, verbatim in substance:

- **Any in-app option editing** ("add missing options" one-click fix,
  add/rename/remove in the settings editor): ruled out by the user
  2026-08-10, not deferred. Options are data-model-owned; **do not resurrect
  these as backlog items.**
- **Output-side autocomplete** (suggest option values inside IF/SWITCH
  branches when the target is SELECT): polish backlog; the did-you-mean hint
  covers the typo class at zero UI cost.
- **Label rendering in app widgets**: display-value shows the raw option
  value, a pre-existing gap that now becomes more visible; cheap follow-up,
  not v1.
- MULTI_SELECT output; label-based matching; any language change — all still
  out of scope.
