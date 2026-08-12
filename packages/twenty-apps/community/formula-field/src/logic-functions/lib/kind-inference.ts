import { type AstNode, type RenderKind } from 'src/engine';
import { staticTextOutputs } from 'src/engine/static-text-outputs';
import { ENGINE_FAMILY_KINDS } from 'src/logic-functions/lib/mirror-kinds';
import {
  targetFieldKind,
  type TargetFieldKind,
} from 'src/logic-functions/lib/value-io';

// Strict kind lattice (strict-typing arc). 'opaque' is a KNOWN field type
// outside the lattice (LINKS, MULTI_SELECT, ADDRESS, RATING, ...): it
// mismatches every operation and every known kind — preserving branch 1b/1d's
// save-time rejections, which plain 'unknown' would silently loosen. 'unknown'
// is a kind that could not be resolved at all (no metadata, or a dotted
// subpath) — every constraint is skipped, never rejected.
export type ExpressionKind =
  | 'number'
  | 'date'
  | 'datetime'
  | 'text'
  | 'boolean'
  | 'opaque'
  | 'unknown';

export type KindLookup = (
  objectName: string,
) => Map<string, string> | undefined;

// Maps a Twenty field type to a kind. Unrecognized non-empty types (LINKS,
// ADDRESS, RATING, ...) map to 'opaque', not 'unknown' — they ARE resolved,
// just outside the lattice.
export const fieldTypeToKind = (
  fieldType: string | null | undefined,
): ExpressionKind => {
  if (fieldType == null || fieldType === '') return 'unknown';
  switch (fieldType) {
    case 'NUMBER':
    case 'NUMERIC':
    case 'CURRENCY':
      return 'number';
    case 'DATE':
      return 'date';
    case 'DATE_TIME':
      return 'datetime';
    case 'TEXT':
    case 'SELECT':
      return 'text';
    case 'BOOLEAN':
      return 'boolean';
    default:
      return 'opaque';
  }
};

export type KindInferenceResult =
  | { kind: ExpressionKind; error: null }
  | { kind: null; error: string };

// Internal-only signal carrying the rejection message up to the single catch
// site in inferExpressionKind. Never exported — callers only see the result.
class KindMismatch extends Error {}

// A root-only field-type lookup: a DOTTED subpath (`price.amountMicros`)
// always misses — only a bare root reference resolves through the metadata
// map. Deliberately wrong on subpaths (a CURRENCY root holds micros, but
// `price.currencyCode` holds text) in the SAFE direction: infers 'unknown'
// (skip), never a wrong concrete kind (reject).
const rawFieldType = (
  object: string,
  path: string,
  fieldKinds?: KindLookup,
): string | undefined =>
  path.includes('.') ? undefined : fieldKinds?.(object)?.get(path);

// IF/IFBLANK branch unification: unknown defers to the other side; a matching
// known kind unifies to itself; 'opaque' unifies ONLY with 'unknown' — never
// with itself or any other known kind (two LINKS branches share a bucket
// label, not comparison semantics).
const unify = (a: ExpressionKind, b: ExpressionKind): ExpressionKind => {
  if (a === 'unknown') return b;
  if (b === 'unknown') return a;
  if (a === b && a !== 'opaque') return a;
  throw new KindMismatch(`IF branches disagree: ${a} vs ${b}`);
};

// Kind equality for comparisons: strict equality, EXCEPT 'opaque' never
// matches even itself.
const kindsMatch = (a: ExpressionKind, b: ExpressionKind): boolean =>
  a === b && a !== 'opaque';

const ORDERED_KINDS: ReadonlySet<ExpressionKind> = new Set([
  'number',
  'date',
  'datetime',
]);

const renderKindOf = (kind: ExpressionKind): RenderKind => {
  switch (kind) {
    case 'number':
      return 'number';
    case 'date':
      return 'date';
    case 'datetime':
      return 'datetime';
    case 'boolean':
      return 'boolean';
    default:
      return 'value'; // text | unknown: no specific renderer
  }
};

const assertCondition = (kind: ExpressionKind): void => {
  if (kind !== 'unknown' && kind !== 'boolean') {
    throw new KindMismatch(
      `Condition must be a comparison or boolean field, got ${kind}`,
    );
  }
};

const comparisonKind = (
  operator: '=' | '!=' | '<' | '<=' | '>' | '>=',
  left: ExpressionKind,
  right: ExpressionKind,
): ExpressionKind => {
  if (left === 'unknown' || right === 'unknown') return 'boolean';
  if (!kindsMatch(left, right)) {
    throw new KindMismatch(
      `Cannot compare ${left} with ${right} using "${operator}" (kinds must match)`,
    );
  }
  if (operator === '=' || operator === '!=') return 'boolean';
  // Kinds are equal here (kindsMatch passed); "unequal kinds" already threw
  // above, so this is the "equal but outside the ordered set" branch (S8's
  // regression case is caught by the unequal-kinds branch instead).
  if (!ORDERED_KINDS.has(left)) {
    throw new KindMismatch(`Cannot order ${left} values with "${operator}"`);
  }
  return 'boolean';
};

