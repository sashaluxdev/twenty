// Typed errors for the formula engine. Each carries a stable `code` so callers
// (recompute engine, front component) can branch on failure mode and surface a
// precise message on FormulaDefinition.lastError.

export type FormulaErrorCode =
  | 'TOKENIZE_ERROR'
  | 'PARSE_ERROR'
  | 'DIVISION_BY_ZERO'
  | 'UNKNOWN_VARIABLE'
  | 'NON_NUMERIC_VALUE'
  | 'MAX_DEPTH_EXCEEDED'
  | 'CYCLE_DETECTED';

export class FormulaError extends Error {
  readonly code: FormulaErrorCode;
  // Character offset into the source expression, when known.
  readonly position?: number;

  constructor(code: FormulaErrorCode, message: string, position?: number) {
    super(message);
    this.name = 'FormulaError';
    this.code = code;
    this.position = position;
  }
}

export const isFormulaError = (value: unknown): value is FormulaError =>
  value instanceof FormulaError;
