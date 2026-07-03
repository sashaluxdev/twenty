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
    <button
      type="button"
      style={f.counterButton}
      disabled={value <= min}
      onMouseDown={() => onChange(clamp(value - 1, min, max))}
    >
      −
    </button>
    <span style={f.counterValue}>{value}</span>
    <button
      type="button"
      style={f.counterButton}
      disabled={value >= max}
      onMouseDown={() => onChange(clamp(value + 1, min, max))}
    >
      +
    </button>
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
      <button
        key={choice.value}
        type="button"
        style={{
          ...f.choiceChip,
          ...(selected === choice.value ? f.choiceChipSelected : {}),
        }}
        onMouseDown={() => onSelect(choice.value)}
      >
        {choice.label}
      </button>
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
            <div style={f.fieldLabel}>Number type</div>
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
          <div style={f.hint}>Short numbers have no decimals (e.g. 1.2k).</div>
        ) : (
          <div style={f.field}>
            <div style={f.fieldLabel}>Decimals</div>
            <Counter
              value={options.decimals}
              min={0}
              max={100}
              onChange={(decimals) => patch({ decimals })}
            />
          </div>
        )}
        {options.numberDisplayType === 'percentage' ? (
          <div style={f.hint}>
            Percentage changes how the stored number is DISPLAYED, not the stored
            value.
          </div>
        ) : null}
      </div>
    );
  }

  if (definition.fieldType === 'CURRENCY') {
    return (
      <div>
        <div style={f.field}>
          <div style={f.fieldLabel}>Default currency</div>
          <ChoiceRow
            choices={CURRENCY_CODES.map((code) => ({ value: code, label: code }))}
            selected={options.currencyCode}
            onSelect={(currencyCode) => patch({ currencyCode })}
          />
        </div>
        <div style={f.field}>
          <div style={f.fieldLabel}>Format</div>
          <ChoiceRow
            choices={CURRENCY_FORMAT_CHOICES}
            selected={options.currencyFormat}
            onSelect={(currencyFormat) => patch({ currencyFormat })}
          />
        </div>
        {options.currencyFormat === 'full' ? (
          <div style={f.field}>
            <div style={f.fieldLabel}>Decimals</div>
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
        <div style={f.fieldLabel}>Display format</div>
        <ChoiceRow
          choices={DATE_FORMAT_CHOICES}
          selected={options.dateDisplayFormat}
          onSelect={(dateDisplayFormat) => patch({ dateDisplayFormat })}
        />
      </div>
      {options.dateDisplayFormat === 'CUSTOM' ? (
        <div style={f.field}>
          <div style={f.fieldLabel}>Custom Unicode format</div>
          <input
            style={f.input}
            value={options.customUnicodeDateFormat}
            placeholder="e.g. yyyy-MM-dd HH:mm"
            onChange={(event) =>
              patch({ customUnicodeDateFormat: event.target.value })
            }
          />
          {customInvalid ? (
            <div style={f.err}>Enter a Unicode date pattern (e.g. yyyy-MM-dd).</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};

const f: Record<string, React.CSSProperties> = {
  field: { marginBottom: '10px' },
  fieldLabel: { fontSize: '11px', color: '#908e99', marginBottom: '4px' },
  choiceRow: { display: 'flex', flexWrap: 'wrap', gap: '6px' },
  choiceChip: {
    padding: '4px 10px',
    borderRadius: '12px',
    border: '1px solid #d6d5db',
    background: '#fff',
    color: '#1b1b1f',
    cursor: 'pointer',
    fontSize: '12px',
  },
  choiceChipSelected: {
    border: '1px solid #1961ed',
    background: '#eef3fe',
    color: '#1961ed',
  },
  counter: { display: 'flex', alignItems: 'center', gap: '8px' },
  counterButton: {
    width: '24px',
    height: '24px',
    borderRadius: '4px',
    border: '1px solid #d6d5db',
    background: '#fff',
    color: '#1b1b1f',
    cursor: 'pointer',
    fontSize: '14px',
    lineHeight: '1',
    padding: 0,
  },
  counterValue: {
    minWidth: '24px',
    textAlign: 'center',
    fontVariantNumeric: 'tabular-nums',
    fontSize: '13px',
  },
  input: {
    width: '100%',
    padding: '6px 8px',
    border: '1px solid #d6d5db',
    borderRadius: '4px',
    fontSize: '13px',
    boxSizing: 'border-box',
    fontFamily: 'ui-monospace, monospace',
  },
  hint: { fontSize: '11px', color: '#b0aeb8', marginBottom: '6px' },
  err: { color: '#e0483d', fontSize: '12px', marginTop: '4px' },
};
