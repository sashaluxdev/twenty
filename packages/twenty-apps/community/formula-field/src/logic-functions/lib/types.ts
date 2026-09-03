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
  // 'NUMBER' (default when null), 'CURRENCY', 'DATE', 'DATE_TIME' or 'TEXT'. A
  // TEXT target stores the engine's string domain (ADR 0026). Currency
  // value fields are composite: the formula's numeric value is the amountMicros
  // sub-field. DATE/DATE_TIME follow the Excel serial-date model (ADR 0011):
  // the numeric value is epoch-days, serialized to the scalar on write.
  targetFieldType?: string | null;
  // Currency code written when the record has none (wizard-picked; JPY default).
  currencyCode?: string | null;
  // Wizard-picked output format: 'integer' | 'decimal' | 'percent' | 'currency'
  // | 'date' | 'datetime'. The only signal in the recompute path that
  // distinguishes an int-backed NUMBER field (dataType 'int' -> GraphQL Int
  // scalar, which rejects fractional writes) from a float one, so recompute
  // rounds integer targets before write/compare (finding M2). A
  // targetFieldSettings JSON field is being added to the object concurrently and
  // can become the authoritative source later.
  outputFormat?: string | null;
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
  // Create-time override lock (ADR 0028): false = value field born view-only,
  // overrides never honored. Immutable after creation; null (legacy rows and
  // unwidened selections) must read as true (`?? true`) everywhere.
  allowOverride?: boolean | null;
  // Display position in the record-page Formulas tab; drives the marker's
  // deterministic label order (spec §4 step 4).
  order?: number | null;
  lastValue?: number | null;
  // Mirror heartbeat (design 2026-07-06): JSON-stringified, 500-char-truncated
  // last mirrored raw value. Every non-numeric outcome (a mirror passthrough or
  // an engine text result) stores its diagnostic last value here since lastValue
  // is NUMBER-typed, which stays null in that case. Display/heartbeat only —
  // never read back for computation.
  lastValueText?: string | null;
  lastError?: string | null;
  // ISO timestamp of the last evaluation (ADR 0015: for TODAY-using formulas
  // this now means "last evaluation", not just "last value change" — see
  // recordEvaluationHeartbeat's carve-out).
  lastEvaluatedAt?: string | null;
  // Resume point for a budget-bounded full-object recompute (ADR 0025). Empty
  // string or null means "start from the first record".
  scanCursor?: string | null;
};

// What a recompute produced, tagged with the lane its bookkeeping must take.
// The tag — not a typeof probe on the payload — decides which column a value is
// recorded in and which override slot pins it: 'number' is the engine's numeric
// domain (lastValue, overrideValue), 'text' is an engine string result and 'raw'
// is a mirror passthrough (both -> lastValueText / overrideValueText). A null
// payload is still tagged, so an error or a skipped record keeps its lane.
export type ComputedValue =
  | { kind: 'number'; value: number | null }
  | { kind: 'text'; value: string | null }
  | { kind: 'raw'; value: unknown };

export type RecomputeOutcome = {
  formulaId: string;
  targetRecordId: string;
  // Whether a write to the value field actually happened.
  changed: boolean;
  // The computed value and its lane (null payload when null-propagation cleared
  // it, when the record was skipped, or when evaluation failed).
  value: ComputedValue;
  // Non-null when evaluation failed; the value field is left unchanged.
  error: string | null;
  // True when the record was skipped because the user manually overrode it.
  overridden?: boolean;
};
