import { bareReferenceOf, compileFormula } from 'src/engine';
import {
  isMirrorDefinition,
  selectionEntryForMirrorKind,
} from 'src/logic-functions/lib/mirror-kinds';
import {
  dependencySelectionOverrides,
  fieldSelection,
  resolveFieldKinds,
} from 'src/logic-functions/lib/recompute';
import {
  type FormulaClient,
  type FormulaDefinitionRecord,
} from 'src/logic-functions/lib/types';
import { selectionEntryForFieldKind } from 'src/logic-functions/lib/value-io';

// The field selection a scan page must carry so every node arrives complete
// enough for recomputeForRecord's prefetch check to skip its per-record fetch.
export type ScanSelection = {
  fields: string[];
  overrides: Record<string, unknown>;
};

// null means "scan id-only and let the per-record path handle it": the
// expression does not parse, a mirror source kind is unresolvable, or the
// definition is not fully configured. Guessing a selection shape here would
// hand the mirror comparison a wrongly-projected value, which reads as a real
// difference and writes.
export const buildScanSelection = async (
  client: FormulaClient,
  formula: FormulaDefinitionRecord,
): Promise<ScanSelection | null> => {
  const targetObject = formula.targetObject ?? '';
  const targetField = formula.targetField ?? '';
  const targetKind = formula.targetFieldType ?? '';
  if (targetObject === '' || targetField === '') {
    return null;
  }

  let compiled: ReturnType<typeof compileFormula>;
  try {
    compiled = compileFormula(formula.expression ?? '');
  } catch {
    return null;
  }

  if (isMirrorDefinition(compiled.ast, targetKind)) {
    const bare = bareReferenceOf(compiled.ast);
    if (bare === null) {
      return null;
    }
    const targetEntry = selectionEntryForMirrorKind(targetKind);

    // Cross-record mirror: only the current target value lives on the scanned
    // record; the source is fetched once per pass by the cross-record cache.
    if (bare.kind !== 'same') {
      return { fields: [targetField], overrides: { [targetField]: targetEntry } };
    }

    const sourceKind = (await resolveFieldKinds(client, targetObject)).get(
      bare.field,
    );
    if (sourceKind === undefined) {
      return null;
    }
    return {
      fields: [bare.field, targetField],
      overrides: {
        [bare.field]: selectionEntryForMirrorKind(sourceKind),
        [targetField]: targetEntry,
      },
    };
  }

  const fieldKinds = await resolveFieldKinds(client, targetObject);
  return {
    fields: compiled.dependencies.sameRecordFields,
    overrides: {
      ...dependencySelectionOverrides(
        compiled.dependencies.sameRecordFields,
        fieldKinds,
      ),
      [targetField]: selectionEntryForFieldKind(targetKind),
    },
  };
};

export const scanNodeSelection = (
  scan: ScanSelection,
): Record<string, unknown> => ({
  ...fieldSelection(scan.fields),
  ...scan.overrides,
});
