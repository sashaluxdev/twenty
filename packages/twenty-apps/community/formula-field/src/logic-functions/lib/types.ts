// Minimal client surface the recompute engine needs. CoreApiClient from
// twenty-client-sdk/core satisfies this, but depending on the narrow shape lets
// the engine be unit-tested with a fake client (no server, no network).

export type FormulaClient = {
  query: (selection: any) => Promise<any>;
  mutation: (selection: any) => Promise<any>;
};

// A FormulaDefinition record as the engine consumes it.
export type FormulaDefinitionRecord = {
  id: string;
  name?: string | null;
  targetObject?: string | null;
  targetField?: string | null;
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
