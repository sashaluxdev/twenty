import { type SelectOption } from 'src/logic-functions/lib/kind-inference';
import { validateExpressionCore } from 'src/logic-functions/lib/validation-core';

// Live pre-save validation for the record-page editor: parse the draft
// expression and check that adding it to the current set of formulas introduces
// no dependency cycle. Delegates to the shared validation core so the editor and
// the server save path can never drift — nodes are keyed on object+field (see
// findCyclicTargets' `${object}.${field}`), so the candidate must be excluded by
// BOTH targetObject and targetField. Excluding by field alone would let two
// objects with same-named fields mask a cross-object cycle, wrongly enabling
// Save.

export type ValidatableDefinition = {
  targetObject: string;
  targetField: string;
  expression: string;
};

export const validateExpression = (
  expression: string,
  hostObject: string,
  targetField: string,
  allDefinitions: ValidatableDefinition[],
  // Sync accessor over caller-preloaded field-kind maps: objectName -> (field
  // name -> metadata type), or undefined when not preloaded. The editors close
  // it over their single host-object map. When it resolves the host object, a
  // string comparison against a same-record field that cannot hold a string is
  // rejected (parity with the server save-validation). Omitted, or a miss on the
  // host object, degrades gracefully — the check is skipped.
  fieldKinds?: (objectName: string) => Map<string, string> | undefined,
  // The candidate value field's metadata kind. A non-engine-family kind puts the
  // definition in "mirror mode": the same three mirror checks the server runs at
  // save time are applied here (allowlist, bare-ref-only, same-kind). Trailing +
  // optional so the many existing call sites/tests stay source-compatible.
  targetFieldType?: string,
  // The target field's SELECT option set, already fetched by the caller (the
  // editors thread their host-object fields query) so the live check matches
  // the server byte-for-byte. Absent/null degrades the membership gate to skip.
  targetOptions?: ReadonlyArray<SelectOption> | null,
): string | null => {
  const result = validateExpressionCore({
    expression,
    hostObject,
    targetField,
    targetFieldType,
    fieldKinds,
    targetOptions,
    otherFormulas: allDefinitions.filter(
      (definition) =>
        !(
          definition.targetObject === hostObject &&
          definition.targetField === targetField
        ),
    ),
  });

  return result.valid ? null : result.error;
};
