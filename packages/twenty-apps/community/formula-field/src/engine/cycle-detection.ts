import { type FormulaDependencies } from 'src/engine/dependencies';

// Cycle detection across the whole set of formula definitions. A formula target
// is a (object, field) pair. An edge target -> dependency exists when a formula
// reads a field that is ITSELF a formula target:
//   - same-record dep `depField` on object O  -> node (O, depField)
//   - cross-record dep (refObject, _, refField) -> node (refObject, refField)
//
// Record ids are intentionally ignored: a formula on (refObject, refField)
// applies to every record of refObject, so a cross-record read of that field on
// ANY record depends on that formula. Field-granular edges are conservative
// (they can only over-report a cycle, never miss one), which is the safe bias.

export type FormulaTarget = {
  object: string;
  field: string;
  dependencies: FormulaDependencies;
};

export type CycleResult =
  | { hasCycle: false }
  | { hasCycle: true; cycle: string[] };

const nodeKey = (object: string, field: string): string => `${object}.${field}`;

export const detectCycle = (formulas: FormulaTarget[]): CycleResult => {
  // Adjacency list keyed by "object.field". Only edges that point at another
  // formula target are relevant to a cycle.
  const targets = new Set(
    formulas.map((formula) => nodeKey(formula.object, formula.field)),
  );

  const adjacency = new Map<string, string[]>();

  for (const formula of formulas) {
    const from = nodeKey(formula.object, formula.field);
    const edges = new Set<string>();

    for (const field of formula.dependencies.sameRecordFields) {
      const to = nodeKey(formula.object, field);
      if (targets.has(to)) {
        edges.add(to);
      }
    }

    for (const ref of formula.dependencies.crossRecordRefs) {
      const to = nodeKey(ref.object, ref.field);
      if (targets.has(to)) {
        edges.add(to);
      }
    }

    // Merge with any existing edges (defensive: two formulas on the same target
    // would be a misconfiguration, but we still union rather than overwrite).
    const existing = adjacency.get(from) ?? [];
    adjacency.set(from, Array.from(new Set([...existing, ...edges])));
  }

  // Iterative-friendly DFS with three colors. `path` tracks the current DFS
  // stack so we can report the exact cycle.
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const path: string[] = [];

  for (const node of targets) {
    color.set(node, WHITE);
  }

  let foundCycle: string[] | null = null;

  const visit = (node: string): boolean => {
    color.set(node, GRAY);
    path.push(node);

    for (const next of adjacency.get(node) ?? []) {
      const nextColor = color.get(next) ?? WHITE;

      if (nextColor === GRAY) {
        // Back-edge: extract the cycle from where `next` first appears.
        const startIndex = path.indexOf(next);
        foundCycle = [...path.slice(startIndex), next];
        return true;
      }

      if (nextColor === WHITE && visit(next)) {
        return true;
      }
    }

    path.pop();
    color.set(node, BLACK);
    return false;
  };

  for (const node of targets) {
    if ((color.get(node) ?? WHITE) === WHITE) {
      if (visit(node)) {
        break;
      }
    }
  }

  if (foundCycle) {
    return { hasCycle: true, cycle: foundCycle };
  }

  return { hasCycle: false };
};
