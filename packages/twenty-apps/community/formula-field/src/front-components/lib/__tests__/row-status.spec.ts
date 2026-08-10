import { describe, expect, it } from 'vitest';

import {
  AWAITING_EXPRESSION_HINT,
  resolveRowStatus,
} from 'src/front-components/lib/row-status';

describe('resolveRowStatus', () => {
  it('awaiting beats live and stored errors on an untouched empty expression', () => {
    expect(
      resolveRowStatus({
        expression: '',
        draft: '',
        liveError: 'PARSE_ERROR: Unexpected end of expression',
        lastError: 'stale',
      }),
    ).toEqual({ kind: 'awaiting' });
  });

  it('typing resumes live validation unchanged', () => {
    expect(
      resolveRowStatus({
        expression: '',
        draft: '1 +',
        liveError: 'PARSE_ERROR: Unexpected end of expression',
        lastError: '',
      }),
    ).toEqual({
      kind: 'error',
      message: 'PARSE_ERROR: Unexpected end of expression',
    });
  });

  it('stored lastError still surfaces when live validation passes', () => {
    expect(
      resolveRowStatus({
        expression: 'a + 1',
        draft: 'a + 1',
        liveError: null,
        lastError: 'DIVISION_BY_ZERO',
      }),
    ).toEqual({ kind: 'error', message: 'DIVISION_BY_ZERO' });
  });

  it('a saved healthy formula reads ok (mirrors always have an expression)', () => {
    expect(
      resolveRowStatus({
        expression: '[company:x:name]',
        draft: '[company:x:name]',
        liveError: null,
        lastError: '',
      }),
    ).toEqual({ kind: 'ok' });
  });

  it('exposes the exact hint string the definition editor shows', () => {
    expect(AWAITING_EXPRESSION_HINT).toBe(
      'Field created — write the formula expression and save to activate.',
    );
  });
});
