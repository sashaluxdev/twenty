// Pure ordering helpers for the record-page Formula tab (ADR 0013).
// null order = "never reordered": sorts after numbered rows, keeping the
// query's own fetch order (stable sort), so a fresh install is unchanged.

export const sortByOrder = <TItem extends { order: number | null }>(
  items: TItem[],
): TItem[] =>
  [...items].sort(
    (left, right) =>
      (left.order ?? Number.POSITIVE_INFINITY) -
      (right.order ?? Number.POSITIVE_INFINITY),
  );

export const movePreview = <TItem extends { id: string }>(
  items: TItem[],
  dragId: string,
  hoverId: string,
): TItem[] => {
  const fromIndex = items.findIndex((item) => item.id === dragId);
  const toIndex = items.findIndex((item) => item.id === hoverId);
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) {
    return items;
  }
  const next = [...items];
  const [dragged] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, dragged);
  return next;
};

export const computeReorderWrites = (
  items: Array<{ id: string; order: number | null }>,
): Array<{ id: string; order: number }> =>
  items
    .map((item, index) => ({ id: item.id, order: index, stored: item.order }))
    .filter((item) => item.stored !== item.order)
    .map(({ id, order }) => ({ id, order }));

// Core-aligned drop persistence (ADR 0014): ONE fractional midpoint write
// for the dragged row; full reindex only when the list needs normalizing
// (unnumbered rows involved, duplicate/NaN neighbors, or float precision
// exhausted). Items must be in FINAL visual order.
export const computeDropWrite = (
  items: Array<{ id: string; order: number | null }>,
  draggedId: string,
): Array<{ id: string; order: number }> => {
  const index = items.findIndex((item) => item.id === draggedId);
  if (index < 0) {
    return [];
  }
  const dragged = items[index];
  const previous = index > 0 ? items[index - 1] : undefined;
  const next = index < items.length - 1 ? items[index + 1] : undefined;
  if (
    (previous !== undefined && previous.order === null) ||
    (next !== undefined && next.order === null) ||
    (previous === undefined && next === undefined && dragged.order === null)
  ) {
    return computeReorderWrites(items);
  }
  const previousOrder = previous?.order ?? undefined;
  const nextOrder = next?.order ?? undefined;
  // A drag returned to its origin slot persists nothing.
  if (
    dragged.order !== null &&
    Number.isFinite(dragged.order) &&
    (previousOrder === undefined || previousOrder < dragged.order) &&
    (nextOrder === undefined || dragged.order < nextOrder)
  ) {
    return [];
  }
  let candidate: number;
  if (previousOrder === undefined && nextOrder === undefined) {
    candidate = 0;
  } else if (previousOrder === undefined) {
    candidate = (nextOrder as number) - 1;
  } else if (nextOrder === undefined) {
    candidate = previousOrder + 1;
  } else {
    candidate = (previousOrder + nextOrder) / 2;
  }
  if (
    !Number.isFinite(candidate) ||
    (previousOrder !== undefined && candidate <= previousOrder) ||
    (nextOrder !== undefined && candidate >= nextOrder)
  ) {
    return computeReorderWrites(items);
  }
  return [{ id: draggedId, order: candidate }];
};
