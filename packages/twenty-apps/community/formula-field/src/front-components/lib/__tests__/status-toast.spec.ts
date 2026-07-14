import { describe, expect, it } from 'vitest';

import { computeStatusToasts } from 'src/front-components/lib/status-toast';

const definition = (overrides: Record<string, string> = {}) => ({
  id: 'def-1',
  name: 'Score',
  targetField: 'score',
  status: 'OFFLINE',
  statusReason: 'company.revenue is deactivated',
  ...overrides,
});

describe('computeStatusToasts', () => {
  it('emits an error toast with the reason for a newly OFFLINE formula', () => {
    const toasts = computeStatusToasts([definition()], new Map());
    expect(toasts).toEqual([
      {
        message:
          'Formula "Score" is offline — company.revenue is deactivated. ' +
          'Check the Formulas tab for details.',
        variant: 'error',
        dedupeKey: 'formula-status-def-1',
      },
    ]);
  });

  it('emits a warning toast for a newly UPSTREAM formula', () => {
    const toasts = computeStatusToasts(
      [definition({ status: 'UPSTREAM', statusReason: 'score is broken' })],
      new Map(),
    );
    expect(toasts).toEqual([
      {
        message:
          'Formula "Score" has an upstream break — score is broken. ' +
          'Check the Formulas tab for details.',
        variant: 'warning',
        dedupeKey: 'formula-status-def-1',
      },
    ]);
  });

  it('falls back to the target field name and a generic reason when empty', () => {
    const toasts = computeStatusToasts(
      [definition({ name: '', statusReason: '' })],
      new Map(),
    );
    expect(toasts[0].message).toBe(
      'Formula "score" is offline — an input field is gone. ' +
        'Check the Formulas tab for details.',
    );
  });

  it('does not re-toast an unchanged status on the next pass', () => {
    const notified = new Map<string, string>();
    expect(computeStatusToasts([definition()], notified)).toHaveLength(1);
    expect(computeStatusToasts([definition()], notified)).toHaveLength(0);
  });

  it('re-toasts when the status changes OFFLINE -> UPSTREAM', () => {
    const notified = new Map<string, string>();
    computeStatusToasts([definition()], notified);
    const toasts = computeStatusToasts(
      [definition({ status: 'UPSTREAM' })],
      notified,
    );
    expect(toasts).toHaveLength(1);
    expect(toasts[0].variant).toBe('warning');
  });

  it('re-toasts a formula that healed and then broke again', () => {
    const notified = new Map<string, string>();
    computeStatusToasts([definition()], notified);
    // Healed pass: no toast, bookkeeping cleared.
    expect(computeStatusToasts([definition({ status: '' })], notified))
      .toHaveLength(0);
    expect(computeStatusToasts([definition()], notified)).toHaveLength(1);
  });

  it('emits nothing for healthy definitions', () => {
    const notified = new Map<string, string>();
    expect(computeStatusToasts([definition({ status: '' })], notified))
      .toHaveLength(0);
    expect(notified.size).toBe(0);
  });
});
