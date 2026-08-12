import { describe, expect, it } from 'vitest';

import { parse, type ConcatNode, type TextCastNode } from 'src/engine';
import {
  inferExpressionKind,
  strictKindGateError,
  type KindInferenceResult,
  type KindLookup,
} from 'src/logic-functions/lib/kind-inference';

const kinds = new Map<string, string>([
  ['amount', 'NUMBER'], ['price', 'CURRENCY'], ['closeDate', 'DATE'],
  ['syncedAt', 'DATE_TIME'], ['name', 'TEXT'], ['stage', 'SELECT'], ['isActive', 'BOOLEAN'],
  ['myLinks', 'LINKS'],
]);
// D5 types cross-record operands for the first time (branch 1b exempted them) — give the lookup
// a second object so a cross-ref mismatch is provable here, not only in Task 3.
const opportunityKinds = new Map<string, string>([['closeDate', 'DATE'], ['amount', 'NUMBER']]);
const kindsByObject = new Map<string, Map<string, string>>([
  ['company', kinds], ['opportunity', opportunityKinds],
]);
const lookup: KindLookup = (object) => kindsByObject.get(object);
const CROSS_CLOSE_DATE = '[opportunity:20202020-1c25-4d02-bf25-6aeccf7ea419:closeDate]';
const kindOf = (expression: string): KindInferenceResult =>
  inferExpressionKind(parse(expression), 'company', lookup);

