import {
  CURRENCY_CODES,
  type CurrencyFormat,
  deriveOptionValue,
  type DateDisplayFormat,
  type FormatOptions,
  getOutputFormat,
  isValidCustomUnicodeDateFormat,
  type NumberDisplayType,
  type OutputFormat,
  SELECT_OPTION_COLORS,
  selectOptionsProblem,
  type SelectOptionDraft,
} from 'src/front-components/lib/formula-field-formats';
import {
  ChoiceChip,
  ErrText,
  HintText,
  MonoInput,
  MutedText,
  SecondaryButton,
  StepperButton,
  TextInput,
} from 'src/front-components/lib/ui';

// isValidCustomUnicodeDateFormat is used below to flag an incomplete CUSTOM
// date pattern inline; areFormatOptionsValid (the save gate) lives in the pure
// formats module so non-UI callers can import it without React.

// Renders the per-format option controls that mirror the native field-settings
// UI: a decimals counter for number/currency, a number-type select (editor
// only), a currency Short/Full select + code picker, and a date display-format
// select with a custom Unicode pattern input. Shared by the setup wizard and the
// definition editor's Field-settings section so both write identical settings.
//
// remote-dom sandbox: only div / span / button / input primitives are used.

type FormatOptionsFieldsProps = {
  format: OutputFormat;
  options: FormatOptions;
  onChange: (next: FormatOptions) => void;
  // Editor surface lets the user switch the NUMBER display type (number / short
  // / percentage); the wizard fixes it via the format chip, so it hides this.
  showNumberTypeSelect?: boolean;
};

const NUMBER_TYPE_CHOICES: { value: NumberDisplayType; label: string }[] = [
  { value: 'number', label: 'Number' },
  { value: 'shortNumber', label: 'Short' },
  { value: 'percentage', label: 'Percentage' },
];

const CURRENCY_FORMAT_CHOICES: { value: CurrencyFormat; label: string }[] = [
  { value: 'short', label: 'Short' },
  { value: 'full', label: 'Full' },
];

const DATE_FORMAT_CHOICES: { value: DateDisplayFormat; label: string }[] = [
  { value: 'USER_SETTINGS', label: 'Default' },
  { value: 'RELATIVE', label: 'Relative' },
  { value: 'CUSTOM', label: 'Custom' },
];

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const Counter = ({
  value,
  min,
  max,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (next: number) => void;
}) => (
  <div style={f.counter}>
    <StepperButton
      type="button"
      disabled={value <= min}
      onMouseDown={() => onChange(clamp(value - 1, min, max))}
    >
      −
    </StepperButton>
    <span style={f.counterValue}>{value}</span>
    <StepperButton
      type="button"
      disabled={value >= max}
      onMouseDown={() => onChange(clamp(value + 1, min, max))}
    >
      +
    </StepperButton>
  </div>
);

const ChoiceRow = <TValue extends string>({
  choices,
  selected,
  onSelect,
}: {
  choices: { value: TValue; label: string }[];
  selected: TValue;
  onSelect: (value: TValue) => void;
}) => (
  <div style={f.choiceRow}>
    {choices.map((choice) => (
      <ChoiceChip
        key={choice.value}
        type="button"
        selected={selected === choice.value}
        onMouseDown={() => onSelect(choice.value)}
      >
        {choice.label}
      </ChoiceChip>
    ))}
  </div>
);

