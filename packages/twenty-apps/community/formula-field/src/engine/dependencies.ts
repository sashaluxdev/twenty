import { type AstNode } from 'src/engine/ast';
import { parse } from 'src/engine/parser';
import { type CrossRefValue } from 'src/engine/tokenizer';

// Static dependency extraction. Walking the AST collects every variable the
// formula reads, split into:
//   - sameRecordFields: field names on the target object's own record. Only the
//     ROOT segment matters for dependency tracking (e.g. "amount.amountMicros"
//     depends on the field "amount"), because a database update event reports
//     changes at field granularity.
//   - crossRecordRefs: (object, recordId, field) triples on other records.
//
// The extracted set is persisted on FormulaDefinition.dependencies at save time
// so recompute triggers can decide, without re-parsing, whether an update event
// touches a field this formula reads.

export type CrossRecordDependency = {
  object: string;
  recordId: string;
  // Root field name (first path segment).
  field: string;
  // Full dotted path as written.
  fieldPath: string;
};

export type FormulaDependencies = {
  sameRecordFields: string[];
  crossRecordRefs: CrossRecordDependency[];
};

const rootSegment = (path: string): string => path.split('.')[0];

const walk = (
  node: AstNode,
  sameRecordFields: Set<string>,
  crossRecordRefs: Map<string, CrossRecordDependency>,
): void => {
  switch (node.type) {
    case 'number':
      return;

    // ADR 0018: the synthetic else of a default-less IFS/SWITCH desugar. Reads
    // no field, so it contributes no dependency.
    case 'null':
      return;

    // A string literal is inert data; it reads no field, so it contributes no
    // dependency.
    case 'string':
      return;

    // TODAY() names no field — it is fed by the caller at evaluation time
    // (ADR 0012), so it contributes no dependency and needs no cycle edge.
    case 'today':
      return;

    case 'field':
      sameRecordFields.add(rootSegment(node.path));
      return;

    case 'crossref': {
      const ref: CrossRefValue = node.ref;
      const field = rootSegment(ref.fieldPath);
      const key = `${ref.object}:${ref.recordId}:${field}`;
      if (!crossRecordRefs.has(key)) {
        crossRecordRefs.set(key, {
          object: ref.object,
          recordId: ref.recordId,
          field,
          fieldPath: ref.fieldPath,
        });
      }
      return;
    }

    case 'unary':
      walk(node.operand, sameRecordFields, crossRecordRefs);
      return;

    case 'binary':
      walk(node.left, sameRecordFields, crossRecordRefs);
      walk(node.right, sameRecordFields, crossRecordRefs);
      return;

    case 'comparison':
      walk(node.left, sameRecordFields, crossRecordRefs);
      walk(node.right, sameRecordFields, crossRecordRefs);
      return;

    // Every operand contributes to the concatenated text, so all of them are
    // dependencies.
    case 'concat':
      for (const part of node.parts) {
        walk(part, sameRecordFields, crossRecordRefs);
      }
      return;

    // Deliberately EAGER, unlike evaluation (lazy): the taken branch can flip
    // when inputs change, so a formula depends on the condition AND BOTH
    // branches. Cycle detection inherits this conservative bias unchanged.
    case 'if':
      walk(node.condition, sameRecordFields, crossRecordRefs);
      walk(node.then, sameRecordFields, crossRecordRefs);
      walk(node.else, sameRecordFields, crossRecordRefs);
      return;

    // Eager union over every argument (ADR 0016), mirroring IF: a change to any
    // argument can change the sum, so a SUM formula depends on all of them.
    case 'sum':
      for (const arg of node.args) {
        walk(arg, sameRecordFields, crossRecordRefs);
      }
      return;

    // ADR 0017 combinators: union every argument. AND/OR over all args; NOT and
    // ISBLANK over their single operand. ISBLANK's operand IS a real dependency
    // — recompute must fire when the observed field flips between blank and set.
    case 'and':
    case 'or':
      for (const arg of node.args) {
        walk(arg, sameRecordFields, crossRecordRefs);
      }
      return;

    case 'not':
    case 'isblank':
      walk(node.operand, sameRecordFields, crossRecordRefs);
      return;

    // IFBLANK depends on both the value and its fallback (either can determine
    // the result), mirroring IF's eager extraction across branches.
    case 'ifblank':
      walk(node.value, sameRecordFields, crossRecordRefs);
      walk(node.fallback, sameRecordFields, crossRecordRefs);
      return;

    // DATE("YYYY-MM-DD") is a parse-time constant — it reads no field.
    case 'dateliteral':
      return;

    // NUMBER(x) / TEXT(x) depend on whatever their operand depends on.
    case 'numbercast':
    case 'textcast':
      walk(node.operand, sameRecordFields, crossRecordRefs);
      return;
  }
};

