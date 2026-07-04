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
