import { describe, expect, it } from 'vitest';

import { computeFormulaStatuses } from 'src/logic-functions/lib/formula-status';
import { type FormulaDefinitionRecord } from 'src/logic-functions/lib/types';

// Pure status graph: OFFLINE = an input field is deactivated/missing;
// UPSTREAM = reads the target field of a broken formula (transitive).

const definition = (
  overrides: Partial<FormulaDefinitionRecord> & { id: string },
): FormulaDefinitionRecord => ({
  targetObject: 'company',
  enabled: true,
  ...overrides,
});

const livenessOf = (dead: string[]) => (object: string, field: string) =>
  !dead.includes(`${object}.${field}`);

describe('computeFormulaStatuses', () => {
  it('marks a formula OFFLINE when an input field is dead', () => {
    const statuses = computeFormulaStatuses(
      [
        definition({ id: 'a', targetField: 'fa', expression: 'x + 1' }),
        definition({ id: 'b', targetField: 'fb', expression: 'employees * 2' }),
      ],
      livenessOf(['company.x']),
    );
    expect(statuses.get('a')).toEqual({
      status: 'OFFLINE',
      reason: 'input company.x is deactivated or missing',
    });
    expect(statuses.get('b')).toEqual({ status: '', reason: '' });
  });

  it('flags the whole downstream chain as UPSTREAM with the break location', () => {
    // x dies -> A OFFLINE -> B (reads A's field) UPSTREAM -> C (reads B) UPSTREAM
    const statuses = computeFormulaStatuses(
      [
        definition({ id: 'a', name: 'A', targetField: 'fa', expression: 'x' }),
        definition({ id: 'b', name: 'B', targetField: 'fb', expression: 'fa * 2' }),
        definition({ id: 'c', name: 'C', targetField: 'fc', expression: 'fb + 1' }),
      ],
      livenessOf(['company.x']),
    );
    expect(statuses.get('a')?.status).toBe('OFFLINE');
    expect(statuses.get('b')?.status).toBe('UPSTREAM');
    expect(statuses.get('b')?.reason).toContain('company.fa');
    expect(statuses.get('b')?.reason).toContain('"A" which is OFFLINE');
    expect(statuses.get('c')?.status).toBe('UPSTREAM');
    expect(statuses.get('c')?.reason).toContain('"B" which is UPSTREAM');
  });

  it('clears everything when all fields are live (recovery)', () => {
    const statuses = computeFormulaStatuses(
      [
        definition({ id: 'a', targetField: 'fa', expression: 'x' }),
        definition({ id: 'b', targetField: 'fb', expression: 'fa * 2' }),
      ],
      () => true,
    );
    expect(statuses.get('a')).toEqual({ status: '', reason: '' });
    expect(statuses.get('b')).toEqual({ status: '', reason: '' });
  });

  it('checks cross-record reference fields on their own object', () => {
    const statuses = computeFormulaStatuses(
      [
        definition({
          id: 'a',
          targetField: 'fa',
          expression:
            '[pet:11111111-1111-4111-8111-111111111111:score] * 2',
        }),
      ],
      livenessOf(['pet.score']),
    );
    expect(statuses.get('a')?.status).toBe('OFFLINE');
    expect(statuses.get('a')?.reason).toContain('pet.score');
  });

  it('treats unparseable expressions as edge-free (validation owns those)', () => {
    const statuses = computeFormulaStatuses(
      [definition({ id: 'a', targetField: 'fa', expression: '((' })],
      livenessOf(['company.anything']),
    );
    expect(statuses.get('a')).toEqual({ status: '', reason: '' });
  });

  it('does not mark a formula upstream of itself', () => {
    // fa reads its own target field (self-referencing running total style) —
    // cycle detection owns this case, not the status graph.
    const statuses = computeFormulaStatuses(
      [definition({ id: 'a', targetField: 'fa', expression: 'fa + 1' })],
      () => true,
    );
    expect(statuses.get('a')?.status).toBe('');
  });
});
