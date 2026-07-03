// Output formats the "Add formula field" wizard offers, and how each maps to
// Twenty field metadata (createOneField input). Pure data + helpers so the
// mapping is unit-testable without a client.

export type OutputFormat = 'integer' | 'decimal' | 'percent' | 'currency';

export type OutputFormatDefinition = {
  key: OutputFormat;
  label: string;
  // Shown under the format button in the wizard.
  hint: string;
  // createOneField input pieces.
  fieldType: 'NUMBER' | 'CURRENCY';
  settings: Record<string, unknown> | null;
  // Value stored on FormulaDefinition.targetFieldType (drives value IO).
  targetFieldType: 'NUMBER' | 'CURRENCY';
};

export const OUTPUT_FORMATS: OutputFormatDefinition[] = [
  {
    key: 'integer',
    label: 'Integer',
    hint: '42',
    fieldType: 'NUMBER',
    settings: { dataType: 'int', decimals: 0, type: 'number' },
    targetFieldType: 'NUMBER',
  },
  {
    key: 'decimal',
    label: 'Decimal',
    hint: '3.14',
    fieldType: 'NUMBER',
    settings: { dataType: 'float', decimals: 2, type: 'number' },
    targetFieldType: 'NUMBER',
  },
  {
    key: 'percent',
    label: 'Percent',
    hint: '35%',
    fieldType: 'NUMBER',
    settings: { dataType: 'float', decimals: 2, type: 'percentage' },
    targetFieldType: 'NUMBER',
  },
  {
    key: 'currency',
    label: 'Currency',
    hint: 'in micros',
    fieldType: 'CURRENCY',
    settings: null,
    targetFieldType: 'CURRENCY',
  },
];

export const getOutputFormat = (
  key: OutputFormat,
): OutputFormatDefinition => {
  const format = OUTPUT_FORMATS.find((candidate) => candidate.key === key);
  if (!format) {
    throw new Error(`Unknown output format: ${key}`);
  }
  return format;
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