// True if the expression reads TODAY() anywhere — condition, either IF branch,
// or nested under arithmetic. Mirrors the walk() switch above case-for-case,
// but returns a boolean (OR of children) instead of collecting fields, since
// staleness detection (ADR 0015) needs to know THAT a formula depends on the
// system clock, not which fields it also reads.
export const usesToday = (node: AstNode): boolean => {
  switch (node.type) {
    case 'number':
      return false;

    // ADR 0018: synthetic IFS/SWITCH else — no TODAY() inside it.
    case 'null':
      return false;

    case 'string':
      return false;

    case 'today':
      return true;

    case 'field':
      return false;

    case 'crossref':
      return false;

    case 'unary':
      return usesToday(node.operand);

    case 'binary':
      return usesToday(node.left) || usesToday(node.right);

    case 'comparison':
      return usesToday(node.left) || usesToday(node.right);

    case 'concat':
      return node.parts.some((part) => usesToday(part));

    // Same eager bias as dependency extraction: either branch can determine
    // staleness once its condition takes it, so OR across all three.
    case 'if':
      return (
        usesToday(node.condition) || usesToday(node.then) || usesToday(node.else)
      );

    // OR across every argument — a TODAY() buried in any SUM operand still makes
    // the whole formula clock-dependent for staleness detection (ADR 0015).
    case 'sum':
      return node.args.some((arg) => usesToday(arg));

    // ADR 0017: OR across every argument, same eager bias as SUM/IF.
    case 'and':
    case 'or':
      return node.args.some((arg) => usesToday(arg));

    case 'not':
    case 'isblank':
      return usesToday(node.operand);

    case 'ifblank':
      return usesToday(node.value) || usesToday(node.fallback);

    // DATE("YYYY-MM-DD") is a parse-time constant — never clock-dependent.
    case 'dateliteral':
      return false;

    // NUMBER(x) / TEXT(x) are clock-dependent iff their operand is.
    case 'numbercast':
    case 'textcast':
      return usesToday(node.operand);
  }
};

export const extractDependenciesFromAst = (
  node: AstNode,
): FormulaDependencies => {
  const sameRecordFields = new Set<string>();
  const crossRecordRefs = new Map<string, CrossRecordDependency>();

  walk(node, sameRecordFields, crossRecordRefs);

  return {
    sameRecordFields: Array.from(sameRecordFields).sort(),
    crossRecordRefs: Array.from(crossRecordRefs.values()).sort((a, b) =>
      `${a.object}:${a.recordId}:${a.field}`.localeCompare(
        `${b.object}:${b.recordId}:${b.field}`,
      ),
    ),
  };
};

export const extractDependencies = (source: string): FormulaDependencies =>
  extractDependenciesFromAst(parse(source));

// A whole-field reference the entire expression reduces to — the sole shape a
// mirror definition may take (design 2026-07-06). Kept engine-side (pure, no
// target-kind knowledge) so both the mirror detector and the save-time validator
// build on one source of truth.
export type BareReference =
  | { kind: 'same'; field: string }
  | { kind: 'cross'; ref: CrossRefValue };

// Non-null iff the ENTIRE AST is a single whole-field reference: a same-record
// field with no dotted subpath (`status`, not `amount.amountMicros`) or a
// cross-record ref to a whole field. Any operator, function, literal, IF, or
// subpath yields null (it is an engine expression, not a mirror). Pure.
export const bareReferenceOf = (node: AstNode): BareReference | null => {
  if (node.type === 'field') {
    return node.path.includes('.') ? null : { kind: 'same', field: node.path };
  }
  if (node.type === 'crossref') {
    return node.ref.fieldPath.includes('.')
      ? null
      : { kind: 'cross', ref: node.ref };
  }
  return null;
};
