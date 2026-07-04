import { describe, expect, it } from 'vitest';

import {
  sortByOrder,
  movePreview,
  computeReorderWrites,
  computeDropWrite,
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

describe('computeDropWrite', () => {
  it('returns empty array when draggedId is unknown', () => {
    const input = [
      { id: 'a', order: 0 },
      { id: 'b', order: 1 },
    ];
    const result = computeDropWrite(input, 'unknown');
    expect(result).toEqual([]);
  });

  it('dragged between numbered neighbors → midpoint write only', () => {
    const input = [
      { id: 'a', order: 0 },
      { id: 'x', order: 1.5 },
      { id: 'b', order: 1 },
    ];
    const result = computeDropWrite(input, 'x');
    expect(result).toEqual([{ id: 'x', order: 0.5 }]);
  });

  it('dragged to top (next neighbor order 0) → order -1', () => {
    const input = [
      { id: 'x', order: 1.5 },
      { id: 'a', order: 0 },
    ];
    const result = computeDropWrite(input, 'x');
    expect(result).toEqual([{ id: 'x', order: -1 }]);
  });

  it('dragged to bottom (prev neighbor order 3) → order 4', () => {
    const input = [
      { id: 'a', order: 3 },
      { id: 'x', order: 0 },
    ];
    const result = computeDropWrite(input, 'x');
    expect(result).toEqual([{ id: 'x', order: 4 }]);
  });

  it('drag returned to origin (already strictly between neighbors) → empty', () => {
    const input = [
      { id: 'a', order: 0 },
      { id: 'x', order: 0.5 },
      { id: 'b', order: 1 },
    ];
    const result = computeDropWrite(input, 'x');
    expect(result).toEqual([]);
  });

  it('single-item list, numbered → empty', () => {
    const input = [{ id: 'a', order: 5 }];
    const result = computeDropWrite(input, 'a');
    expect(result).toEqual([]);
  });

  it('single-item list, null → assign 0', () => {
    const input = [{ id: 'a', order: null }];
    const result = computeDropWrite(input, 'a');
    expect(result).toEqual([{ id: 'a', order: 0 }]);
  });

  it('previous neighbor null → full reindex', () => {
    const input = [
      { id: 'a', order: null },
      { id: 'x', order: 1 },
      { id: 'b', order: 2 },
    ];
    const result = computeDropWrite(input, 'x');
    expect(result).toEqual(computeReorderWrites(input));
  });

  it('next neighbor null → full reindex', () => {
    const input = [
      { id: 'a', order: 0 },
      { id: 'x', order: 1 },
      { id: 'b', order: null },
    ];
    const result = computeDropWrite(input, 'x');
    expect(result).toEqual(computeReorderWrites(input));
  });

  it('duplicate neighbor orders (both 2) → full reindex', () => {
    const input = [
      { id: 'a', order: 2 },
      { id: 'x', order: 1.5 },
      { id: 'b', order: 2 },
    ];
    const result = computeDropWrite(input, 'x');
    expect(result).toEqual(computeReorderWrites(input));
  });

  it('NaN neighbor → full reindex', () => {
    const input = [
      { id: 'a', order: NaN },
      { id: 'x', order: 1 },
      { id: 'b', order: 2 },
    ];
    const result = computeDropWrite(input, 'x');
    expect(result).toEqual(computeReorderWrites(input));
  });

  it('precision exhaustion: neighbors 1 and 1 + Number.EPSILON (midpoint rounds to one) → full reindex', () => {
    const left = 1;
    const right = 1 + Number.EPSILON;
    const midpoint = (left + right) / 2;
    // Precondition: the float assumption this test rests on. If IEEE 754
    // rounding ever stopped collapsing this midpoint onto a neighbor, the
    // test must fail loudly, not silently pass.
    expect(midpoint === left || midpoint === right).toBe(true);
    const input = [
      { id: 'a', order: left },
      { id: 'x', order: 1.5 },
      { id: 'b', order: right },
    ];
    const result = computeDropWrite(input, 'x');
    expect(result).toEqual(computeReorderWrites(input));
  });

  it('neighbor order equal to dragged order is not treated as origin (strict comparison) → midpoint write', () => {
    const input = [
      { id: 'a', order: 1 },
      { id: 'x', order: 1 },
      { id: 'b', order: 2 },
    ];
    const result = computeDropWrite(input, 'x');
    expect(result).toEqual([{ id: 'x', order: 1.5 }]);
  });

  it('sortByOrder with NaN/negative/fractional/duplicate orders stays total + non-lossy', () => {
    const input = [
      { id: 'a', order: 2 },
      { id: 'b', order: NaN },
      { id: 'c', order: -5 },
      { id: 'd', order: 1.5 },
      { id: 'e', order: 2 },
      { id: 'f', order: null },
    ];
    const result = sortByOrder(input);
    expect(result).toHaveLength(input.length);
    expect(result.map((x) => x.id)).toEqual(
      expect.arrayContaining(input.map((x) => x.id)),
    );
  });

  it('movePreview with duplicate ids moves the FIRST match', () => {
    const input = [
      { id: 'a', tag: 'first' },
      { id: 'a', tag: 'second' },
      { id: 'b', tag: 'third' },
    ];
    const result = movePreview(input, 'a', 'b');
    expect(result).toEqual([
      { id: 'a', tag: 'second' },
      { id: 'b', tag: 'third' },
      { id: 'a', tag: 'first' },
    ]);
  });

  it('computeReorderWrites with duplicate ids emits positional writes without throwing', () => {
    const input = [
      { id: 'a', order: 1 },
      { id: 'a', order: 0 },
      { id: 'b', order: 2 },
    ];
    const result = computeReorderWrites(input);
    // Reindex to 0..N-1: first 'a' (stored 1) → 0, second 'a' (stored 0) → 1,
    // 'b' (stored 2) already matches index 2 and is omitted.
    expect(result).toHaveLength(2);
    expect(result).toEqual([
      { id: 'a', order: 0 },
      { id: 'a', order: 1 },
    ]);
  });
});
