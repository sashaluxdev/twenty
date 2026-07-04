# Formula Field UI Polish — Design (approved "green light" 2026-07-04)

Goal: pure UI/aesthetic pass over all six front-component surfaces so the app
blends seamlessly into Twenty core's look, light AND dark mode. NO functional
changes: handlers, data flow, copy, and behavior stay identical; only styles,
minimal wrapper structure, and visual affordances change.

User decisions: use REAL `twenty-sdk/ui` components (spike-gated, silent
fallback to pixel-faithful replicas if the bundle misbehaves).

## Platform facts (verified by scouts; cite before doubting)

- Widgets render as **light-DOM React elements inside the host document** (no
  iframe/shadow root). Host CSS cascades in; `style` strings pass through
  verbatim (naive parse, no sanitization) — `var(--t-*)`, `calc()`, etc. work.
- Twenty ships its whole theme as CSS custom properties: `.light`/`.dark`
  class on `<html>` selects between two always-loaded stylesheets
  (`twenty-ui/theme-light.css` / `theme-dark.css`). Inline `var(--t-*)`
  references therefore adapt live on theme toggle, zero JS.
- SDK exposes `useColorScheme(): 'light'|'dark'` (twenty-sdk/front-component)
  and `twenty-sdk/ui` (re-exports twenty-ui `Button`, `Chip`, `Tag`, `Status`,
  `Banner`, `Callout`, `Info`, `H1/H2/H3Title`, `Label`, `ThemeProvider`,
  `useTheme`). Documented for front components; NOT excluded from the
  front-component bundle; unverified at runtime here (call-recorder avoided it
  with a "until its bundle is safe" comment) → spike required.
- `@emotion/styled` IS proven in front components (call-recorder uses it);
  CSS-in-JS `<style>` tags stream to the host head via the renderer's style
  bridge (`installStyleBridge.ts` → `RemoteStyleRenderer`), so real
  `:hover`/`:focus`/transitions work.
- Current state: six files, ~10 archetypes duplicated with hardcoded hex; the
  root containers set near-black text with no background (invisible on dark).

## Architecture

1. **Task 0 — GO/NO-GO spike**: render one `twenty-sdk/ui` `<Button>` and
   `<Status>` inside a deployed widget (temporary, behind existing UI),
   verify live in BOTH themes (render + theme-correct colors + no console
   errors + bundle builds). GO → adopt sdk/ui components per mapping below.
   NO-GO → silent fallback: identical visual specs implemented as emotion
   replicas in the shared module (visual outcome unchanged); record the
   failure signature in context.md.
2. **Shared module `src/front-components/lib/ui.ts`** (may split into
   `ui-tokens.ts` + `ui.tsx` if cleaner):
   - `WidgetRoot`: wraps each widget's tree in `twenty-sdk/ui ThemeProvider`
     (colorScheme from `useColorScheme()`) + base container style
     (`color: var(--t-font-color-primary)`, `fontFamily: var(--t-font-family)`,
     `fontSize: var(--t-font-size-xs)`, transparent background).
   - `TOKENS`: named `var(--t-*)` references (call-recorder pattern).
   - Emotion-styled archetypes for everything sdk/ui doesn't cover.
3. All six files (`formula-editor.tsx`, `formula-definition-editor.tsx`,
   `lib/formula-setup-wizard.tsx`, `lib/formula-field-input.tsx`,
   `lib/field-settings-editor.tsx`, `lib/format-options-fields.tsx`) consume
   the shared module; every hardcoded hex dies; the six duplicated style sets
   collapse to one.

## Archetype mapping (exact specs in var terms)

