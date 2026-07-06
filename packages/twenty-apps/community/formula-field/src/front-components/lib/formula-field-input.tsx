import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MetadataApiClient } from 'twenty-client-sdk/metadata';

import { caretFromDiff } from 'src/front-components/lib/caret-from-diff';
import {
  DropdownOption,
  DropdownPanel,
  MonoInput,
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
};

// Static keyword suggestions alongside the metadata-driven field options. IF
// and TODAY are engine grammar, not metadata fields, so they are offered here
// (ADR 0010, ADR 0012).
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
];

// Field types whose values the engine can coerce to a number (see coercion.ts).
// DATE / DATE_TIME parse to epoch-days (Excel serial-date model, ADR 0011), so
// they are usable in arithmetic (e.g. `closeDate + 30`) and IF comparisons.
const NUMERIC_FIELD_TYPES = new Set([
  'NUMBER',
  'NUMERIC',
  'CURRENCY',
  'BOOLEAN',
  'DATE',
  'DATE_TIME',
]);

// Fetches the numeric-usable fields of an object (by nameSingular) via metadata.
export const useObjectFields = (
  targetObject: string | undefined,
): FieldOption[] => {
  const [fields, setFields] = useState<FieldOption[]>([]);

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

        const options: FieldOption[] = (objectNode?.fields?.edges ?? [])
          .map((edge: any) => edge.node)
          .filter(
            (node: any) =>
              node?.isActive &&
              !node?.isSystem &&
              NUMERIC_FIELD_TYPES.has(node?.type),
          )
          .map((node: any) => ({
            name: node.name as string,
            label: (node.label as string) ?? node.name,
            type: node.type as string,
          }))
          .sort((a: FieldOption, b: FieldOption) =>
            a.label.localeCompare(b.label),
          );

        if (!cancelled) setFields(options);
      } catch {
        if (!cancelled) setFields([]);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [targetObject]);

  return fields;
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

// Pure suggestion computation (value + caret + fields -> ordered options).
// Extracted from the component's useMemo so it can be unit-tested in isolation;
// behavior is unchanged. Suppressed inside a [...] cross-record reference.
export const computeSuggestions = (
  value: string,
  caret: number,
  fields: FieldOption[],
): FieldOption[] => {
  const before = value.slice(0, caret);
  if (isInsideCrossRef(before)) return [];
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
    .slice(0, 8);
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
  const fields = useObjectFields(targetObject);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const [caret, setCaret] = useState(0);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [pendingCaret, setPendingCaret] = useState<number | null>(null);

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
    setOpen(suggestions.length > 0);
  }, [suggestions]);

  const insert = useCallback(
    (field: FieldOption) => {
      const before = value.slice(0, caret);
      const identifier = identifierBeforeCaret(before);
      const start = identifier ? identifier.start : caret;
      const insertText = field.insertText ?? field.name;
      const next = value.slice(0, start) + insertText + value.slice(caret);
      onChange(next);
      setPendingCaret(start + insertText.length);
      setOpen(false);
    },
    [value, caret, onChange],
  );

  // Click/keyup caret sync. selectionStart is unavailable in the remote-dom
  // sandbox, so caret-only moves (arrow keys, clicks) stay invisible here and
  // fall back to end-of-text — accepted limitation: the next keystroke recovers
  // the true caret via caretFromDiff in onChange.
  const syncCaret = useCallback(() => {
    if (inputRef.current) {
      setCaret(inputRef.current.selectionStart ?? value.length);
    }
  }, [value.length]);

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
        <TextArea {...(commonProps as any)} rows={2} style={layout.textarea} />
      ) : (
        <MonoInput {...(commonProps as any)} style={layout.input} />
      )}
      {open ? (
        <DropdownPanel style={layout.dropdown}>
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
        </DropdownPanel>
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
    resize: 'none',
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
