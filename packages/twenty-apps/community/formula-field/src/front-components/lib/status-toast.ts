export type ToastableDefinition = {
  id: string;
  name: string;
  targetField: string;
  status: string;
  statusReason: string;
};

export type StatusToast = {
  message: string;
  variant: 'error' | 'warning';
  dedupeKey: string;
};

// Decides which status snackbars to fire for one widget load pass. The FX
// Status companion chip is gone (ADR 0021): a broken formula announces itself
// with a snackbar pointing at the Formulas tab instead. `notified` maps
// definition id -> the status already toasted this widget session and is
// MUTATED in place: a formula toasts when it first appears broken and again
// on every status CHANGE (OFFLINE <-> UPSTREAM, heal -> re-break) — never on
// an unchanged status, so the widget's poll loop stays quiet.
export const computeStatusToasts = (
  definitions: ToastableDefinition[],
  notified: Map<string, string>,
): StatusToast[] => {
  const toasts: StatusToast[] = [];
  const broken = new Set<string>();

  for (const definition of definitions) {
    const status = definition.status;
    if (status !== 'OFFLINE' && status !== 'UPSTREAM') continue;
    broken.add(definition.id);
    if (notified.get(definition.id) === status) continue;
    notified.set(definition.id, status);

    const label = definition.name || definition.targetField;
    toasts.push(
      status === 'OFFLINE'
        ? {
            message:
              `Formula "${label}" is offline — ` +
              `${definition.statusReason || 'an input field is gone'}. ` +
              'Check the Formulas tab for details.',
            variant: 'error',
            dedupeKey: `formula-status-${definition.id}`,
          }
        : {
            message:
              `Formula "${label}" has an upstream break — ` +
              `${
                definition.statusReason ||
                'a formula earlier in the chain is broken'
              }. ` +
              'Check the Formulas tab for details.',
            variant: 'warning',
            dedupeKey: `formula-status-${definition.id}`,
          },
    );
  }

  // Formulas that healed (or disappeared) leave the map so a later re-break
  // toasts again.
  for (const id of Array.from(notified.keys())) {
    if (!broken.has(id)) notified.delete(id);
  }

  return toasts;
};
