import {
  CURRENCY_CODES,
  type CurrencyFormat,
  type DateDisplayFormat,
  type FormatOptions,
  getOutputFormat,
  isValidCustomUnicodeDateFormat,
  type NumberDisplayType,
  type OutputFormat,
} from 'src/front-components/lib/formula-field-formats';
import {
  ChoiceChip,
  ErrText,
  HintText,
  MonoInput,
  MutedText,
  StepperButton,
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
};
