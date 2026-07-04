import { describe, expect, it } from 'vitest';

import {
  sortByOrder,
  movePreview,
  computeReorderWrites,
} from 'src/front-components/lib/reorder-definitions';

describe('sortByOrder', () => {
  it('returns all-null input in same sequence (fresh-install invariant)', () => {
    const input = [
      { id: 'a', order: null },
      { id: 'b', order: null },
      { id: 'c', order: null },
    ];
    const result = sortByOrder(input);
    expect(result).toEqual(input);
    expect(result).not.toBe(input); // new array
  });

  it('sorts mixed null/numbered ascending by order, nulls after in input order', () => {
    const input = [
      { id: 'a', order: 2 },
      { id: 'b', order: null },
      { id: 'c', order: 0 },
      { id: 'd', order: null },
      { id: 'e', order: 1 },
    ];
    const result = sortByOrder(input);
    expect(result).toEqual([
      { id: 'c', order: 0 },
      { id: 'e', order: 1 },
      { id: 'a', order: 2 },
      { id: 'b', order: null },
      { id: 'd', order: null },
    ]);
  });

  it('does not mutate input', () => {
    const input = [
      { id: 'a', order: 2 },
      { id: 'b', order: 1 },
    ];
    const inputCopy = JSON.parse(JSON.stringify(input));
    sortByOrder(input);
    expect(input).toEqual(inputCopy);
  });
});

describe('movePreview', () => {
  it('moves item forward in array', () => {
    const input = [
      { id: 'a' },
      { id: 'b' },
      { id: 'c' },
    ];
    const result = movePreview(input, 'a', 'c');
    expect(result).toEqual([
      { id: 'b' },
      { id: 'c' },
      { id: 'a' },
    ]);
  });

  it('moves item backward in array', () => {
    const input = [
      { id: 'a' },
      { id: 'b' },
      { id: 'c' },
    ];
    const result = movePreview(input, 'c', 'a');
    expect(result).toEqual([
      { id: 'c' },
      { id: 'a' },
      { id: 'b' },
    ]);
  });

  it('returns same reference when dragId is unknown', () => {
    const input = [
      { id: 'a' },
      { id: 'b' },
    ];
    const result = movePreview(input, 'unknown', 'a');
    expect(result).toBe(input);
  });

  it('returns same reference when hoverId is unknown', () => {
    const input = [
      { id: 'a' },
      { id: 'b' },
    ];
    const result = movePreview(input, 'a', 'unknown');
    expect(result).toBe(input);
  });

  it('returns same reference when dragId === hoverId', () => {
    const input = [
      { id: 'a' },
      { id: 'b' },
    ];
    const result = movePreview(input, 'a', 'a');
    expect(result).toBe(input);
  });

  it('does not mutate input when moving', () => {
    const input = [
      { id: 'a' },
      { id: 'b' },
      { id: 'c' },
    ];
    const inputCopy = JSON.parse(JSON.stringify(input));
    movePreview(input, 'a', 'c');
    expect(input).toEqual(inputCopy);
  });
});

describe('computeReorderWrites', () => {
  it('returns empty array when items are already 0..N-1', () => {
    const input = [
      { id: 'a', order: 0 },
      { id: 'b', order: 1 },
      { id: 'c', order: 2 },
    ];
    const result = computeReorderWrites(input);
    expect(result).toEqual([]);
  });

  it('returns writes for every row when all null', () => {
    const input = [
      { id: 'a', order: null },
      { id: 'b', order: null },
      { id: 'c', order: null },
    ];
    const result = computeReorderWrites(input);
    expect(result).toEqual([
      { id: 'a', order: 0 },
      { id: 'b', order: 1 },
      { id: 'c', order: 2 },
    ]);
  });

  it('returns only the changed rows for a single swap', () => {
    const input = [
      { id: 'a', order: 1 },
      { id: 'b', order: 0 },
    ];
    const result = computeReorderWrites(input);
    expect(result).toEqual([
      { id: 'a', order: 0 },
      { id: 'b', order: 1 },
    ]);
  });

  it('returns empty array for empty list', () => {
    const result = computeReorderWrites([]);
    expect(result).toEqual([]);
  });
});