const binaryKind = (
  operator: '+' | '-' | '*' | '/' | '%',
  left: ExpressionKind,
  right: ExpressionKind,
): ExpressionKind => {
  if (left === 'unknown' || right === 'unknown') return 'unknown';
  const mismatch = (): never => {
    throw new KindMismatch(
      `Cannot apply "${operator}" to ${left} and ${right}`,
    );
  };
  if (operator === '+') {
    if (left === 'number' && right === 'number') return 'number';
    if (
      (left === 'date' && right === 'number') ||
      (left === 'number' && right === 'date')
    )
      return 'date';
    if (
      (left === 'datetime' && right === 'number') ||
      (left === 'number' && right === 'datetime')
    )
      return 'datetime';
    return mismatch();
  }
  if (operator === '-') {
    if (left === 'number' && right === 'number') return 'number';
    if (left === 'date' && right === 'number') return 'date';
    if (left === 'datetime' && right === 'number') return 'datetime';
    if (left === 'date' && right === 'date') return 'number';
    if (left === 'datetime' && right === 'datetime') return 'number';
    return mismatch();
  }
  // '*', '/', '%': strictly numeric.
  if (left === 'number' && right === 'number') return 'number';
  return mismatch();
};

// The kind of a possibly-opaque cast operand, so TEXT()'s rejection can name
// the RAW field type instead of the bucket label 'opaque' (the generic
// mismatch paths below hold only a kind, never the originating field type).
const rawFieldTypeOfNode = (
  node: AstNode,
  hostObject: string,
  fieldKinds?: KindLookup,
): string | undefined => {
  if (node.type === 'field') return rawFieldType(hostObject, node.path, fieldKinds);
  if (node.type === 'crossref') {
    return rawFieldType(node.ref.object, node.ref.fieldPath, fieldKinds);
  }
  return undefined;
};

// Walks the AST: returns the expression's kind, or the first mismatch as
// `error`. SIDE EFFECT: stamps `renderAs` on every TextCastNode from its
// operand's kind.
export const inferExpressionKind = (
  ast: AstNode,
  hostObject: string,
  fieldKinds?: KindLookup,
): KindInferenceResult => {
  const walk = (node: AstNode): ExpressionKind => {
    switch (node.type) {
      case 'number':
        return 'number';
      case 'null':
        return 'unknown';
      case 'string':
        return 'text';
      case 'today':
      case 'dateliteral':
        return 'date';

      case 'field':
        return fieldTypeToKind(rawFieldType(hostObject, node.path, fieldKinds));

      case 'crossref':
        return fieldTypeToKind(
          rawFieldType(node.ref.object, node.ref.fieldPath, fieldKinds),
        );

      case 'unary': {
        const kind = walk(node.operand);
        if (kind !== 'unknown' && kind !== 'number') {
          throw new KindMismatch(
            `Cannot apply unary "${node.operator}" to ${kind}`,
          );
        }
        return 'number';
      }

      case 'binary':
        return binaryKind(node.operator, walk(node.left), walk(node.right));

      case 'comparison':
        return comparisonKind(node.operator, walk(node.left), walk(node.right));

      case 'concat':
        for (const part of node.parts) {
          const kind = walk(part);
          if (kind !== 'unknown' && kind !== 'text') {
            throw new KindMismatch(
              `"&" joins text; wrap ${kind} values in TEXT()`,
            );
          }
        }
        return 'text';

      case 'if': {
        assertCondition(walk(node.condition));
        return unify(walk(node.then), walk(node.else));
      }

      case 'ifblank':
        return unify(walk(node.value), walk(node.fallback));

      case 'sum':
        for (const arg of node.args) {
          const kind = walk(arg);
          if (kind !== 'unknown' && kind !== 'number') {
            throw new KindMismatch(`SUM args must be number, got ${kind}`);
          }
        }
        return 'number';

      case 'and':
      case 'or':
        for (const arg of node.args) {
          assertCondition(walk(arg));
        }
        return 'boolean';

      case 'not':
        assertCondition(walk(node.operand));
        return 'boolean';

      // ISBLANK's operand is a VALUE node (blankness is observed, not
      // propagated), so it carries no kind constraint — just walk it for
      // nested renderAs stamping / error propagation and discard the kind.
      case 'isblank':
        walk(node.operand);
        return 'boolean';

      case 'numbercast': {
        const kind = walk(node.operand);
        if (kind !== 'unknown' && kind !== 'text') {
          throw new KindMismatch(`NUMBER() takes text, got ${kind}`);
        }
        return 'number';
      }

      case 'textcast': {
        const operandKind = walk(node.operand);
        if (operandKind === 'opaque') {
          const fieldType =
            rawFieldTypeOfNode(node.operand, hostObject, fieldKinds) ??
            'unsupported';
          throw new KindMismatch(`TEXT() cannot render a ${fieldType} field`);
        }
        node.renderAs = renderKindOf(operandKind);
        return 'text';
      }
    }
  };

  try {
    return { kind: walk(ast), error: null };
  } catch (error) {
    if (error instanceof KindMismatch) {
      return { kind: null, error: error.message };
    }
    throw error;
  }
};

