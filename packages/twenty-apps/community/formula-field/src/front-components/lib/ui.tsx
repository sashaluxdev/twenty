// Shared core-aesthetic UI module for all formula-field front components.
//
// Spike verdict (docs/../ui-spike-verdict.md) was NO-GO for twenty-sdk/ui —
// it builds but crashes the front-component sandbox at runtime ("Dynamic
// require of \"react\" is not supported"). Every archetype below is
// therefore an @emotion/styled replica of the core look, driven entirely by
// var(--t-*) references (see ui-tokens.ts) so it repaints on theme toggle
// with zero JS — the same pattern call-recorder uses for the same reason.
//
// Do NOT import twenty-sdk/ui from this file or any front component.
import { css, keyframes } from '@emotion/react';
import styled from '@emotion/styled';
import type { CSSProperties } from 'react';

import { TOKENS } from 'src/front-components/lib/ui-tokens';

// Base container for every widget tree. twenty-sdk/ui's ThemeProvider is
// unavailable (NO-GO), but no provider is needed here: every value below is
// a live var(--t-*) reference, not a JS theme object, so a plain styled div
// is sufficient (spec §Architecture 2).
export const WidgetRoot = styled.div`
  background: transparent;
  color: ${TOKENS.fontColorPrimary};
  font-family: ${TOKENS.fontFamily};
  font-size: ${TOKENS.fontSizeXs};
  width: 100%;
`;

// --- Buttons -----------------------------------------------------------
// Every button sets font-family/font-size explicitly: form controls do not
// inherit these from ancestors in browsers, unlike ordinary text elements.

// `armed` is a transient prop (shouldForwardProp keeps it off the DOM,
// mirroring ToggleTrack's `on`). When armed the button flips to the danger
// palette (matching DangerButton) while keeping IDENTICAL geometry — WHY: the
// two-step save confirm needs to recolor a button in place. Swapping the React
// component TYPE (PrimaryButton -> DangerButton) would remount the DOM node and
// drop keyboard focus mid-flow; a single element that only changes its CSS
// preserves focus across the arm flip.
export const PrimaryButton = styled('button', {
  shouldForwardProp: (prop) => prop !== 'armed',
})<{ armed?: boolean }>`
  background: ${({ armed }) => (armed ? TOKENS.colorRed : TOKENS.colorBlue)};
  border: none;
  border-radius: ${TOKENS.radiusSm};
  color: ${({ armed }) => (armed ? TOKENS.bgPrimary : '#fff')};
  cursor: pointer;
  font-family: ${TOKENS.fontFamily};
  font-size: ${TOKENS.fontSizeXs};
  font-weight: 500;
  height: 24px;
  padding: 0 8px;
  transition: background 0.1s ease;
  &:hover:not(:disabled) {
    background: ${({ armed }) =>
      armed ? 'var(--t-color-red8)' : 'var(--t-color-blue10)'};
  }
  &:focus {
    box-shadow: 0 0 0 3px
      ${({ armed }) => (armed ? 'var(--t-color-red3)' : TOKENS.accentTertiary)};
    outline: none;
  }
  &:disabled {
    background: var(--t-accent-accent4060);
    cursor: not-allowed;
  }
`;

export const SecondaryButton = styled.button`
  background: transparent;
  border: 1px solid ${TOKENS.bgTransparentMedium};
  border-radius: ${TOKENS.radiusSm};
  color: ${TOKENS.fontColorSecondary};
  cursor: pointer;
  font-family: ${TOKENS.fontFamily};
  font-size: ${TOKENS.fontSizeXs};
  font-weight: 500;
  height: 24px;
  padding: 0 8px;
  transition: background 0.1s ease;
  &:hover:not(:disabled) {
    background: ${TOKENS.bgTransparentLight};
  }
  &:disabled {
    cursor: not-allowed;
    opacity: 0.24;
  }
`;

export const DangerButton = styled.button`
  background: ${TOKENS.colorRed};
  border: none;
  border-radius: ${TOKENS.radiusSm};
  color: ${TOKENS.bgPrimary};
  cursor: pointer;
  font-family: ${TOKENS.fontFamily};
  font-size: ${TOKENS.fontSizeXs};
  font-weight: 500;
  height: 24px;
  padding: 0 8px;
  transition: background 0.1s ease;
  &:hover:not(:disabled) {
    background: var(--t-color-red8);
  }
  // Core's danger-accent disabled treatment is opacity dimming (IconButton
  // precedent) — without it a locked destructive confirm reads as armed.
  &:disabled {
    cursor: not-allowed;
    opacity: 0.24;
  }
`;

