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

    // A string literal is inert data (only ever an = / != operand); it reads no
    // field, so it contributes no dependency.
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

    // Deliberately EAGER, unlike evaluation (lazy): the taken branch can flip
    // when inputs change, so a formula depends on the condition AND BOTH
    // branches. Cycle detection inherits this conservative bias unchanged.
    case 'if':
      walk(node.condition, sameRecordFields, crossRecordRefs);
      walk(node.then, sameRecordFields, crossRecordRefs);
      walk(node.else, sameRecordFields, crossRecordRefs);
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

    // Same eager bias as dependency extraction: either branch can determine
    // staleness once its condition takes it, so OR across all three.
    case 'if':
      return (
        usesToday(node.condition) || usesToday(node.then) || usesToday(node.else)
      );
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
