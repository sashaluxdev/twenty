// Minimal client surface the recompute engine needs. createDynamicCoreClient()
// satisfies this; depending on the narrow shape lets the engine be unit-tested
// with a fake client (no server, no network).

export type FormulaClient = {
  query: (selection: any) => Promise<any>;
  mutation: (selection: any) => Promise<any>;
  // Field name -> FieldMetadataType for an object (e.g. 'CURRENCY'). Used to
  // build sub-selections for composite dependency fields when fetching records.
  // Optional: absent (or failing) resolvers fall back to scalar selections.
  fieldKinds?: (objectName: string) => Promise<Map<string, string>>;
};

// A FormulaDefinition record as the engine consumes it.
export type FormulaDefinitionRecord = {
  id: string;
  name?: string | null;
  targetObject?: string | null;
  targetField?: string | null;
  // 'NUMBER' (default when null) or 'CURRENCY'. Currency value fields are
  // composite: the formula's numeric value is the amountMicros sub-field.
  targetFieldType?: string | null;
  // Currency code written when the record has none (wizard-picked; JPY default).
  currencyCode?: string | null;
  // True when the wizard created the value field for this definition —
  // provenance for the delete/restore field lifecycle.
  createdField?: boolean | null;
  // Operational status (system-managed): '' / 'OK' healthy, 'OFFLINE' when an
  // input field is deactivated/missing, 'UPSTREAM' when a formula earlier in
  // the dependency chain is broken.
  status?: string | null;
  statusReason?: string | null;
  expression?: string | null;
  enabled?: boolean | null;
  lastValue?: number | null;
  lastError?: string | null;
};

export type RecomputeOutcome = {
  formulaId: string;
  targetRecordId: string;
  // Whether a write to the value field actually happened.
  changed: boolean;
  // The computed value (null when null-propagation cleared it).
  value: number | null;
  // Non-null when evaluation failed; the value field is left unchanged.
  error: string | null;
  // True when the record was skipped because the user manually overrode it.
  overridden?: boolean;
};
