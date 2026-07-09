import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MetadataApiClient } from 'twenty-client-sdk/metadata';

import { caretFromDiff } from 'src/front-components/lib/caret-from-diff';
import {
  DropdownOption,
  MonoInput,
  ScrollableDropdownPanel,
  TextArea,
} from 'src/front-components/lib/ui';
import { TOKENS } from 'src/front-components/lib/ui-tokens';

// Reusable formula text input with inline, same-record field autocomplete.
// As the user types an identifier, a dropdown shows the target object's numeric
// fields (label + API name), narrowing live; selecting inserts the API name.
// Autocomplete is suppressed inside a [object:uuid:field] cross-record reference
// (those are ID-based by design). No dependency on the pure engine here — this
// is pure UI.

export type FieldOption = {
  name: string;
  label: string;
  type: string;
  // Text to insert when picked, when it differs from the API name (functions).
  insertText?: string;
  // SELECT/MULTI_SELECT option set — drives quoted value suggestions after a
  // `=` / `!=` comparison against this field.
  options?: Array<{ value: string; label: string }>;
};

// Static keyword suggestions alongside the metadata-driven field options. IF,
// TODAY, SUM, IFBLANK and the AND/OR/NOT/ISBLANK condition combinators are
// engine grammar, not metadata fields, so they are offered here (ADR 0010,
// 0012, 0016, 0017). Each inserts `NAME(` and leaves the caret after the paren,
// like SUM; the list is filtered by the typed identifier and capped at
// SUGGESTION_LIMIT (50), so five more entries never crowd the dropdown.
const FUNCTION_SUGGESTIONS: FieldOption[] = [
  {
    name: 'IF',
    label: 'IF(condition, then, else)',
    type: 'function',
    insertText: 'IF(',
  },
  {
    name: 'TODAY',
    label: 'TODAY() — current date',
    type: 'function',
    insertText: 'TODAY()',
  },
  {
    name: 'SUM',
    label: 'SUM(expr1, ..., exprN)',
    type: 'function',
    insertText: 'SUM(',
  },
  {
    name: 'IFBLANK',
    label: 'IFBLANK(value, fallback)',
    type: 'function',
    insertText: 'IFBLANK(',
  },
  {
    name: 'IFS',
    label: 'IFS(cond1, value1, ..., [default])',
    type: 'function',
    insertText: 'IFS(',
  },
  {
    name: 'SWITCH',
    label: 'SWITCH(expr, key1, value1, ..., [default])',
    type: 'function',
    insertText: 'SWITCH(',
  },
  {
    name: 'AND',
    label: 'AND(cond1, ..., condN) — in an IF condition',
    type: 'function',
    insertText: 'AND(',
  },
  {
    name: 'OR',
    label: 'OR(cond1, ..., condN) — in an IF condition',
    type: 'function',
    insertText: 'OR(',
  },
  {
    name: 'NOT',
    label: 'NOT(cond) — in an IF condition',
    type: 'function',
    insertText: 'NOT(',
  },
  {
    name: 'ISBLANK',
    label: 'ISBLANK(value) — in an IF condition',
    type: 'function',
    insertText: 'ISBLANK(',
  },
];

// Field types worth suggesting. The numeric-coercible set (see coercion.ts;
// DATE / DATE_TIME parse to epoch-days per the Excel serial model, ADR 0011, so
// they work in arithmetic and IF comparisons) plus the string-comparable SELECT
// and TEXT kinds — the ones that engine string comparisons (`= "..."`) target.
// Single cap for every suggestion context (field/function AND SELECT-option).
// Raised well past the old hard 8-item truncation so realistic option/field
// sets are shown in full; the dropdown scrolls (ScrollableDropdownPanel), so a
// generous bound only guards against pathological lists — it never hides real
// matches behind an arbitrary 8.
export const SUGGESTION_LIMIT = 50;

const SUGGESTIBLE_FIELD_TYPES = new Set([
  'NUMBER',
  'NUMERIC',
  'CURRENCY',
  'BOOLEAN',
  'DATE',
  'DATE_TIME',
  'SELECT',
  'TEXT',
]);

// The full-object field data: the narrowed suggestible `fields` for the
// autocomplete dropdown, plus `kindsByName` — the metadata type of EVERY active
// field pre-filter (name -> type). kindsByName drives the pre-save string-
// comparison kind check, which must see non-suggestible kinds (e.g. MULTI_SELECT)
// to reject them, so it cannot be derived from the narrowed `fields`.
export type ObjectFields = {
  fields: FieldOption[];
  kindsByName: Map<string, string>;
};

