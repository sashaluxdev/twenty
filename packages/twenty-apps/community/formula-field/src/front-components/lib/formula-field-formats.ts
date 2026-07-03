// Output formats the "Add formula field" wizard offers, and how each maps to
// Twenty field metadata (createOneField input). Pure data + helpers so the
// mapping is unit-testable without a client.
//
// The settings shapes below MATCH what the native field-settings UI writes, so
// wizard-created (and editor-updated) fields stay editable in the native UI.
// The server does no validation of NUMBER/CURRENCY/DATE/DATE_TIME settings
// (passthrough JSONB), so parity is our own responsibility.

export type OutputFormat =
  | 'integer'
  | 'decimal'
  | 'percent'
  | 'shortNumber'
  | 'currency'
  | 'date'
  | 'datetime';

// The `type` key the native NUMBER settings UI writes.
export type NumberDisplayType = 'number' | 'percentage' | 'shortNumber';
// The `format` key the native CURRENCY settings UI writes.
export type CurrencyFormat = 'short' | 'full';
// The `displayFormat` key the native DATE / DATE_TIME settings UI writes.
export type DateDisplayFormat = 'USER_SETTINGS' | 'RELATIVE' | 'CUSTOM';

export type OutputFormatDefinition = {
  key: OutputFormat;
  label: string;
  // Shown under the format button in the wizard.
  hint: string;
  // createOneField input pieces.
  fieldType: 'NUMBER' | 'CURRENCY' | 'DATE' | 'DATE_TIME';
  // Value stored on FormulaDefinition.targetFieldType (drives value IO).
  targetFieldType: 'NUMBER' | 'CURRENCY' | 'DATE' | 'DATE_TIME';
  // NUMBER formats: the native `settings.type` this format defaults to.
  numberDisplayType?: NumberDisplayType;
  // Decimals the format seeds when the user has not touched the counter.
  defaultDecimals: number;
};

export const OUTPUT_FORMATS: OutputFormatDefinition[] = [
  {
    key: 'integer',
    label: 'Integer',
    hint: '42',
    fieldType: 'NUMBER',
    targetFieldType: 'NUMBER',
    numberDisplayType: 'number',
    defaultDecimals: 0,
  },
  {
    key: 'decimal',
    label: 'Decimal',
    hint: '3.14',
    fieldType: 'NUMBER',
    targetFieldType: 'NUMBER',
    numberDisplayType: 'number',
    defaultDecimals: 2,
  },
  {
    key: 'percent',
    label: 'Percent',
    hint: '35%',
    fieldType: 'NUMBER',
    targetFieldType: 'NUMBER',
    numberDisplayType: 'percentage',
    defaultDecimals: 2,
  },
  {
    key: 'shortNumber',
    label: 'Short',
    hint: '1.2k',
    fieldType: 'NUMBER',
    targetFieldType: 'NUMBER',
    numberDisplayType: 'shortNumber',
    defaultDecimals: 0,
  },
  {
    key: 'currency',
    label: 'Currency',
    hint: 'in micros',
    fieldType: 'CURRENCY',
    targetFieldType: 'CURRENCY',
    defaultDecimals: 0,
  },
  // DATE / DATE_TIME values are the Excel serial-date model — epoch-days —
  // serialized to the scalar on write.
  {
    key: 'date',
    label: 'Date',
    hint: 'yyyy-MM-dd',
    fieldType: 'DATE',
    targetFieldType: 'DATE',
    defaultDecimals: 0,
  },
  {
    key: 'datetime',
    label: 'Date & time',
    hint: 'ISO UTC',
    fieldType: 'DATE_TIME',
    targetFieldType: 'DATE_TIME',
    defaultDecimals: 0,
  },
];

// Currency codes the wizard/editor offer; JPY is the default when the user does
// not intervene. The chosen code becomes the field's default currency and the
// code recompute writes on records that have none.
export const CURRENCY_CODES = ['JPY', 'USD', 'EUR', 'GBP', 'CHF', 'CAD'];
export const DEFAULT_CURRENCY_CODE = 'JPY';

export const getOutputFormat = (key: OutputFormat): OutputFormatDefinition => {
  const format = OUTPUT_FORMATS.find((candidate) => candidate.key === key);
  if (!format) {
    throw new Error(`Unknown output format: ${key}`);
  }
  return format;
};

// The tunable options a format exposes. One shape covers every format; only the
// keys relevant to the selected format are read by buildFieldSettings.
export type FormatOptions = {
  numberDisplayType: NumberDisplayType;
  decimals: number;
  currencyFormat: CurrencyFormat;
  currencyCode: string;
  dateDisplayFormat: DateDisplayFormat;
  customUnicodeDateFormat: string;
};

// The default options for a freshly-picked format (seeds the wizard controls).
export const makeFormatOptions = (format: OutputFormat): FormatOptions => {
  const definition = getOutputFormat(format);
  return {
    numberDisplayType: definition.numberDisplayType ?? 'number',
    decimals: definition.defaultDecimals,
    currencyFormat: 'short',
    currencyCode: DEFAULT_CURRENCY_CODE,
    dateDisplayFormat: 'USER_SETTINGS',
    customUnicodeDateFormat: '',
  };
};

const clampDecimals = (value: number, min: number, max: number): number => {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
};

