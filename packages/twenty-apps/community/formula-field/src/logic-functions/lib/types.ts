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
  // 'NUMBER' (default when null), 'CURRENCY', 'DATE' or 'DATE_TIME'. Currency
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
  lastValue?: number | null;
  // Mirror heartbeat (design 2026-07-06): JSON-stringified, 500-char-truncated
  // last mirrored raw value. Non-engine (mirror) targets store their diagnostic
  // last value here since lastValue is NUMBER-typed; lastValue stays null for a
  // mirror. Display/heartbeat only — never read back for computation.
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

export type RecomputeOutcome = {
  formulaId: string;
  targetRecordId: string;
  // Whether a write to the value field actually happened.
  changed: boolean;
  // The computed value (null when null-propagation cleared it). Always null for
  // a mirror passthrough — its raw value rides `rawValue` instead.
  value: number | null;
  // Mirror passthrough only: the source field's raw value written verbatim
  // (scalar, array or composite). Undefined for engine-family formulas. Carried
  // so the column-level heartbeat can derive lastValueText from a sample record.
  rawValue?: unknown;
  // Non-null when evaluation failed; the value field is left unchanged.
  error: string | null;
  // True when the record was skipped because the user manually overrode it.
  overridden?: boolean;
};
