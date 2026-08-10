export type RowStatus =
  | { kind: 'awaiting' }
  | { kind: 'error'; message: string }
  | { kind: 'ok' };

export const AWAITING_EXPRESSION_HINT =
  'Field created — write the formula expression and save to activate.';

// Feature B: an empty saved expression with an untouched draft is a fresh
// wizard field awaiting its formula, not a parse error. Same guard the
// definition editor applies (awaitingExpression).
export const resolveRowStatus = ({
  expression,
  draft,
  liveError,
  lastError,
}: {
  expression: string;
  draft: string;
  liveError: string | null;
  lastError: string;
}): RowStatus => {
  const dirty = draft !== expression;
  if (!expression && !dirty) {
    return { kind: 'awaiting' };
  }
  if (liveError) {
    return { kind: 'error', message: liveError };
  }
  if (lastError) {
    return { kind: 'error', message: lastError };
  }
  return { kind: 'ok' };
};
