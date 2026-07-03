import { describe, expect, it } from 'vitest';

import {
  serializeArgumentValue,
  serializeSelection,
} from 'src/logic-functions/lib/dynamic-client';

describe('serializeArgumentValue', () => {
  it('serializes scalars', () => {
    expect(serializeArgumentValue(42)).toBe('42');
    expect(serializeArgumentValue(-1.5)).toBe('-1.5');
    expect(serializeArgumentValue(true)).toBe('true');
    expect(serializeArgumentValue(null)).toBe('null');
    expect(serializeArgumentValue(undefined)).toBe('null');
    expect(serializeArgumentValue('a "quoted" string')).toBe(
      '"a \\"quoted\\" string"',
    );
  });

  it('serializes nested objects and arrays (filters, composites, JSON)', () => {
    expect(serializeArgumentValue({ id: { eq: 'abc' } })).toBe(
      '{ id: { eq: "abc" } }',
    );
    expect(
      serializeArgumentValue({ amountMicros: 5, currencyCode: 'USD' }),
    ).toBe('{ amountMicros: 5, currencyCode: "USD" }');
    expect(serializeArgumentValue([1, 'two', null])).toBe('[1, "two", null]');
  });

  it('drops undefined object entries and non-finite numbers', () => {
    expect(serializeArgumentValue({ keep: 1, drop: undefined })).toBe(
      '{ keep: 1 }',
    );
    expect(serializeArgumentValue(Number.NaN)).toBe('null');
  });
});

describe('serializeSelection', () => {
  it('serializes a singular record read with a composite sub-selection', () => {
    const query = serializeSelection({
      company: {
        __args: { filter: { id: { eq: 'c1' } } },
        id: true,
        employees: true,
        wizardBudget: { amountMicros: true, currencyCode: true },
      },
    });
    expect(query).toBe(
      '{ company(filter: { id: { eq: "c1" } }) ' +
        '{ id employees wizardBudget { amountMicros currencyCode } } }',
    );
  });

  it('serializes a paginated connection read', () => {
    const query = serializeSelection({
      companies: {
        __args: { first: 100, after: 'cursor' },
        edges: { node: { id: true } },
        pageInfo: { hasNextPage: true, endCursor: true },
      },
    });
    expect(query).toBe(
      '{ companies(first: 100, after: "cursor") ' +
        '{ edges { node { id } } pageInfo { hasNextPage endCursor } } }',
    );
  });

  it('serializes an update mutation with data payload', () => {
    const mutation = serializeSelection({
      updateCompany: {
        __args: {
          id: 'c1',
          data: { wizardBudget: { amountMicros: 3, currencyCode: 'EUR' } },
        },
        id: true,
      },
    });
    expect(mutation).toBe(
      '{ updateCompany(id: "c1", data: ' +
        '{ wizardBudget: { amountMicros: 3, currencyCode: "EUR" } }) { id } }',
    );
  });

  it('skips false/undefined selections and empty args', () => {
    expect(
      serializeSelection({
        person: { __args: {}, id: true, hidden: false, missing: undefined },
      }),
    ).toBe('{ person { id } }');
  });
});