// Fetches the suggestible fields of an object (by nameSingular) via metadata.
export const useObjectFields = (
  targetObject: string | undefined,
): ObjectFields => {
  const [fields, setFields] = useState<FieldOption[]>([]);
  const [kindsByName, setKindsByName] = useState<Map<string, string>>(
    () => new Map(),
  );

  useEffect(() => {
    if (!targetObject) return;
    let cancelled = false;

    (async () => {
      try {
        const client = new MetadataApiClient();
        const response = await client.query({
          objects: {
            __args: { filter: {}, paging: { first: 200 } },
            edges: {
              node: {
                nameSingular: true,
                fields: {
                  __args: { paging: { first: 200 }, filter: {} },
                  edges: {
                    node: {
                      name: true,
                      label: true,
                      type: true,
                      isActive: true,
                      isSystem: true,
                      // JSON scalar: a SELECT/MULTI_SELECT field's option set
                      // (array of { value, label, color, ... }).
                      options: true,
                    },
                  },
                },
              },
            },
          },
        });

        const objectNode = (response?.objects?.edges ?? [])
          .map((edge: any) => edge.node)
          .find((node: any) => node?.nameSingular === targetObject);

        const activeNodes: any[] = (objectNode?.fields?.edges ?? [])
          .map((edge: any) => edge.node)
          .filter((node: any) => node?.isActive && !node?.isSystem);

        // Full kind map (name -> type) over every active field, unfiltered by
        // suggestibility — the validate-expression kind check needs the true
        // kind of fields it will never suggest (e.g. MULTI_SELECT) to reject
        // string comparisons against them.
        const kinds = new Map<string, string>(
          activeNodes
            .filter(
              (node: any) =>
                typeof node?.name === 'string' && typeof node?.type === 'string',
            )
            .map((node: any) => [node.name as string, node.type as string]),
        );

        const options: FieldOption[] = activeNodes
          .filter((node: any) => SUGGESTIBLE_FIELD_TYPES.has(node?.type))
          .map((node: any) => {
            const rawOptions = Array.isArray(node.options) ? node.options : [];
            const fieldOptions = rawOptions
              .filter((option: any) => typeof option?.value === 'string')
              .map((option: any) => ({
                value: option.value as string,
                label: (option.label as string) ?? option.value,
              }));
            return {
              name: node.name as string,
              label: (node.label as string) ?? node.name,
              type: node.type as string,
              ...(fieldOptions.length > 0 ? { options: fieldOptions } : {}),
            };
          })
          .sort((a: FieldOption, b: FieldOption) =>
            a.label.localeCompare(b.label),
          );

        if (!cancelled) {
          setFields(options);
          setKindsByName(kinds);
        }
      } catch {
        if (!cancelled) {
          setFields([]);
          setKindsByName(new Map());
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [targetObject]);

  return { fields, kindsByName };
};

// True when the caret sits inside an unclosed "[" — i.e. within a cross-record
// reference, where autocomplete should stay out of the way.
const isInsideCrossRef = (textBeforeCaret: string): boolean => {
  const open = (textBeforeCaret.match(/\[/g) ?? []).length;
  const close = (textBeforeCaret.match(/\]/g) ?? []).length;
  return open > close;
};

// The identifier being typed immediately before the caret (bare word only, not a
// dotted composite sub-path — we complete top-level field names).
const identifierBeforeCaret = (
  textBeforeCaret: string,
): { token: string; start: number } | null => {
  const match = textBeforeCaret.match(/[A-Za-z_][A-Za-z0-9_]*$/);
  if (!match) return null;
  // Skip if this segment is a composite sub-path (preceded by ".").
  const charBefore = textBeforeCaret[match.index! - 1];
  if (charBefore === '.') return null;
  return { token: match[0], start: match.index! };
};

// Text-before-caret shape of a value comparison: `field = ` / `field != `
// optionally trailed by a partial value (with or without an opening quote).
// Group 1 is the compared field name; group 3 the partial (incl. any `"`).
// Shared by computeSuggestions (to offer options) and computeInsertRange (to
// replace the partial on accept) so both agree on where the partial starts.
const COMPARISON_CONTEXT_RE =
  /([A-Za-z_][A-Za-z0-9_]*)\s*(=|!=)\s*("?[^"]*)?$/;

// SELECT-option suggestions when the caret sits after a `=` / `!=` comparison
// against a SELECT field that carries options. The option context CLAIMS the
// completion (returns a possibly-empty option list) only when the LHS identifier
// resolves to a SELECT field with options — the RHS is then a value slot, so an
// empty result stays empty rather than falling back to field names. Otherwise it
// yields (returns null) so the caller runs normal field completion on the RHS
// identifier — e.g. `amount = clo` still completes to `closeDate`.
const computeOptionSuggestions = (
  before: string,
  fields: FieldOption[],
): FieldOption[] | null => {
  const match = before.match(COMPARISON_CONTEXT_RE);
  if (!match) return null;
  const fieldName = match[1];
  const field = fields.find((candidate) => candidate.name === fieldName);
  if (!field || field.type !== 'SELECT' || !field.options?.length) return null;
  const rawPartial = match[3] ?? '';
  const partial = (
    rawPartial.startsWith('"') ? rawPartial.slice(1) : rawPartial
  ).toLowerCase();
  return field.options
    .filter(
      (option) =>
        option.value.toLowerCase().includes(partial) ||
        option.label.toLowerCase().includes(partial),
    )
    .slice(0, SUGGESTION_LIMIT)
    .map((option) => ({
      name: option.value,
      label: option.label,
      type: 'OPTION',
      insertText: `"${option.value}"`,
    }));
};

// Pure suggestion computation (value + caret + fields -> ordered options).
// Extracted from the component's useMemo so it can be unit-tested in isolation.
// Suppressed inside a [...] cross-record reference. A `=` / `!=` comparison
// against a SELECT field takes precedence over bare-identifier completion.
export const computeSuggestions = (
  value: string,
  caret: number,
  fields: FieldOption[],
): FieldOption[] => {
  const before = value.slice(0, caret);
  if (isInsideCrossRef(before)) return [];
  const optionSuggestions = computeOptionSuggestions(before, fields);
  if (optionSuggestions !== null) return optionSuggestions;
  const identifier = identifierBeforeCaret(before);
  if (!identifier || identifier.token.length < 1) return [];
  const query = identifier.token.toLowerCase();
  const normalizedLabel = (label: string) =>
    label.toLowerCase().replace(/\s+/g, '');
  return [...FUNCTION_SUGGESTIONS, ...fields]
    .filter(
      (field) =>
        field.name.toLowerCase().includes(query) ||
        normalizedLabel(field.label).includes(query),
    )
    .sort((a, b) => {
      // Prefix matches on the API name rank first.
      const aPrefix = a.name.toLowerCase().startsWith(query) ? 0 : 1;
      const bPrefix = b.name.toLowerCase().startsWith(query) ? 0 : 1;
      return aPrefix - bPrefix;
    })
    .slice(0, SUGGESTION_LIMIT);
};

// Where an accepted suggestion is spliced in, and the text to splice. For an
// OPTION suggestion the range starts at the comparison partial — INCLUDING an
// already-typed opening quote — so accepting never doubles the quote; for a
// field/function suggestion it starts at the identifier being typed. Pure and
// exported so the replace-range rule is directly testable.
export const computeInsertRange = (
  value: string,
  caret: number,
  suggestion: FieldOption,
): { start: number; insertText: string } => {
  const before = value.slice(0, caret);
  const insertText = suggestion.insertText ?? suggestion.name;
  if (suggestion.type === 'OPTION') {
    const match = before.match(COMPARISON_CONTEXT_RE);
    if (match) {
      const partial = match[3] ?? '';
      return { start: before.length - partial.length, insertText };
    }
  }
  const identifier = identifierBeforeCaret(before);
  return { start: identifier ? identifier.start : caret, insertText };
};

// Caret decision for a selection-based sync (click / arrow key). Returns the
// host's selectionStart when it exposes one; otherwise keeps the current caret
// untouched. The remote-dom sandbox never mirrors selectionStart into the app
// worker, so falling back to end-of-string here would stomp the diff-derived
// caret set by onChange (caretFromDiff) and break mid-string autocomplete.
// Pure and exported so both branches are directly testable.
export const nextCaretFromSelection = (
  selectionStart: number | null | undefined,
  currentCaret: number,
): number => selectionStart ?? currentCaret;

// Editor state snapshot used to decide whether a suggestions-effect run is the
// echo of a just-accepted suggestion (which must stay closed) or genuine new
// input (which should reopen the dropdown).
export type EditorState = { value: string; caret: number };

// True when the current (value, caret) is exactly the state produced by the
// last accepted suggestion. WHY: inserting a bare identifier (e.g. `stage`)
// still satisfies the completion trigger, so the suggestions effect would
// otherwise immediately reopen the dropdown it just closed. Suppress only the
// exact echo — any later value/caret change (typing one more char, moving the
// caret) no longer matches, so normal reopen behavior resumes.
export const shouldSuppressReopen = (
  current: EditorState,
  accepted: EditorState | null,
): boolean =>
  accepted !== null &&
  accepted.value === current.value &&
  accepted.caret === current.caret;

// Number of textarea rows for a given expression: one row per line, floored at
// 2 and capped at 10. Pure and content-derived (no DOM measurement) so it works
// inside the remote-dom sandbox where scrollHeight is unreliable. `resize:
// vertical` on the archetype remains the manual escape hatch past the cap.
const MIN_TEXTAREA_ROWS = 2;
const MAX_TEXTAREA_ROWS = 10;
export const rowsForValue = (value: string): number => {
  const lineCount = value.split('\n').length;
  return Math.min(Math.max(lineCount, MIN_TEXTAREA_ROWS), MAX_TEXTAREA_ROWS);
};

type FormulaFieldInputProps = {
  value: string;
  onChange: (next: string) => void;
  targetObject: string | undefined;
  placeholder?: string;
  multiline?: boolean;
  onEnterWithoutSuggestion?: () => void;
};

export const FormulaFieldInput = ({
  value,
  onChange,
  targetObject,
  placeholder,
  multiline,
}: FormulaFieldInputProps) => {
  const { fields } = useObjectFields(targetObject);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const [caret, setCaret] = useState(0);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [pendingCaret, setPendingCaret] = useState<number | null>(null);
  // (value, caret) produced by the last accepted suggestion. While the editor
  // still sits on this exact state, the suggestions effect must not reopen the
  // dropdown insert() just closed. Cleared on any other value/caret change.
  const acceptedRef = useRef<EditorState | null>(null);

  // Restore caret position after a programmatic insert. The remote-dom sandbox
  // proxies input elements and does not always expose setSelectionRange /
  // focus, so every DOM call is feature-detected — the insert still works, the
  // caret just falls back to wherever the host places it when unsupported.
  useEffect(() => {
    if (pendingCaret === null) return;
    const element = inputRef.current as
      | (HTMLInputElement & { setSelectionRange?: unknown; focus?: unknown })
      | null;
    // The remote-dom sandbox may expose these as proxied members that throw when
    // invoked, so guard AND swallow — the insert already worked; caret placement
    // is best-effort and must never crash the widget.
    try {
      if (element && typeof element.focus === 'function') element.focus();
      if (element && typeof element.setSelectionRange === 'function') {
        element.setSelectionRange(pendingCaret, pendingCaret);
      }
    } catch {
      // caret restore unsupported in this host — ignore
    }
    setCaret(pendingCaret);
    setPendingCaret(null);
  }, [pendingCaret, value]);

  const suggestions = useMemo(
    () => computeSuggestions(value, caret, fields),
    [value, caret, fields],
  );

  useEffect(() => {
    setActiveIndex(0);
    if (shouldSuppressReopen({ value, caret }, acceptedRef.current)) {
      // Echo of the just-accepted suggestion — keep the dropdown closed.
      setOpen(false);
      return;
    }
    // Moved past the accepted state (typing/caret move): resume normal behavior.
    acceptedRef.current = null;
    setOpen(suggestions.length > 0);
  }, [suggestions, value, caret]);

  const insert = useCallback(
    (field: FieldOption) => {
      const { start, insertText } = computeInsertRange(value, caret, field);
      const next = value.slice(0, start) + insertText + value.slice(caret);
      const nextCaret = start + insertText.length;
      onChange(next);
      // Set caret state synchronously (not only via pendingCaret) so the very
      // first suggestions-effect run after this insert already sees the
      // accepted (value, caret) and suppresses the reopen without a flash.
      setCaret(nextCaret);
      setPendingCaret(nextCaret);
      acceptedRef.current = { value: next, caret: nextCaret };
      setOpen(false);
    },
    [value, caret, onChange],
  );

  // Click/keyup caret sync. Native hosts expose selectionStart, so clicks and
  // arrow keys sync the caret exactly. The remote-dom sandbox never mirrors
  // selectionStart into the app worker (it is always undefined there), so this
  // NO-OPs and leaves the onChange-derived caret (caretFromDiff) intact —
  // accepted limitation: a caret-only move (arrow keys, click) is invisible in
  // the sandbox, but the next keystroke recovers the true caret via caretFromDiff.
  const syncCaret = useCallback(() => {
    if (inputRef.current) {
      setCaret((current) =>
        nextCaretFromSelection(inputRef.current?.selectionStart, current),
      );
    }
  }, []);

  const handleKeyDown = (
    event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => {
    if (!open || suggestions.length === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((index) => (index + 1) % suggestions.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex(
        (index) => (index - 1 + suggestions.length) % suggestions.length,
      );
    } else if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      insert(suggestions[activeIndex]);
    } else if (event.key === 'Escape') {
      setOpen(false);
    }
  };

  const commonProps = {
    ref: inputRef as any,
    value,
    placeholder,
    spellCheck: false,
    onChange: (
      event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
    ) => {
      const nextValue = event.target.value;
      onChange(nextValue);
      // remote-dom never mirrors host selectionStart into the app worker, so it
      // is almost always undefined here; deriving the caret from the value diff
      // is the reliable signal that makes mid-string autocomplete work.
      // selectionStart stays as an opportunistic first choice so native hosts
      // keep exact-click behavior.
      const diffCaret = caretFromDiff(value, nextValue);
      setCaret(event.target.selectionStart ?? diffCaret);
    },
    onKeyDown: handleKeyDown,
    onKeyUp: syncCaret,
    onClick: syncCaret,
  };

  return (
    <div style={layout.wrapper}>
      {multiline ? (
        <TextArea
          {...(commonProps as any)}
          rows={rowsForValue(value)}
          style={layout.textarea}
        />
      ) : (
        <MonoInput {...(commonProps as any)} style={layout.input} />
      )}
      {open ? (
        <ScrollableDropdownPanel style={layout.dropdown}>
          {suggestions.map((field, index) => (
            <DropdownOption
              key={field.name}
              active={index === activeIndex}
              onMouseDown={(event) => {
                // onMouseDown (not onClick) so the input doesn't blur first.
                event.preventDefault();
                insert(field);
              }}
              onMouseEnter={() => setActiveIndex(index)}
            >
              <span style={layout.optionLabel}>{field.label}</span>
              <span style={layout.optionApiName}>{field.name}</span>
              <span style={layout.optionType}>{field.type.toLowerCase()}</span>
            </DropdownOption>
          ))}
        </ScrollableDropdownPanel>
      ) : null}
    </div>
  );
};

// Layout-only values (padding, gaps, positioning) — every color/background/
// border comes from the archetypes in lib/ui.tsx or lib/ui-tokens instead
// (spec: docs/superpowers/specs/2026-07-04-formula-field-ui-polish-design.md).
// wrapper/optionLabel are pure layout literals (no color) per the task brief.
const layout: Record<string, React.CSSProperties> = {
  wrapper: { position: 'relative', width: '100%' },
  input: { width: '100%', boxSizing: 'border-box' },
  // TextArea's base archetype isn't monospace — formula text stays mono here.
  textarea: {
    width: '100%',
    boxSizing: 'border-box',
    fontFamily: 'ui-monospace, monospace',
    // rows auto-grows with content (rowsForValue); vertical resize stays as the
    // manual escape hatch for users who want a taller box than the cap.
    resize: 'vertical',
  },
  dropdown: {
    position: 'absolute',
    top: '100%',
    left: 0,
    right: 0,
    zIndex: 20,
    marginTop: '2px',
  },
  optionLabel: { fontWeight: 600 },
  // Sub-column colors are consumer-applied via TOKENS per DropdownOption's
  // documented contract (api-name blue, type font-color-light).
  optionApiName: {
    fontFamily: 'ui-monospace, monospace',
    color: TOKENS.colorBlue,
    fontSize: '11px',
  },
  optionType: {
    marginLeft: 'auto',
    color: TOKENS.fontColorLight,
    fontSize: '10px',
  },
};
