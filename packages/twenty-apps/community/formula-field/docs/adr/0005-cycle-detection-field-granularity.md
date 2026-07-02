# ADR 0005 — Field-granular cycle detection, ignoring record ids

- Status: Accepted
- Date: 2026-07-02

## Context

Formulas can reference other formula-backed fields, so the dependency graph can
form a cycle (A = B + 1, B = A + 1), which would never converge. Cycles must be
rejected at save time, with a runtime depth guard as backup.

## Decision

Model each formula target as a `(object, field)` node. An edge
`target → dependency` exists when a formula reads a field that is **itself** a
formula target:

- same-record dependency `depField` on object `O` → node `(O, depField)`
- cross-record dependency `(refObject, recordId, refField)` → node
  `(refObject, refField)` — **the record id is intentionally dropped**.

Detect cycles with a three-colour DFS over this graph (`cycle-detection.ts`),
run at save time over the full set of enabled formulas plus the candidate. Reject
the save if a cycle is found and report the offending path.

## Consequences

- **Why drop the record id**: a formula on `(refObject, refField)` applies to
  every record of `refObject`, including the specific `recordId` a cross-ref
  points at. So a cross-record read of that field depends on that formula
  regardless of which record. Field-granular edges are **conservative**: they can
  only over-report a potential cycle, never miss a real one — the safe bias for a
  correctness guard.
- A rare false positive is possible (two formulas on the same object+field that
  never actually reference each other's records), accepted as the cost of
  guaranteed termination.
- Runtime `MAX_DEPTH_EXCEEDED` in the interpreter is the second line of defence
  if a cycle ever slips through (e.g. a formula edited directly in the DB
  bypassing the save-time validator).
