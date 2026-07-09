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
  }
};

// The refs that appear as the non-literal operand of a STRING-MODE comparison
// (one where either operand is a string literal — the parser confines string
// literals to = / != operands). These are the fields whose runtime value is
// compared as a string, so save-time validation can reject a comparison against
// a field kind that can never hold a string (only SELECT / TEXT are supported).
export type StringComparisonRefs = {
  sameRecordPaths: string[];
  crossRefs: CrossRefValue[];
};

// A direct field / cross-record operand of a string comparison contributes a
// kind constraint; anything else (a string literal, a nested arithmetic
// expression, another IF) resolves to null in string mode at runtime, so it
// carries no constraint and is skipped.
const collectStringOperand = (
  node: AstNode,
  sameRecordPaths: Set<string>,
  crossRefs: Map<string, CrossRefValue>,
): void => {
  if (node.type === 'field') {
    sameRecordPaths.add(node.path);
    return;
  }
  if (node.type === 'crossref') {
    const ref = node.ref;
    const key = `${ref.object}:${ref.recordId}:${ref.fieldPath}`;
    if (!crossRefs.has(key)) {
      crossRefs.set(key, ref);
    }
  }
};

const walkStringComparisons = (
  node: AstNode,
  sameRecordPaths: Set<string>,
  crossRefs: Map<string, CrossRefValue>,
): void => {
  switch (node.type) {
    case 'number':
    case 'null':
    case 'string':
    case 'today':
    case 'field':
    case 'crossref':
      return;

    case 'unary':
      walkStringComparisons(node.operand, sameRecordPaths, crossRefs);
      return;

    case 'binary':
      walkStringComparisons(node.left, sameRecordPaths, crossRefs);
      walkStringComparisons(node.right, sameRecordPaths, crossRefs);
      return;

    case 'comparison':
      // String mode iff either operand is a string literal — collect the
      // non-literal operand(s) that are a direct field / crossref.
      if (node.left.type === 'string' || node.right.type === 'string') {
        collectStringOperand(node.left, sameRecordPaths, crossRefs);
        collectStringOperand(node.right, sameRecordPaths, crossRefs);
      }
      // Recurse regardless, so a string comparison nested inside an operand's
      // sub-IF is still reached.
      walkStringComparisons(node.left, sameRecordPaths, crossRefs);
      walkStringComparisons(node.right, sameRecordPaths, crossRefs);
      return;

    case 'if':
      walkStringComparisons(node.condition, sameRecordPaths, crossRefs);
      walkStringComparisons(node.then, sameRecordPaths, crossRefs);
      walkStringComparisons(node.else, sameRecordPaths, crossRefs);
      return;

    // Recurse into every argument so a string comparison nested inside a SUM
    // operand's sub-IF is still reached (SUM args are value context, so a bare
    // string comparison cannot appear directly, but a nested IF can carry one).
    case 'sum':
      for (const arg of node.args) {
        walkStringComparisons(arg, sameRecordPaths, crossRefs);
      }
      return;

    // ADR 0017: AND/OR/NOT arguments ARE conditions and can directly be string
    // comparisons (`AND(stage = "won", ...)`), so recursing here is what lets
    // save-time field-kind validation reach them. ISBLANK/IFBLANK operands are
    // value context (a nested IF could still carry a string comparison).
    case 'and':
    case 'or':
      for (const arg of node.args) {
        walkStringComparisons(arg, sameRecordPaths, crossRefs);
      }
      return;

    case 'not':
    case 'isblank':
      walkStringComparisons(node.operand, sameRecordPaths, crossRefs);
      return;

    case 'ifblank':
      walkStringComparisons(node.value, sameRecordPaths, crossRefs);
      walkStringComparisons(node.fallback, sameRecordPaths, crossRefs);
      return;
  }
};

export const collectStringComparisonRefs = (
  node: AstNode,
): StringComparisonRefs => {
  const sameRecordPaths = new Set<string>();
  const crossRefs = new Map<string, CrossRefValue>();

  walkStringComparisons(node, sameRecordPaths, crossRefs);

  return {
    sameRecordPaths: Array.from(sameRecordPaths).sort(),
    crossRefs: Array.from(crossRefs.values()).sort((a, b) =>
      `${a.object}:${a.recordId}:${a.fieldPath}`.localeCompare(
        `${b.object}:${b.recordId}:${b.fieldPath}`,
      ),
    ),
  };
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