export const FormatOptionsFields = ({
  format,
  options,
  onChange,
  showNumberTypeSelect,
}: FormatOptionsFieldsProps) => {
  const definition = getOutputFormat(format);
  const patch = (partial: Partial<FormatOptions>) =>
    onChange({ ...options, ...partial });

  // TEXT has no display options in v1 — return BEFORE the DATE/DATE_TIME
  // fall-through below, which would otherwise offer a date display format on a
  // text field.
  if (definition.fieldType === 'TEXT') {
    return null;
  }

  // SELECT options are edited by SelectOptionsEditor in the wizard ONLY. This
  // shared form is also rendered by the field-settings editor, and options are
  // never editable post-creation (ADR 0029 D7) — so the SELECT arm is empty by
  // design, not by omission.
  if (definition.fieldType === 'SELECT') {
    return null;
  }

  if (definition.fieldType === 'NUMBER') {
    const isShort = options.numberDisplayType === 'shortNumber';
    return (
      <div>
        {showNumberTypeSelect ? (
          <div style={f.field}>
            <MutedText as="div" style={f.fieldLabel}>
              Number type
            </MutedText>
            <ChoiceRow
              choices={NUMBER_TYPE_CHOICES}
              selected={options.numberDisplayType}
              onSelect={(value) =>
                patch({
                  numberDisplayType: value,
                  decimals: value === 'shortNumber' ? 0 : options.decimals,
                })
              }
            />
          </div>
        ) : null}
        {isShort ? (
          <HintText as="div" style={f.hint}>
            Short numbers have no decimals (e.g. 1.2k).
          </HintText>
        ) : (
          <div style={f.field}>
            <MutedText as="div" style={f.fieldLabel}>
              Decimals
            </MutedText>
            <Counter
              value={options.decimals}
              min={0}
              max={100}
              onChange={(decimals) => patch({ decimals })}
            />
          </div>
        )}
        {options.numberDisplayType === 'percentage' ? (
          <HintText as="div" style={f.hint}>
            Percentage changes how the stored number is DISPLAYED, not the stored
            value.
          </HintText>
        ) : null}
      </div>
    );
  }

  if (definition.fieldType === 'CURRENCY') {
    return (
      <div>
        <div style={f.field}>
          <MutedText as="div" style={f.fieldLabel}>
            Default currency
          </MutedText>
          <ChoiceRow
            choices={CURRENCY_CODES.map((code) => ({ value: code, label: code }))}
            selected={options.currencyCode}
            onSelect={(currencyCode) => patch({ currencyCode })}
          />
        </div>
        <div style={f.field}>
          <MutedText as="div" style={f.fieldLabel}>
            Format
          </MutedText>
          <ChoiceRow
            choices={CURRENCY_FORMAT_CHOICES}
            selected={options.currencyFormat}
            onSelect={(currencyFormat) => patch({ currencyFormat })}
          />
        </div>
        {options.currencyFormat === 'full' ? (
          <div style={f.field}>
            <MutedText as="div" style={f.fieldLabel}>
              Decimals
            </MutedText>
            <Counter
              value={clamp(options.decimals, 0, 5)}
              min={0}
              max={5}
              onChange={(decimals) => patch({ decimals })}
            />
          </div>
        ) : null}
      </div>
    );
  }

  // DATE / DATE_TIME.
  const customInvalid =
    options.dateDisplayFormat === 'CUSTOM' &&
    !isValidCustomUnicodeDateFormat(options.customUnicodeDateFormat);
  return (
    <div>
      <div style={f.field}>
        <MutedText as="div" style={f.fieldLabel}>
          Display format
        </MutedText>
        <ChoiceRow
          choices={DATE_FORMAT_CHOICES}
          selected={options.dateDisplayFormat}
          onSelect={(dateDisplayFormat) => patch({ dateDisplayFormat })}
        />
      </div>
      {options.dateDisplayFormat === 'CUSTOM' ? (
        <div style={f.field}>
          <MutedText as="div" style={f.fieldLabel}>
            Custom Unicode format
          </MutedText>
          <MonoInput
            style={f.input}
            value={options.customUnicodeDateFormat}
            placeholder="e.g. yyyy-MM-dd HH:mm"
            onChange={(event) =>
              patch({ customUnicodeDateFormat: event.target.value })
            }
          />
          {customInvalid ? (
            <ErrText as="div" style={f.err}>
              Enter a Unicode date pattern (e.g. yyyy-MM-dd).
            </ErrText>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};

// Layout-only values (padding, gaps, margins) — every color/font-family-for-
// body-text/background/border comes from the archetypes in lib/ui.tsx or
// lib/ui-tokens instead (spec: docs/superpowers/specs/
// 2026-07-04-formula-field-ui-polish-design.md).
const f: Record<string, React.CSSProperties> = {
  field: { marginBottom: '10px' },
  fieldLabel: { marginBottom: '4px' },
  choiceRow: { display: 'flex', flexWrap: 'wrap', gap: '6px' },
  counter: { display: 'flex', alignItems: 'center', gap: '8px' },
  counterValue: {
    minWidth: '24px',
    textAlign: 'center',
    fontVariantNumeric: 'tabular-nums',
    fontSize: '13px',
  },
  input: { width: '100%', boxSizing: 'border-box' },
  hint: { marginBottom: '6px' },
  err: { marginTop: '4px' },
  optionRow: { display: 'flex', gap: 4, alignItems: 'center', marginBottom: 4 },
  optionLabel: { flex: 1 },
  optionValue: { fontFamily: 'ui-monospace, monospace', minWidth: 80 },
};

type SelectOptionsEditorProps = {
  drafts: SelectOptionDraft[];
  onChange: (drafts: SelectOptionDraft[]) => void;
};

// One-time options editor for the wizard's `select` format (ADR 0029 D7):
// options are defined here, at field creation, and the app never edits them
// again — post-creation management is Twenty's native data model settings.
// The option VALUE derives from the label (platform UPPER_SNAKE rule) and is
// shown read-only; row order is the option position.
export const SelectOptionsEditor = ({
  drafts,
  onChange,
}: SelectOptionsEditorProps) => {
  const patchRow = (index: number, patch: Partial<SelectOptionDraft>) =>
    onChange(
      drafts.map((draft, position) =>
        position === index ? { ...draft, ...patch } : draft,
      ),
    );
  const moveRow = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= drafts.length) return;
    const next = [...drafts];
    const [moved] = next.splice(index, 1);
    next.splice(target, 0, moved);
    onChange(next);
  };
  const removeRow = (index: number) =>
    onChange(drafts.filter((_draft, position) => position !== index));
  const addRow = () =>
    onChange([
      ...drafts,
      {
        label: '',
        color: SELECT_OPTION_COLORS[drafts.length % SELECT_OPTION_COLORS.length],
      },
    ]);
  const cycleColor = (index: number) => {
    const current = SELECT_OPTION_COLORS.indexOf(drafts[index].color);
    patchRow(index, {
      color: SELECT_OPTION_COLORS[(current + 1) % SELECT_OPTION_COLORS.length],
    });
  };
  const problem = selectOptionsProblem(drafts);

  return (
    <div>
      {drafts.map((draft, index) => (
        <div key={index} style={f.optionRow}>
          <StepperButton
            onClick={() => moveRow(index, -1)}
            disabled={index === 0}
          >
            ↑
          </StepperButton>
          <StepperButton
            onClick={() => moveRow(index, 1)}
            disabled={index === drafts.length - 1}
          >
            ↓
          </StepperButton>
          <TextInput
            value={draft.label}
            placeholder="Option label"
            onChange={(event) => patchRow(index, { label: event.target.value })}
            style={f.optionLabel}
          />
          <MutedText style={f.optionValue}>
            {deriveOptionValue(draft.label) || '—'}
          </MutedText>
          <ChoiceChip selected={false} onMouseDown={() => cycleColor(index)}>
            {draft.color}
          </ChoiceChip>
          <StepperButton
            onClick={() => removeRow(index)}
            disabled={drafts.length === 1}
          >
            ×
          </StepperButton>
        </div>
      ))}
      <SecondaryButton onClick={addRow}>Add option</SecondaryButton>
      {problem ? (
        <ErrText as="div" style={f.err}>
          {problem}
        </ErrText>
      ) : (
        <HintText as="div" style={f.hint}>
          Options are created once with the field; edit them later in Twenty's
          data model settings.
        </HintText>
      )}
    </div>
  );
};
