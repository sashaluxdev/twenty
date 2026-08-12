import { type AstNode } from 'src/engine/ast';

// The set of text values a formula can statically produce, or null when the
// set is open (any non-literal in an output position poisons the whole
// result). Drives the SELECT membership gate's static tier (ADR 0029 D3):
// closed set -> membership fully decidable at save/pass time; open set -> the
// per-record runtime check owns it. Condition subtrees never contribute —
// only value positions do. IFS/SWITCH need no cases: they desugar to `if`
// ladders at parse time, and a defaultless ladder's synthesized `null` node
// contributes nothing (a null output clears the field, always legal).
// O(nodes); runs at save time and once per pass, never per record.
export const staticTextOutputs = (node: AstNode): ReadonlySet<string> | null => {
  switch (node.type) {
    case 'string':
      return new Set([node.value]);
    case 'null':
      return new Set();
    case 'if': {
      const thenOutputs = staticTextOutputs(node.then);
      if (thenOutputs === null) return null;
      const elseOutputs = staticTextOutputs(node.else);
      if (elseOutputs === null) return null;
      return new Set([...thenOutputs, ...elseOutputs]);
    }
    case 'ifblank': {
      const valueOutputs = staticTextOutputs(node.value);
      if (valueOutputs === null) return null;
      const fallbackOutputs = staticTextOutputs(node.fallback);
      if (fallbackOutputs === null) return null;
      return new Set([...valueOutputs, ...fallbackOutputs]);
    }
    default:
      return null;
  }
};