export const OutlineDangerButton = styled.button`
  background: transparent;
  border: 1px solid ${TOKENS.borderDanger};
  border-radius: ${TOKENS.radiusSm};
  color: ${TOKENS.colorRed};
  cursor: pointer;
  font-family: ${TOKENS.fontFamily};
  font-size: ${TOKENS.fontSizeXs};
  font-weight: 500;
  height: 24px;
  padding: 0 8px;
  transition: background 0.1s ease;
  &:hover:not(:disabled) {
    background: ${TOKENS.bgTransparentDanger};
  }
  &:disabled {
    cursor: not-allowed;
  }
`;

export const StepperButton = styled.button`
  align-items: center;
  background: transparent;
  border: 1px solid ${TOKENS.bgTransparentMedium};
  border-radius: ${TOKENS.radiusSm};
  color: ${TOKENS.fontColorSecondary};
  cursor: pointer;
  display: inline-flex;
  font-family: ${TOKENS.fontFamily};
  font-size: ${TOKENS.fontSizeXs};
  height: 24px;
  justify-content: center;
  transition: background 0.1s ease;
  width: 24px;
  &:hover:not(:disabled) {
    background: ${TOKENS.bgTransparentLight};
  }
  &:disabled {
    cursor: not-allowed;
  }
`;

// --- Text inputs ---------------------------------------------------------

const textFieldStyles = css`
  background: ${TOKENS.bgTransparentLighter};
  border: 1px solid ${TOKENS.borderMedium};
  border-radius: ${TOKENS.radiusSm};
  color: ${TOKENS.fontColorPrimary};
  font-family: ${TOKENS.fontFamily};
  font-size: ${TOKENS.fontSizeXs};
  outline: none;
  padding: 4px 8px;
  transition: background 0.1s ease;
  &::placeholder {
    color: ${TOKENS.fontColorLight};
    font-weight: 500;
  }
  &:focus {
    border-color: ${TOKENS.colorBlue};
  }
`;

export const TextInput = styled.input`
  ${textFieldStyles}
`;

export const TextArea = styled.textarea`
  ${textFieldStyles}
  min-height: 48px;
  resize: vertical;
`;

// Formula / API-name inputs keep the monospace stack (spec: "Text inputs").
export const MonoInput = styled(TextInput)`
  font-family: ui-monospace, monospace;
`;

// --- Selectable chips ------------------------------------------------------
// `selected` is a transient prop: shouldForwardProp keeps it off the DOM
// element (only "selected" — a real HTML attribute on <option> — would
// otherwise risk being forwarded, and $-prefixing isn't an option since
// consumers pass the plain `selected` name per the shared-module contract).

export const ChoiceChip = styled('button', {
  shouldForwardProp: (prop) => prop !== 'selected',
})<{ selected: boolean }>`
  background: ${({ selected }) =>
    selected ? TOKENS.accentTertiary : 'transparent'};
  border: 1px solid
    ${({ selected }) => (selected ? TOKENS.colorBlue : TOKENS.borderMedium)};
  border-radius: ${TOKENS.radiusSm};
  color: ${({ selected }) =>
    selected ? TOKENS.colorBlue : TOKENS.fontColorSecondary};
  cursor: pointer;
  font-family: ${TOKENS.fontFamily};
  font-size: ${TOKENS.fontSizeXs};
  padding: 4px 10px;
  transition: background 0.1s ease;
  &:hover {
    background: ${({ selected }) =>
      selected ? TOKENS.accentTertiary : TOKENS.bgTransparentLight};
  }
`;

// --- Banners / panels --------------------------------------------------

const fadeIn = keyframes`
  from { opacity: 0; }
  to { opacity: 1; }
`;

export const BannerDanger = styled.div`
  animation: ${fadeIn} 150ms ease;
  background: ${TOKENS.bgTransparentDanger};
  border-radius: ${TOKENS.radiusMd};
  color: ${TOKENS.colorRed};
  font-weight: 500;
  padding: 8px;
`;

export const BannerWarning = styled.div`
  animation: ${fadeIn} 150ms ease;
  background: ${TOKENS.bgTransparentOrange};
  border-radius: ${TOKENS.radiusMd};
  color: ${TOKENS.colorOrange};
  font-weight: 500;
  padding: 8px;
`;

export const DangerPanel = styled.div`
  background: ${TOKENS.bgTransparentDanger};
  border: 1px solid ${TOKENS.borderDanger};
  border-radius: ${TOKENS.radiusMd};
  color: ${TOKENS.colorRed};
  padding: 12px;
`;

// --- Inline status text --------------------------------------------------

export const MutedText = styled.span`
  color: ${TOKENS.fontColorTertiary};
`;

