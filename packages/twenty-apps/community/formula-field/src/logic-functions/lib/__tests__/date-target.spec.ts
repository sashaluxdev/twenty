import { beforeEach, describe, expect, it } from 'vitest';

import { MS_PER_DAY } from 'src/logic-functions/lib/date-serial';
import { handleRecordUpdate } from 'src/logic-functions/lib/handle-record-update';
import { recomputeForRecord } from 'src/logic-functions/lib/recompute';
import { type FormulaDefinitionRecord } from 'src/logic-functions/lib/types';
import { FakeClient } from 'src/logic-functions/lib/__tests__/fake-client';

// Formulas targeting a DATE / DATE_TIME value field, driven through the fake
// client (no server, no network). The numeric domain is the Excel serial-date
// model (ADR 0011): epoch-days end-to-end. Reads parse the "yyyy-MM-dd" / ISO
// scalar; writes serialize back, flooring DATE to a whole UTC day. The point of
// mirroring currency-target.spec here is the rewrite-forever trap: a fractional
// result must FLOOR and still converge, and the app's own converged write must
// not be mistaken for a human override.

const epochDay = (year: number, monthIndex: number, day: number): number =>
  Date.UTC(year, monthIndex, day) / MS_PER_DAY;

const dateFormula = (
  overrides: Partial<FormulaDefinitionRecord> = {},
): FormulaDefinitionRecord => ({
  id: 'f1',
  targetObject: 'company',
  targetField: 'renewDate',
  targetFieldType: 'DATE',
  // signedDate is a DATE input; `+ 30` is plain day math (Excel-identical).
  expression: 'signedDate + 30',
  enabled: true,
  ...overrides,
});

describe('recomputeForRecord with a DATE target field', () => {
  let client: FakeClient;

  beforeEach(() => {
    client = new FakeClient();
  });

  it('should write a "yyyy-MM-dd" string 30 days later when the input is a date', () => {
    client.seed('company', [
      { id: 'c1', signedDate: '2026-07-03', renewDate: null },
    ]);

    return recomputeForRecord({
      client,
      formula: dateFormula(),
      targetRecordId: 'c1',
    }).then((outcome) => {
      expect(outcome.changed).toBe(true);
      // 2026-07-03 + 30 days = 2026-08-02.
      expect(outcome.value).toBe(epochDay(2026, 7, 2));
      expect(client.get('company', 'c1')!.renewDate).toBe('2026-08-02');
    });
  });

  it('should converge (no rewrite loop) when the stored date already matches', async () => {
    client.seed('company', [
      { id: 'c1', signedDate: '2026-07-03', renewDate: '2026-08-02' },
    ]);

    const outcome = await recomputeForRecord({
      client,
      formula: dateFormula(),
      targetRecordId: 'c1',
    });

    expect(outcome.changed).toBe(false);
    expect(client.writes).toHaveLength(0);
  });

  it('should floor a fractional (time-carrying) result to the whole UTC day and converge', async () => {
    // signedDate carries a time-of-day; adding 30 keeps the fraction, but a DATE
    // target floors to the day, so the stored date is the 2nd and it converges.
    client.seed('company', [
      {
        id: 'c1',
        signedDate: '2026-07-03T18:00:00.000Z',
        renewDate: '2026-08-02',
      },
    ]);

    const outcome = await recomputeForRecord({
      client,
      formula: dateFormula(),
      targetRecordId: 'c1',
    });

    expect(outcome.changed).toBe(false);
    expect(client.writes).toHaveLength(0);
  });

  it('should clear the DATE value with null when an input is empty', async () => {
    client.seed('company', [
      { id: 'c1', signedDate: null, renewDate: '2026-08-02' },
    ]);

    const outcome = await recomputeForRecord({
      client,
      formula: dateFormula(),
      targetRecordId: 'c1',
    });

    expect(outcome.changed).toBe(true);
    expect(client.get('company', 'c1')!.renewDate).toBeNull();
  });
});