describe('inferExpressionKind', () => {
  it.each([
    ['amount + 1', 'number'], ['closeDate + 30', 'date'], ['30 + closeDate', 'date'],
    ['syncedAt + 30', 'datetime'],                            // datetime ± number stays datetime
    ['closeDate - closeDate', 'number'], ['TODAY() - closeDate', 'number'],
    ['syncedAt - syncedAt', 'number'], ['DATE("2026-01-15")', 'date'],
    ['NUMBER(name) * 2', 'number'], ['TEXT(amount) & " units"', 'text'],
    ['IF(isActive, 1, 2)', 'number'], ['IF(amount > 3, name, stage)', 'text'],
    ['IFBLANK(name, "none")', 'text'], ['IF(ISBLANK(closeDate), 1, 0)', 'number'],
    ['IF(stage = "Won", 1, 0)', 'number'],                    // SELECT compares as text
    ['SWITCH(stage, "Won", 1, "Lost", 0)', 'number'],         // desugars to an IF ladder
    ['myLinks.primaryLinkUrl & "x"', 'text'],                 // dotted path -> unknown, not opaque
    ['price.amountMicros + 1', 'unknown'],                    // dotted path -> unknown, not number
  ])('%s infers %s', (expression, expected) => {
    expect(kindOf(expression)).toEqual({ kind: expected, error: null });
  });
  it.each([
    ['IF(closeDate = "2026-01-15", 1, 0)', /Cannot compare date with text/],
    ['IF(closeDate = syncedAt, 1, 0)', /Cannot compare date with datetime/],
    ['IF(amount = name, 1, 0)', /Cannot compare number with text/],
    ['closeDate * 2', /Cannot apply "\*"/],
    ['name + 1', /Cannot apply "\+"/],
    ['amount & "x"', /wrap number values in TEXT\(\)/],
    ['IF(amount, 1, 2)', /Condition must be a comparison or boolean field/],
    ['IF("a", 1, 2)', /Condition must be a comparison or boolean field/],
    ['IF(isActive, 1, "a")', /IF branches disagree: number vs text/],
    // The brief's literal-string form (`name < "b"`) cannot parse — the parser
    // rejects an ordering operator against a direct string literal at parse time
    // (parser.ts:1035-1045, pre-existing, unrelated to kind inference) with its
    // own "Strings support only = and != comparisons" error before this module
    // ever runs. Substituted with an equivalent two-field ordering comparison
    // (both TEXT-kinded, neither a literal) that exercises the same "equal
    // kinds outside the ordered set" path this test is for.
    ['IF(name < stage, 1, 0)', /Cannot order text values/],
    ['NUMBER(amount)', /NUMBER\(\) takes text, got number/],
    ['IF(myLinks = "x", 1, 0)', /Cannot compare/],            // opaque kind: 1b parity
    ['TEXT(myLinks)', /TEXT\(\) cannot render a LINKS field/], // opaque in TEXT()
    ['IF(closeDate < syncedAt, 1, 0)', /Cannot compare date with datetime/],   // ordered set, unequal kinds
    ['IF(amount < closeDate, 1, 0)', /Cannot compare number with date/],       // ditto (S8 regression)
    ['SWITCH(closeDate, "2026-01-15", 1, 0)', /Cannot compare date with text/], // desugared rung is typed
    [`IF(${CROSS_CLOSE_DATE} = "2026-01-15", 1, 0)`, /Cannot compare date with text/], // cross-record operand
  ])('%s is rejected: %s', (expression, message) => {
    const result = kindOf(expression);
    expect(result.kind).toBeNull();
    expect(result.error).toMatch(message);
  });
  it('treats unknown kinds as unconstrained (skip, never reject)', () => {
    const noKinds: KindLookup = () => undefined;
    expect(inferExpressionKind(parse('IF(mystery = "x", 1, 0)'), 'company', noKinds).error).toBeNull();
    expect(inferExpressionKind(parse('mystery + 1'), 'company', noKinds)).toEqual(
      { kind: 'unknown', error: null },
    );
  });
  it('stamps renderAs on TEXT nodes from the operand kind', () => {
    const ast = parse('TEXT(closeDate) & TEXT(amount) & TEXT(isActive) & TEXT(name)');
    inferExpressionKind(ast, 'company', lookup);
    const renders = (ast as ConcatNode).parts
      .filter((part): part is TextCastNode => part.type === 'textcast')
      .map((part) => part.renderAs);
    expect(renders).toEqual(['date', 'number', 'boolean', 'value']);
  });
});
describe('strictKindGateError', () => {
  const gate = (expression: string, targetFieldType: string): string | null =>
    strictKindGateError({ ast: parse(expression), hostObject: 'company',
      targetFieldType, fieldKinds: lookup });
  it('output gate: kind must match the target', () => {
    expect(gate('amount * 2', 'NUMBER')).toBeNull();
    expect(gate('closeDate + 30', 'DATE')).toBeNull();
    expect(gate('name & "!"', 'TEXT')).toBeNull();
    expect(gate('syncedAt + 30', 'DATE_TIME')).toBeNull();      // datetime target
    expect(gate('price * 2', 'CURRENCY')).toBeNull();           // CURRENCY target expects number
    expect(gate('amount * 2', 'TEXT')).toMatch(/computes number but the target field holds text/);
    expect(gate('name', 'NUMBER')).toMatch(/computes text but the target field holds number/);
    expect(gate('closeDate + 30', 'DATE_TIME')).toMatch(
      /computes date but the target field holds datetime/);
    expect(gate('name & "!"', 'CURRENCY')).toMatch(
      /computes text but the target field holds number/);
  });
  it('mirror-lane and unknown-kind definitions are never gated', () => {
    expect(gate('isActive', 'BOOLEAN')).toBeNull();          // mirror lane, 1c owns it
    expect(strictKindGateError({ ast: parse('mystery'), hostObject: 'company',
      targetFieldType: 'NUMBER', fieldKinds: () => undefined })).toBeNull();
  });
  // F2 pin: the recompute lane refuses a blank-target definition, and
  // save-validation rejects one — but the GATE must stay skip-never-reject for a
  // blank kind. Turning it into a rejector here would reject every mirror
  // definition with it (blank and non-family share this branch, 1c's territory).
  it('a blank target kind is skipped, never rejected (F2)', () => {
    expect(gate('amount * 2', '')).toBeNull();
    expect(strictKindGateError({ ast: parse('amount * 2'), hostObject: 'company',
      targetFieldType: null, fieldKinds: lookup })).toBeNull();
    expect(strictKindGateError({ ast: parse('amount * 2'), hostObject: 'company',
      targetFieldType: undefined, fieldKinds: lookup })).toBeNull();
  });
  it('SELECT targets gate as text-kind (ADR 0029 D1)', () => {
    expect(gate('IF(amount > 1, "A", "B")', 'SELECT')).toBeNull();
    expect(gate('name', 'SELECT')).toBeNull();
    expect(gate('amount * 2', 'SELECT')).toMatch(
      /computes number but the target field holds text/,
    );
  });
});