| Archetype | Source | Spec |
|---|---|---|
| Section titles / step headers | sdk `H3Title`/`Label` (GO) else styled | color primary / tertiary for step numbers; weight 500 |
| Primary button (Save/Create) | sdk `Button` accent=blue size=small (GO) | bg `var(--t-color-blue)`, text `#fff` (core hardcodes white on blue in both modes), radius 4px, h 24px, pad 0 8px, w500, hover `var(--t-color-blue10)`, focus ring `0 0 0 3px var(--t-accent-tertiary)`, disabled per core (`--t-accent-accent4060` bg) |
| Neutral/cancel button | sdk `Button` variant=secondary | transparent bg, border 1px `var(--t-background-transparent-medium)`, color `var(--t-font-color-secondary)`, hover bg `var(--t-background-transparent-light)` |
| Danger solid (destructive confirm) | sdk `Button` accent=danger | bg `var(--t-color-red)`, color `var(--t-background-primary)`, hover `var(--t-color-red8)` |
| Outline danger (Delete Completely…) | styled | transparent bg, border 1px `var(--t-border-color-danger)`, color `var(--t-color-red)`, hover bg `var(--t-background-transparent-danger)` |
| Armed save (2nd-click confirm) | keep primary geometry, danger colors | as danger solid |
| Text inputs (all) | styled | bg `var(--t-background-transparent-lighter)`, border 1px `var(--t-border-color-medium)`, radius `var(--t-border-radius-sm)`, color primary, placeholder `var(--t-font-color-light)`, `:focus` border `var(--t-color-blue)` (no ring — core TextInput), formula/API-name inputs keep `ui-monospace` |
| Selectable chips (wizard objects/formats, format options) | styled (core Chip is a record chip, wrong semantics) | unselected: transparent bg, border `var(--t-border-color-medium)`, color secondary, hover bg transparent-light; selected: border `var(--t-color-blue)`, bg `var(--t-accent-tertiary)`, color `var(--t-color-blue)`; radius 4px |
| Stepper +/- | styled, same recipe as neutral button, 24×24 |
| Status banners (OFFLINE / UPSTREAM / confirm-warning) | sdk `Banner`/`Callout` secondary (GO) else styled | danger: bg `var(--t-background-transparent-danger)` color `var(--t-color-red)`; warning: bg `var(--t-background-transparent-orange)` color `var(--t-color-orange)`; radius `var(--t-border-radius-md)`, pad 8px, w500 |
| Danger-zone panel | styled | border 1px `var(--t-border-color-danger)`, bg `var(--t-background-transparent-danger)`, title/text `var(--t-color-red)`, list items color primary |
| Inline status text | styled spans | muted/hint/labels `var(--t-font-color-tertiary)`; err `var(--t-color-red)`; ok `var(--t-color-turquoise)` (core sync-ok convention); stale/resume `var(--t-color-orange)`; lock `var(--t-font-color-light)` |
| Override toggle | styled (no sdk export) | keep geometry + red/green SEMANTICS; track `var(--t-color-green)`/`var(--t-color-red)` (core solids), knob white, knob transform transition 150ms ease |
| Autocomplete dropdown | styled | bg `var(--t-background-primary)`, border 1px `var(--t-border-color-medium)`, radius `var(--t-border-radius-md)`, shadow: use `--t-box-shadow-*` var if present in theme-light.css (implementer greps; else `0 2px 4px rgba(0,0,0,0.04), 0 0 4px rgba(0,0,0,0.08)` core-ish); option hover/active bg `var(--t-background-transparent-light)`; api-name col `var(--t-color-blue)`, type col `var(--t-font-color-light)` |
| Drag rows + handle | styled | row divider border-top 1px `var(--t-border-color-light)`; dragging: bg `var(--t-background-transparent-light)`, border-top `var(--t-border-color-strong)` (4-side longhands rule stands); handle `var(--t-font-color-tertiary)`, hover bg transparent-light radius 4px, cursor grab/grabbing |
| Big value display (definition editor) | styled | color `var(--t-font-color-primary)` (not blue — core reserves blue for links/actions), size `var(--t-font-size-xl)`, w600 |

## Motion (core conventions only)
- Every interactive surface: `transition: background 0.1s ease`.
- Dropdown + banners: 150ms ease fade-in (+4px translateY for dropdown).
- Toggle knob / accordion caret: 150ms ease transform.
- Nothing else animated.

## Constraints
- No functional changes: same handlers, same copy, same DOM event wiring; the
  poll guard / drag state machine / self-heal / two-step save are untouched.
- Front-component build is lenient — every identifier must exist; deploy +
  live check is mandatory per task.
- If sdk/ui needs a package.json dependency addition in the app, that's
  allowed (bundler handles); emotion likewise.
- Never mix border shorthand/longhands across merged styles (known React bug).

## Verification (definition of done)
- Playwright, BOTH themes (toggle via Settings → Experience/Appearance, or
  localStorage `persistedColorSchemeState` = `"Dark"`/`"Light"` + reload):
  Formulas tab (rows, handles, toggle, banners if reachable, stale note via
  backdate), definition editor (value, settings accordion, danger zone open),
  wizard (object/format/name steps), autocomplete open, format options.
  Screenshots per surface per theme → scratchpad, final gallery to user.
- Legibility check: no dark-on-dark / light-on-light, no stranded white boxes
  in dark mode.
- 301/301 suite, lint clean, `dev --once` exit 0.
- Functional smoke after restyle: one drag-reorder persists; one expression
  save round-trips; autocomplete opens and inserts.

## Out of scope
Copy changes, layout restructuring beyond wrappers, new features, renderer
changes, keyboard a11y (unchanged from ADR 0014), production deploy.