// Builds the createOneField/updateOneField `settings` object for a format +
// options, exactly matching the native settings UI shapes. Returns null when the
// field type carries no settings.
export const buildFieldSettings = (
  format: OutputFormat,
  options: FormatOptions,
): Record<string, unknown> | null => {
  const definition = getOutputFormat(format);

  if (definition.fieldType === 'NUMBER') {
    const displayType = options.numberDisplayType;
    // shortNumber forces (and hides) decimals — mirrors the native form.
    const decimals =
      displayType === 'shortNumber' ? 0 : clampDecimals(options.decimals, 0, 100);
    return {
      type: displayType,
      decimals,
      // Harmless extra key we have always written; the native UI ignores it.
      dataType: decimals > 0 || displayType === 'shortNumber' ? 'float' : 'int',
    };
  }

  if (definition.fieldType === 'CURRENCY') {
    const settings: Record<string, unknown> = { format: options.currencyFormat };
    // decimals is only meaningful for the 'full' format (native hides it for
    // 'short').
    if (options.currencyFormat === 'full') {
      settings.decimals = clampDecimals(options.decimals, 0, 5);
    }
    return settings;
  }

  // DATE / DATE_TIME.
  const settings: Record<string, unknown> = {
    displayFormat: options.dateDisplayFormat,
  };
  if (options.dateDisplayFormat === 'CUSTOM') {
    settings.customUnicodeDateFormat = options.customUnicodeDateFormat.trim();
  }
  return settings;
};

// The CURRENCY defaultValue the native UI writes: amountMicros null + a
// SINGLE-QUOTE-WRAPPED currency code (the server's quoted-literal convention).
export const buildCurrencyDefaultValue = (
  currencyCode: string,
): { amountMicros: null; currencyCode: string } => ({
  amountMicros: null,
  currencyCode: `'${currencyCode}'`,
});

// A CUSTOM date format must be non-empty and look like a Unicode date pattern
// (contains at least one date/time token letter). The native validator is
// frontend-only, so a light sanity check is enough.
export const isValidCustomUnicodeDateFormat = (value: string): boolean => {
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  return /[yYMdDhHmsSEa]/.test(trimmed);
};

// True when the current options are complete enough to create/update the field
// (only CUSTOM date formats can be incomplete).
export const areFormatOptionsValid = (
  format: OutputFormat,
  options: FormatOptions,
): boolean => {
  const definition = getOutputFormat(format);
  if (
    (definition.fieldType === 'DATE' || definition.fieldType === 'DATE_TIME') &&
    options.dateDisplayFormat === 'CUSTOM'
  ) {
    return isValidCustomUnicodeDateFormat(options.customUnicodeDateFormat);
  }
  return true;
};

// What we persist on FormulaDefinition.targetFieldSettings so the wizard/editor
// stay resumable and can restore the exact chosen options.
export type TargetFieldSettings = {
  settings: Record<string, unknown> | null;
  currencyCode?: string;
};

export const serializeTargetFieldSettings = (
  value: TargetFieldSettings,
): string => JSON.stringify(value);

export const parseTargetFieldSettings = (
  raw: string,
): TargetFieldSettings | null => {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as {
      settings?: Record<string, unknown> | null;
      currencyCode?: unknown;
    };
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      settings: (parsed.settings ?? null) as Record<string, unknown> | null,
      currencyCode:
        typeof parsed.currencyCode === 'string' ? parsed.currencyCode : undefined,
    };
  } catch {
    return null;
  }
};

// Reconstructs FormatOptions from a persisted settings object (+ currency code),
// overlaying whatever is present onto the format's defaults. Used to resume the
// wizard and to seed the definition editor's settings form from the live field.
export const optionsFromSettings = (
  format: OutputFormat,
  settings: Record<string, unknown> | null,
  currencyCode?: string,
): FormatOptions => {
  const options = makeFormatOptions(format);
  if (currencyCode) options.currencyCode = currencyCode;
  if (!settings) return options;

  const definition = getOutputFormat(format);
  if (definition.fieldType === 'NUMBER') {
    if (
      settings.type === 'number' ||
      settings.type === 'percentage' ||
      settings.type === 'shortNumber'
    ) {
      options.numberDisplayType = settings.type;
    }
    if (typeof settings.decimals === 'number') {
      options.decimals = settings.decimals;
    }
  }
  if (definition.fieldType === 'CURRENCY') {
    if (settings.format === 'short' || settings.format === 'full') {
      options.currencyFormat = settings.format;
    }
    if (typeof settings.decimals === 'number') {
      options.decimals = settings.decimals;
    }
  }
  if (definition.fieldType === 'DATE' || definition.fieldType === 'DATE_TIME') {
    if (
      settings.displayFormat === 'USER_SETTINGS' ||
      settings.displayFormat === 'RELATIVE' ||
      settings.displayFormat === 'CUSTOM'
    ) {
      options.dateDisplayFormat = settings.displayFormat;
    }
    if (typeof settings.customUnicodeDateFormat === 'string') {
      options.customUnicodeDateFormat = settings.customUnicodeDateFormat;
    }
  }
  return options;
};

// Derives a valid field API name from a human label: split on anything
// non-alphanumeric, camelCase the words, drop leading digits (names must start
// with a lowercase letter). Returns '' when nothing usable remains.
export const deriveFieldName = (label: string): string => {
  const words = label
    .split(/[^a-zA-Z0-9]+/)
    .flatMap((word) => word.split(/(?=[A-Z][a-z])/))
    .filter((word) => word.length > 0);

  const joined = words
    .map((word, index) =>
      index === 0
        ? word.toLowerCase()
        : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase(),
    )
    .join('')
    .replace(/^[0-9]+/, '');

  if (joined.length === 0) {
    return '';
  }
  // Postgres identifier limit is 63; leave headroom for suffixed columns.
  return (joined.charAt(0).toLowerCase() + joined.slice(1)).slice(0, 50);
};

export const isValidFieldName = (name: string): boolean =>
  /^[a-z][a-zA-Z0-9]*$/.test(name);