describe('recomputeForRecord with a DATE_TIME target field', () => {
  let client: FakeClient;

  beforeEach(() => {
    client = new FakeClient();
  });

  it('should add a fractional day (an hour) and serialize to ISO UTC, then converge on a second pass', async () => {
    // `startAt + 1/24` = one hour later. 05:00Z -> 06:00Z.
    client.seed('company', [
      { id: 'c1', startAt: '2026-07-03T05:00:00.000Z', endAt: null },
    ]);

    const formula = dateFormula({
      targetField: 'endAt',
      targetFieldType: 'DATE_TIME',
      expression: 'startAt + 1 / 24',
    });

    const first = await recomputeForRecord({
      client,
      formula,
      targetRecordId: 'c1',
    });
    expect(first.changed).toBe(true);
    expect(client.get('company', 'c1')!.endAt).toBe('2026-07-03T06:00:00.000Z');

    // Second pass reads back the ISO it just wrote and must NOT rewrite.
    const second = await recomputeForRecord({
      client,
      formula,
      targetRecordId: 'c1',
    });
    expect(second.changed).toBe(false);
    expect(client.writes).toHaveLength(1);
  });
});

describe('manual override detection on a DATE value field', () => {
  let client: FakeClient;

  beforeEach(() => {
    client = new FakeClient();
    client.seed('formulaDefinition', [
      dateFormula() as Record<string, unknown> & { id: string },
    ]);
  });

  it('should record a human edit (a different date) as an override', async () => {
    client.seed('company', [
      { id: 'c1', signedDate: '2026-07-03', renewDate: '2026-12-25' },
    ]);

    await handleRecordUpdate({
      client,
      objectName: 'company',
      recordId: 'c1',
      after: { id: 'c1', signedDate: '2026-07-03', renewDate: '2026-12-25' },
      updatedFields: ['renewDate'],
      actorWorkspaceMemberId: 'member-1',
    });

    // Override stores the NORMALIZED numeric value (epoch-days), not the string.
    expect(client.get('formulaOverride', 'formulaOverride-0')).toMatchObject({
      targetObject: 'company',
      targetField: 'renewDate',
      recordId: 'c1',
      overrideValue: epochDay(2026, 11, 25),
      active: true,
    });
  });

  it('should ignore the app recompute write (the date matches the formula)', async () => {
    client.seed('company', [
      { id: 'c1', signedDate: '2026-07-03', renewDate: '2026-08-02' },
    ]);

    await handleRecordUpdate({
      client,
      objectName: 'company',
      recordId: 'c1',
      after: { id: 'c1', signedDate: '2026-07-03', renewDate: '2026-08-02' },
      updatedFields: ['renewDate'],
      actorWorkspaceMemberId: 'member-1',
    });

    expect(client.get('formulaOverride', 'formulaOverride-0')).toBeUndefined();
  });
});

describe('IF over date dependencies (dates compare as numbers)', () => {
  let client: FakeClient;

  beforeEach(() => {
    client = new FakeClient();
  });

  it('should pick the later of two dates via an IF comparison', async () => {
    client.seed('company', [
      {
        id: 'c1',
        signedDate: '2026-07-03',
        closeDate: '2026-09-01',
        latest: null,
      },
    ]);

    const outcome = await recomputeForRecord({
      client,
      formula: dateFormula({
        targetField: 'latest',
        // Comparison at IF's condition top level (ADR 0010); dates are numbers.
        expression: 'IF(signedDate > closeDate, signedDate, closeDate)',
      }),
      targetRecordId: 'c1',
    });

    expect(outcome.changed).toBe(true);
    // closeDate (Sep 1) is later than signedDate (Jul 3).
    expect(client.get('company', 'c1')!.latest).toBe('2026-09-01');
    expect(outcome.value).toBe(epochDay(2026, 8, 1));
  });
});
