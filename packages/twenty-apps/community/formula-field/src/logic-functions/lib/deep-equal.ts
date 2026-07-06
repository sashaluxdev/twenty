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
// Recursion depth ceiling. RAW_JSON fields are user-writable and mirrorable, so a
// pathologically deep value (~10k levels) mirrored RAW_JSON->RAW_JSON would otherwise
// blow the call stack (RangeError) inside this comparison and abort the caller.
// Capping contains that: beyond the cap we return false ("treat as changed"), so a
// too-deep value merely loses no-op suppression (one redundant, harmless write) — it
// never corrupts data and never crashes the sweep.
const MAX_JSON_EQUAL_DEPTH = 256;

export const deepJsonEqual = (a: unknown, b: unknown, depth = 0): boolean => {
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

  // Beyond the depth cap we stop recursing and treat the values as changed
  // (see MAX_JSON_EQUAL_DEPTH). Scalars above are compared at any depth; only
  // recursion into nested objects/arrays is gated here.
  if (depth >= MAX_JSON_EQUAL_DEPTH) {
    return false;
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
    return a.every((item, index) => deepJsonEqual(item, b[index], depth + 1));
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
      deepJsonEqual(aObject[key], bObject[key], depth + 1),
  );
};
