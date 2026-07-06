// Structural JSON equality for mirror-mode no-op suppression (design 2026-07-06).
// A mirror writes the source field's raw value onto the target verbatim; before
// writing we compare the current target value against the source with this
// function so an unchanged value performs zero writes (the write-avoidance
// invariant / recursion guard, same posture as the engine path's valuesEqual).
//
// Contract:
//   - Objects compare key-order-insensitively (a fetched composite and its stored
//     twin may serialise their sub-fields in different orders).
//   - Arrays compare in order (MULTI_SELECT / secondaryLinks order is meaningful).
//   - null and undefined are treated as equal when BOTH are nullish: a
//     fetched-but-empty composite arrives as null while an absent key reads as
//     undefined — both mean "no value", so a null source over an empty target is
//     a no-op rather than a spurious clear.
export const deepJsonEqual = (a: unknown, b: unknown): boolean => {
  const aNullish = a === null || a === undefined;
  const bNullish = b === null || b === undefined;
  if (aNullish || bNullish) {
    return aNullish && bNullish;
  }

  if (typeof a !== typeof b) {
    return false;
  }

  if (typeof a !== 'object') {
    return a === b;
  }

  const aIsArray = Array.isArray(a);
  const bIsArray = Array.isArray(b);
  if (aIsArray !== bIsArray) {
    return false;
  }

  if (aIsArray && bIsArray) {
    if (a.length !== b.length) {
      return false;
    }
    return a.every((item, index) => deepJsonEqual(item, b[index]));
  }

  const aObject = a as Record<string, unknown>;
  const bObject = b as Record<string, unknown>;
  const aKeys = Object.keys(aObject);
  const bKeys = Object.keys(bObject);
  if (aKeys.length !== bKeys.length) {
    return false;
  }
  return aKeys.every(
    (key) =>
      Object.prototype.hasOwnProperty.call(bObject, key) &&
      deepJsonEqual(aObject[key], bObject[key]),
  );
};
