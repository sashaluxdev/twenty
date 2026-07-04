# Formula Field UI Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle all six formula-field front-component surfaces to Twenty core's aesthetic with automatic dark/light adaptation, per the approved spec — zero functional changes.

**Architecture:** Spike-gate `twenty-sdk/ui` (Task 1). One shared UI module (`lib/ui-tokens.ts` + `lib/ui.tsx`) holds `var(--t-*)` tokens, a `WidgetRoot` ThemeProvider wrapper, and emotion-styled archetypes; the six surface files swap their hardcoded style objects for shared archetypes. Live both-theme screenshot verification closes it.

**Tech Stack:** twenty-sdk/ui (spike-gated), @emotion/styled (proven in-worker via style bridge), CSS custom properties `var(--t-*)`.

## Global Constraints

- **THE SPEC IS THE BINDING DESIGN**: `docs/superpowers/specs/2026-07-04-formula-field-ui-polish-design.md` — its "Archetype mapping" table gives the exact var()-level spec for every element; its "Platform facts" section answers mechanism questions. Every implementer reads it FIRST.
- NO functional changes: same handlers, same copy, same event wiring, same state machines (poll guard, drag, self-heal, two-step save). Wrapper elements are allowed; logic edits are not.
- App dir: `packages/twenty-apps/community/formula-field/`. Suite baseline 301 passing (`node /home/sasha_shin/twenty/node_modules/vitest/vitest.mjs run > <scratchpad>/vitest.log 2>&1; tail -20 …` from app dir); lint `/home/sasha_shin/twenty/node_modules/.bin/oxlint -c .oxlintrc.json .`; deploy `node /home/sasha_shin/twenty/node_modules/twenty-sdk/dist/cli.cjs dev --once` (must exit 0 every task).
- Front-component build is LENIENT — undefined identifiers fail only at runtime; every task that touches a component ends with a deploy + browser sanity check (clear IndexedDB `twenty-front-metadata-store` first).
- Never mix border shorthand + longhands across merged styles (React strips them).
- No hardcoded hex may survive in the six surface files EXCEPT: white (`#fff`) button-text-on-blue and the toggle knob (spec-sanctioned), and the dropdown shadow fallback if no `--t-box-shadow-*` var exists.
- Commits: one per task, `style(formula-field): …`, trailer `Claude-Session: https://claude.ai/code/session_01KeSEXorVgFXVcLcbWvdW2f`, stage only `packages/twenty-apps/community/formula-field` (+ plan file in Task 1).
- Theme toggling for verification: Settings → Experience → Appearance (Light/Dark), or `localStorage.setItem('persistedColorSchemeState', '"Dark"')` + reload. Screenshots → `<scratchpad>/ui-polish/<surface>-<theme>.png`.

---

### Task 1: GO/NO-GO spike — twenty-sdk/ui in a deployed widget

**Files:**
- Temporarily modify: `src/front-components/formula-definition-editor.tsx` (spike markup, REVERTED before commit)
- Possibly modify: `package.json` (add `@emotion/styled`/`@emotion/react` if the build demands them; `twenty-sdk` is already a dependency and `twenty-sdk/ui` is a subpath export — no new package for it)
- Create: `.superpowers/sdd/ui-spike-verdict.md` (verdict + evidence; NOT committed)

- [ ] **Step 1:** At the top of the definition editor's rendered output, temporarily add:

```tsx
import { Button, Status, ThemeProvider } from 'twenty-sdk/ui';
import { useColorScheme } from 'twenty-sdk/front-component';
// inside the component:
const colorScheme = useColorScheme();
// first child of the root div:
<ThemeProvider colorScheme={colorScheme}>
  <div style={{ display: 'flex', gap: '8px', padding: '8px' }}>
    <Button title="Spike" accent="blue" size="small" />
    <Status color="green" text="Spike" />
  </div>
</ThemeProvider>
```

- [ ] **Step 2:** `dev --once`. If the BUILD fails on these imports, capture the exact error → verdict NO-GO (skip Step 3).
- [ ] **Step 3:** Browser (clear IndexedDB, reload, open a FormulaDefinition record): confirm the button and pill RENDER, look core-styled, and the console has no errors from the widget. Toggle to Dark (constraint above), reload, confirm theme-correct colors. Screenshot both.
- [ ] **Step 4:** Write `.superpowers/sdd/ui-spike-verdict.md`: `VERDICT: GO` or `VERDICT: NO-GO` + evidence (build output / screenshots / console). REVERT all spike edits to the editor (git checkout the file); keep any package.json additions ONLY if emotion is needed for later tasks anyway.
- [ ] **Step 5:** Commit ONLY if package.json changed (`style(formula-field): add emotion deps for UI polish`); otherwise nothing to commit. Also stage `docs/superpowers/plans/2026-07-04-formula-field-ui-polish.md` in whichever Task 1/2 commit comes first.

---

### Task 2: Shared UI module

**Files:**
- Create: `src/front-components/lib/ui-tokens.ts`
- Create: `src/front-components/lib/ui.tsx`

