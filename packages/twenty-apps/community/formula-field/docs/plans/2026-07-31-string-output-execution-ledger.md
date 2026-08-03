# String Output Arc: Execution Ledger

Append-only. One entry per phase event. Companion to `2026-07-31-string-output-implementation.md`.
Entry classes: `dispatch`, `report`, `verdict`, `deviation`, `phase-done`, `setup`, `baseline`.

## 2026-08-03

- [setup] Feature branch `feat/formula-field-string-output` created off `main` at `8cdb21cddc`. Implementation plan committed as `3a810a89e7` (was untracked).
- [baseline] Whole unit suite **962 passed** (62 files) — matches the plan's stated baseline. Engine subset **301 passed** (6 files) — matches. `oxlint -c .oxlintrc.json .` — 0 warnings, 0 errors on 164 files.
- [baseline] `npx tsc --noEmit` — clean (exit 0), but only after `npx tsc --build` has been run once in the checkout. See deviation below.
- [deviation] Plan Global Constraint "Type check: `npx tsc --noEmit`" is incomplete in a fresh/stale checkout. `tsconfig.json` references the composite project `tsconfig.spec.json`; when that project's outputs are absent, `tsc --noEmit` reports **96 spurious TS6305** ("output file has not been built from source file") and nothing else. Fix: run `npx tsc --build` once, then `npx tsc --noEmit` is clean. Deleting `dist/tsconfig.spec.tsbuildinfo` alone does not help. Plan constraint amended to state this.
- [deviation] Pre-existing, out of scope: `npx tsc --build` itself reports **32 errors inside the spec project only** (10 TS2591 missing `@types/node` globals, 9 TS2694 `VariationConfig` absent from the workspace-resolved `twenty-client-sdk` schema, 5 TS2307 unresolved modules, 3 TS2339, 3 TS18046, 2 TS2322). These live in `.tsx` and spec-config-only files that the plan's prescribed `tsc --noEmit` never checks, and they exist on `main` before any arc work. Not a regression signal; do not let an implementer "fix" them as part of a task. If an implementer's report cites any of these codes, check it against this baseline first.
- [status] Setup complete, no task dispatched yet. **next:** dispatch Phase A (Workflow: `pipeline([T1,T2,T3], implement, review)`, implementers in `isolation: 'worktree'`, T1 sonnet / T2 opus / T3 opus).
