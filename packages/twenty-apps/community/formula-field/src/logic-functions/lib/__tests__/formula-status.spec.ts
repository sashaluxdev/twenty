import { describe, expect, it } from 'vitest';

import {
  buildTrashDeadFieldKeys,
  computeFormulaStatuses,
  type FieldLiveness,
} from 'src/logic-functions/lib/formula-status';
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

describe('trashed-target liveness (trash-dead fields)', () => {
  // A field is trash-dead iff a trashed definition created it (createdField:
  // true) AND no live definition still targets it. Trash-dead keys are
  // subtracted from the live-field set, so dependents go OFFLINE through the
  // existing dead-input path — no new status.
  const livenessExcludingTrashDead =
    (trashDead: Set<string>, base: FieldLiveness = () => true): FieldLiveness =>
    (object, field) =>
      base(object, field) && !trashDead.has(`${object}.${field}`);

  it('marks dependent OFFLINE when its input field is targeted by a trashed created-field definition', () => {
    // B reads field x on company; D (trashed) created company.x; no live def
    // still targets company.x -> x is trash-dead -> B goes OFFLINE naming x.
    const dependent = definition({
      id: 'b',
      targetField: 'fb',
      expression: 'x + 1',
    });
    const trashed = [
      { targetObject: 'company', targetField: 'x', createdField: true },
    ];
    const trashDead = buildTrashDeadFieldKeys(trashed, [dependent]);
    const statuses = computeFormulaStatuses(
      [dependent],
      livenessExcludingTrashDead(trashDead),
    );
    expect(statuses.get('b')).toEqual({
      status: 'OFFLINE',
      reason: 'input company.x is deactivated or missing',
    });
  });

  it('field stays live when another live definition still targets it', () => {
    // Same as above, but live def E still targets company.x -> not trash-dead.
    const dependent = definition({
      id: 'b',
      targetField: 'fb',
      expression: 'x + 1',
    });
    const stillLive = definition({
      id: 'e',
      targetField: 'x',
      expression: '1',
    });
    const trashed = [
      { targetObject: 'company', targetField: 'x', createdField: true },
    ];
    const trashDead = buildTrashDeadFieldKeys(trashed, [dependent, stillLive]);
    expect(trashDead.size).toBe(0);
    const statuses = computeFormulaStatuses(
      [dependent, stillLive],
      livenessExcludingTrashDead(trashDead),
    );
    expect(statuses.get('b')).toEqual({ status: '', reason: '' });
  });

  it('field stays live when the trashed definition did not create the field', () => {
    // D targeted company.x but did NOT create it (createdField: false), so the
    // column is a pre-existing regular field the app must not treat as dead.
    const dependent = definition({
      id: 'b',
      targetField: 'fb',
      expression: 'x + 1',
    });
    const trashed = [
      { targetObject: 'company', targetField: 'x', createdField: false },
    ];
    const trashDead = buildTrashDeadFieldKeys(trashed, [dependent]);
    expect(trashDead.size).toBe(0);
    const statuses = computeFormulaStatuses(
      [dependent],
      livenessExcludingTrashDead(trashDead),
    );
    expect(statuses.get('b')).toEqual({ status: '', reason: '' });
  });
});
