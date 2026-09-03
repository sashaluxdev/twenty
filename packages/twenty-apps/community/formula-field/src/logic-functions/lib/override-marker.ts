import { type FormulaDefinitionRecord } from 'src/logic-functions/lib/types';

export const MARKER_FIELD_NAME = 'fxOverrides';
export const MARKER_FIELD_LABEL = 'Overrides';
export const MARKER_FIELD_DESCRIPTION =
  'Formula fields currently overridden on this record. Managed by the Formula Field app.';
export const MARKER_FIELD_ICON = 'IconPinned';

const definitionLabel = (definition: FormulaDefinitionRecord): string =>
  definition.name || definition.targetField || '';

// The record's expected "Overrides" value: labels of this object's enabled,
// override-allowed formula fields that currently hold an active pin, in the
// Formulas tab's display order. '' means "no overrides" (stored as SQL NULL).
export const computeMarkerValue = (
  objectName: string,
  definitions: FormulaDefinitionRecord[],
  activeOverrideFields: ReadonlySet<string>,
): string => {
  const eligible = definitions
    .filter((definition) => definition.targetObject === objectName)
    .filter((definition) => definition.enabled === true)
    .filter((definition) => definition.allowOverride !== false)
    .filter((definition) =>
      activeOverrideFields.has(definition.targetField ?? ''),
    )
    .sort((a, b) => {
      const orderA = a.order ?? Number.POSITIVE_INFINITY;
      const orderB = b.order ?? Number.POSITIVE_INFINITY;
      if (orderA !== orderB) return orderA - orderB;
      return definitionLabel(a).localeCompare(definitionLabel(b));
    });

  const seenFields = new Set<string>();
  const labels: string[] = [];
  for (const definition of eligible) {
    const field = definition.targetField ?? '';
    if (seenFields.has(field)) continue;
    seenFields.add(field);
    labels.push(definitionLabel(definition));
  }
  return labels.join(', ');
};