const EXPECTED_KIND_BY_TARGET: Record<TargetFieldKind, ExpressionKind> = {
  NUMBER: 'number',
  CURRENCY: 'number',
  DATE: 'date',
  DATE_TIME: 'datetime',
  TEXT: 'text',
  SELECT: 'text',
};

// Save/sweep gate: inference + output gate against the target kind. Returns
// null when the definition passes (or is mirror-lane / undecidable).
export const strictKindGateError = (args: {
  ast: AstNode;
  hostObject: string;
  targetFieldType: string | null | undefined;
  fieldKinds?: KindLookup;
}): string | null => {
  const { ast, hostObject, targetFieldType, fieldKinds } = args;

  // Blank/non-family targets are mirror lane or nobody's business (branch
  // 1c's territory) — deliberately NOT identical to 1c: skip, never reject.
  if (
    targetFieldType == null ||
    targetFieldType === '' ||
    !ENGINE_FAMILY_KINDS.has(targetFieldType)
  ) {
    return null;
  }

  const result = inferExpressionKind(ast, hostObject, fieldKinds);
  if (result.error !== null) return result.error;

  // Undecidable inference (no metadata reached) is skip-never-reject, same as
  // every other constraint in this module. An 'opaque' result, by contrast,
  // is a known kind that never matches an engine-family target (1d parity).
  const expected = EXPECTED_KIND_BY_TARGET[targetFieldKind(targetFieldType)];
  if (result.kind === 'unknown' || result.kind === expected) return null;

  const suggestion =
    expected === 'text' ? ' Wrap it in TEXT(...) to fix this.' : '';
  return `Formula computes ${result.kind} but the target field holds ${expected}${suggestion}`;
};

// A SELECT field option as the gates consume it: the stored value plus the
// display label. Labels feed the did-you-mean hint only — matching is always
// by value, case-sensitively, like every other string comparison in the
// language (ADR 0029 D6).
export type SelectOption = { value: string; label: string };

// The per-pass / per-event resolved option set: the ordered list for messages
// plus a value Set for O(1) membership at the write boundary. Built once by
// each hoist point, never per record. Null input or an empty list is
// "unresolvable" (the platform guarantees a real SELECT field has at least one
// option), so gates skip rather than reject (ADR 0027 posture).
export type TargetSelectOptions = {
  list: ReadonlyArray<SelectOption>;
  values: ReadonlySet<string>;
};

export const buildTargetSelectOptions = (
  list: ReadonlyArray<SelectOption> | null | undefined,
): TargetSelectOptions | null =>
  list == null || list.length === 0
    ? null
    : { list, values: new Set(list.map((option) => option.value)) };

const MEMBERSHIP_MESSAGE_OPTION_LIMIT = 6;

const membershipGateMessage = (
  literal: string,
  targetOptions: TargetSelectOptions,
): string => {
  const values = targetOptions.list.map((option) => option.value);
  const shown =
    values.slice(0, MEMBERSHIP_MESSAGE_OPTION_LIMIT).join(', ') +
    (values.length > MEMBERSHIP_MESSAGE_OPTION_LIMIT ? ', …' : '');
  // The label-vs-value trap: users think in labels, the platform forces
  // UPPER_SNAKE values. A case-insensitive value/label match names the value
  // the user almost certainly meant.
  const lower = literal.toLowerCase();
  const nearMiss = targetOptions.list.find(
    (option) =>
      option.value.toLowerCase() === lower ||
      option.label.toLowerCase() === lower,
  );
  const hint = nearMiss ? ` Did you mean "${nearMiss.value}"?` : '';
  return `Formula can produce "${literal}", which is not an option of the target field (options: ${shown})${hint}`;
};

// SELECT membership gate, static tier (ADR 0029 D3): when the formula's text
// outputs form a closed literal set, every non-blank literal must name a
// defined option value. Open sets pass (the per-record check owns them); an
// unresolvable option set skips, never rejects. Blank literals are legal —
// they normalize to null and clear the field (D4). Runs after the kind gate,
// so the tree is already text-kind at the root.
export const selectMembershipGateError = (args: {
  ast: AstNode;
  targetFieldType: string | null | undefined;
  targetOptions: TargetSelectOptions | null | undefined;
}): string | null => {
  const { ast, targetFieldType, targetOptions } = args;
  if (targetFieldType !== 'SELECT' || targetOptions == null) {
    return null;
  }
  const outputs = staticTextOutputs(ast);
  if (outputs === null) {
    return null;
  }
  for (const literal of outputs) {
    if (literal.trim() === '') {
      continue;
    }
    if (!targetOptions.values.has(literal)) {
      return membershipGateMessage(literal, targetOptions);
    }
  }
  return null;
};