export const HintText = styled.span`
  color: ${TOKENS.fontColorTertiary};
  font-size: ${TOKENS.fontSizeXs};
`;

export const ErrText = styled.span`
  color: ${TOKENS.colorRed};
`;

export const OkText = styled.span`
  color: ${TOKENS.colorTurquoise};
`;

export const WarnText = styled.span`
  color: ${TOKENS.colorOrange};
`;

// --- Titles --------------------------------------------------------------

export const SectionTitle = styled.div`
  color: ${TOKENS.fontColorPrimary};
  font-weight: 500;
`;

// Step numbers use tertiary per spec ("color primary / tertiary for step
// numbers"). Ambiguity resolution: StepTitle is for the wizard's step
// heading LINE (e.g. "1 · Target object"), which core renders tertiary;
// a primary-colored title is SectionTitle.
export const StepTitle = styled.div`
  color: ${TOKENS.fontColorTertiary};
  font-weight: 500;
`;

// Big value display (definition editor): primary color per spec — core
// reserves blue for links/actions, not values.
export const BigValue = styled.div`
  color: ${TOKENS.fontColorPrimary};
  font-size: ${TOKENS.fontSizeXl};
  font-weight: 600;
`;

// --- Override toggle -------------------------------------------------------
// Geometry ported verbatim from the pre-polish inline styles; semantics
// (on = overridden = red, off = formula-controlled = green) unchanged.

export const ToggleTrack = styled('button', {
  shouldForwardProp: (prop) => prop !== 'on',
})<{ on: boolean }>`
  background: ${({ on }) => (on ? TOKENS.colorRed : TOKENS.colorGreen)};
  border: none;
  border-radius: 10px;
  cursor: pointer;
  height: 20px;
  position: relative;
  transition: background 0.1s ease;
  width: 38px;
`;

export const ToggleKnob = styled('span', {
  shouldForwardProp: (prop) => prop !== 'on',
})<{ on: boolean }>`
  background: #fff;
  border-radius: 50%;
  height: 16px;
  left: 2px;
  position: absolute;
  top: 2px;
  transform: ${({ on }) => (on ? 'translateX(18px)' : 'translateX(0px)')};
  transition: transform 150ms ease;
  width: 16px;
`;

// --- Autocomplete dropdown -------------------------------------------------

const dropdownFadeIn = keyframes`
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: translateY(0); }
`;

export const DropdownPanel = styled.div`
  animation: ${dropdownFadeIn} 150ms ease;
  background: ${TOKENS.bgPrimary};
  border: 1px solid ${TOKENS.borderMedium};
  border-radius: ${TOKENS.radiusMd};
  box-shadow: var(--t-box-shadow-light);
  overflow: hidden;
`;

// Sub-column colors (api-name column blue, type column font-color-light)
// are consumer-applied via TOKENS on the inner spans — same documented gap
// as DangerPanel's list-item color.
export const DropdownOption = styled('div', {
  shouldForwardProp: (prop) => prop !== 'active',
})<{ active: boolean }>`
  align-items: baseline;
  background: ${({ active }) =>
    active ? TOKENS.bgTransparentLight : 'transparent'};
  cursor: pointer;
  display: flex;
  font-size: ${TOKENS.fontSizeXs};
  gap: 8px;
  padding: 6px 10px;
  transition: background 0.1s ease;
  &:hover {
    background: ${TOKENS.bgTransparentLight};
  }
`;

// --- Drag rows + handle ------------------------------------------------
// Plain style objects (not styled components): rows already merge style
// objects conditionally on drag state in the consuming components, and the
// border must stay all-longhand across both variants to avoid the
// shorthand/longhand merge bug (spec constraint).

export const RowDivider = {
  base: {
    borderTop: `1px solid ${TOKENS.borderLight}`,
    borderRight: 'none',
    borderBottom: 'none',
    borderLeft: 'none',
  } as CSSProperties,
  dragging: {
    background: TOKENS.bgTransparentLight,
    borderTop: `1px solid ${TOKENS.borderStrong}`,
    borderRight: 'none',
    borderBottom: 'none',
    borderLeft: 'none',
  } as CSSProperties,
} as const;

export const DragHandle = styled('span', {
  shouldForwardProp: (prop) => prop !== 'active',
})<{ active: boolean }>`
  align-items: center;
  border-radius: ${TOKENS.radiusSm};
  color: ${TOKENS.fontColorTertiary};
  cursor: ${({ active }) => (active ? 'grabbing' : 'grab')};
  display: inline-flex;
  padding: 2px;
  touch-action: none;
  transition: background 0.1s ease;
  user-select: none;
  &:hover {
    background: ${TOKENS.bgTransparentLight};
  }
`;