**Interfaces (Tasks 3-5 import these exact names):**
- From `ui-tokens.ts`: `TOKENS` (const object of `var(--t-*)` strings, keys: `fontFamily, fontSizeXs, fontColorPrimary, fontColorSecondary, fontColorTertiary, fontColorLight, colorBlue, colorRed, colorOrange, colorGreen, colorTurquoise, accentTertiary, bgPrimary, bgTransparentLighter, bgTransparentLight, bgTransparentMedium, bgTransparentDanger, bgTransparentOrange, borderMedium, borderLight, borderStrong, borderDanger, radiusSm, radiusMd`).
- From `ui.tsx`: `WidgetRoot` (props: `children`; ThemeProvider + base container per spec §Architecture 2), `PrimaryButton`, `SecondaryButton`, `DangerButton`, `OutlineDangerButton`, `TextInput` (styled input), `TextArea`, `MonoInput`, `ChoiceChip` (prop `selected: boolean`), `StepperButton`, `BannerDanger`, `BannerWarning`, `DangerPanel`, `MutedText`, `HintText`, `ErrText`, `OkText`, `WarnText`, `SectionTitle`, `StepTitle`, `ToggleTrack`/`ToggleKnob` (or a `styleFor…` helper if the toggle stays inline-styled — implementer's call, documented), `DropdownPanel`, `DropdownOption` (prop `active: boolean`), `RowDivider` styles, `DragHandle`. If spike = GO: `PrimaryButton`/`DangerButton`/`SecondaryButton`/banner/status/title exports may be thin re-export wrappers around `twenty-sdk/ui` components pre-configured to spec (so consumers stay uniform); if NO-GO they are emotion replicas. EITHER WAY the export names above are what Tasks 3-5 import.

- [ ] **Step 1:** Read the spike verdict file + the spec's archetype table. Grep `node_modules/twenty-ui/dist/theme-light.css` (or `packages/twenty-ui/src/theme-constants/theme-light.css`) for `--t-box-shadow` — use the var if present, else the spec's fallback shadow.
- [ ] **Step 2:** Implement `ui-tokens.ts` (pure const, call-recorder pattern):

```ts
// Twenty core theme tokens as live CSS variables (see spec §Platform facts:
// widgets are light-DOM, so these resolve against the host's .light/.dark
// class and repaint on theme toggle with zero JS).
export const TOKENS = {
  fontFamily: 'var(--t-font-family)',
  fontSizeXs: 'var(--t-font-size-xs)',
  fontColorPrimary: 'var(--t-font-color-primary)',
  // …every key from the Interfaces list above, mapped per the spec table…
} as const;
```

- [ ] **Step 3:** Implement `ui.tsx` per the spec table. Representative example (all others follow the same shape; hover/focus via emotion pseudo-selectors; every interactive element gets `transition: background 0.1s ease`):

```tsx
import styled from '@emotion/styled';
import { TOKENS } from 'src/front-components/lib/ui-tokens';

export const TextInput = styled.input`
  background: ${TOKENS.bgTransparentLighter};
  border: 1px solid ${TOKENS.borderMedium};
  border-radius: ${TOKENS.radiusSm};
  color: ${TOKENS.fontColorPrimary};
  font-family: ${TOKENS.fontFamily};
  font-size: ${TOKENS.fontSizeXs};
  padding: 4px 8px;
  outline: none;
  &::placeholder { color: ${TOKENS.fontColorLight}; font-weight: 500; }
  &:focus { border-color: ${TOKENS.colorBlue}; }
`;
```

- [ ] **Step 4:** `dev --once` must exit 0 (the module compiles into a bundle even before consumers exist — import it from one component temporarily if tree-shaking hides errors, then remove). Lint clean. Suite 301/301 (untouched).
- [ ] **Step 5:** Commit `style(formula-field): shared core-aesthetic UI module (tokens + archetypes)`.

---

### Task 3: Restyle formula-editor.tsx (Formulas tab)

**Files:** Modify `src/front-components/formula-editor.tsx` only.

Mapping (old style key → new source): `container`→`WidgetRoot`; `title`→`SectionTitle`; `muted`→`MutedText`; `row`/`rowDragging`→`RowDivider` styles (dragging: bg transparent-light + border-top strong, 4-side longhands); `dragHandle(Active)`→`DragHandle`; `value`/`name`→inherit primary (drop explicit colors); `fieldLabel`/`toggleLabel`/`overrideHint`→`MutedText`/tertiary; toggle track/knob→`ToggleTrack`/`ToggleKnob` (green/red core solids, white knob, 150ms knob transition); `restored`/ok→`OkText` (turquoise); `button`→`PrimaryButton`; `buttonArmed`→`DangerButton`; `buttonDisabled`→ archetype's disabled prop/state; `confirmWarning`→`BannerWarning`; `error`→`ErrText`; `bannerOffline`→`BannerDanger`; `bannerUpstream`→`BannerWarning`; `staleNote`→`WarnText`.

- [ ] **Step 1:** Wrap the widget's return tree in `WidgetRoot`; delete the module-level `styles` colors it replaces (keep pure layout values — flex, gaps, margins — inline or in a slimmed layout-only styles object).
- [ ] **Step 2:** Swap every element per the mapping. Copy and handlers UNCHANGED (self-review: diff shows no handler/text changes).
- [ ] **Step 3:** Suite 301/301, lint, `dev --once` exit 0. Browser sanity: tab renders in light mode, no console errors, drag still previews and persists (one quick drag), save-arm flow still shows the warning.
- [ ] **Step 4:** Commit `style(formula-field): formula tab in core aesthetic`.

---

### Task 4: Restyle formula-definition-editor.tsx + field-settings-editor.tsx

**Files:** Modify both.

Mapping (definition editor): `container`→`WidgetRoot`; `value`→big value spec (primary, size xl, w600 — NOT blue); `label`/`muted`→`MutedText`; `hint`→`HintText`; `err`→`ErrText`; `ok`→`OkText`; banners→`BannerDanger`/`BannerWarning`; `button(+Disabled)`→`PrimaryButton`; `dangerZone` header→`SectionTitle` colored `TOKENS.colorRed`; `dangerButton`→`OutlineDangerButton`; `dangerPanel`/`dangerList`→`DangerPanel` (list text primary); `confirmInput`→`TextInput` with border danger override; `dangerConfirm`→`DangerButton`; `cancelButton`→`SecondaryButton`; `mono`/`readonly`→keep `ui-monospace`, color primary; dead `s.textarea` legacy key → DELETE. Field-settings editor: `sectionHeader`→`SectionTitle` (button reset styles preserved), `caret` 150ms rotate transition, `input`→`TextInput`, `save`→`PrimaryButton`, `lock`→`HintText`, rest per inline-text mapping.

- [ ] **Step 1:** Apply mappings, both files; layout-only values stay.
- [ ] **Step 2:** Suite/lint/deploy as always. Browser sanity: definition page renders, accordion opens with caret animation, danger zone opens, "type Delete" input focuses with blue border.
- [ ] **Step 3:** Commit `style(formula-field): definition editor + field settings in core aesthetic`.

---

### Task 5: Restyle wizard + format options + formula input

**Files:** Modify `lib/formula-setup-wizard.tsx`, `lib/format-options-fields.tsx`, `lib/formula-field-input.tsx`.

Mapping: wizard `stepTitle`→`StepTitle`; `filter`→`TextInput`; `chip(Selected)`/`choiceChip(Selected)`→`ChoiceChip selected={…}` (ONE archetype for both files); `create(+Disabled)`→`PrimaryButton`; `counterButton`→`StepperButton`; `mono` inputs→`MonoInput`; hints/errors/resume per inline-text mapping (`resume`→`WarnText`). formula-field-input: `inputStyle`→`MonoInput`/`TextArea` (mono); `dropdownStyle`→`DropdownPanel` (150ms fade+translateY entrance); `optionStyle`+active→`DropdownOption active={…}`; `optionApiName`→color `TOKENS.colorBlue`; `optionType`→`TOKENS.fontColorLight`; the two loose literal inline styles (relative wrapper, fontWeight 600 label) may stay as pure layout. Wizard root: wrap in `WidgetRoot`.

- [ ] **Step 1:** Apply mappings, all three files.
- [ ] **Step 2:** Suite/lint/deploy. Browser sanity: open wizard (new definition), chips select with blue/tint state, autocomplete opens with entrance animation and inserts on click.
- [ ] **Step 3:** Commit `style(formula-field): wizard, format options, formula input in core aesthetic`.

---

### Task 6: Both-theme live verification + functional smoke + gallery

**Files:** none (fixes loop into Tasks 3-5 files, committed `style(formula-field): <fix>`).

- [ ] Per spec §Verification: screenshot every surface in BOTH themes → `<scratchpad>/ui-polish/`: formulas tab (rows+handles+toggle+stale note if reachable via backdate), definition editor (+danger zone open, accordion open), wizard steps, autocomplete open, format options. Filenames `<surface>-<light|dark>.png`.
- [ ] Legibility audit per screenshot: no dark-on-dark/light-on-light, no stranded white boxes in dark, focus/hover states visible (hover the handle + an option, screenshot).
- [ ] Functional smoke: one drag persists (GraphQL order check), one expression save round-trips, autocomplete insert works, override toggle flips. Console clean on all surfaces.
- [ ] Fix anything broken (systematic-debugging; redeploy; re-screenshot).
- [ ] Report with the gallery file list.

---

### Task 7: Final review + docs + close

- [ ] Whole-branch review (most capable model): spec conformance (archetype table vs rendered), no functional drift (diff audit of handlers/copy), no surviving hex outside sanctioned exceptions, screenshot evidence cross-check.
- [ ] Fix findings; update `context.md` (UI polish DONE entry: mechanism facts — var(--t-*) light-DOM cascade, style bridge, spike verdict; new gotchas found).
- [ ] Final: suite 301/301, lint, `dev --once`, commit `docs(formula-field): context handoff — UI polish complete`, send gallery to user.
