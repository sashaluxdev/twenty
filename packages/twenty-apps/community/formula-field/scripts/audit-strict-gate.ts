// Pre-deploy blast-radius audit (strict-typing arc, Task 8): for every
// ENABLED formula definition on a remote, reports whether it would pass
// strictKindGateError — the same gate recompute.ts applies at sweep/save
// time — WITHOUT writing or evaluating anything. Read-only: no mutation
// call exists anywhere in this script.
//
// Usage: npx tsx scripts/audit-strict-gate.ts <remoteName>
// Reads apiUrl + apiKey for <remoteName> from ~/.twenty/config.json via the
// shared scripts/lib/remote-client.ts (same source the integration setup uses
// — src/__tests__/setup-test.ts).
import {
  createThrottledFetchTransport,
  loadRemote,
} from './lib/remote-client';

const USAGE = 'Usage: npx tsx scripts/audit-strict-gate.ts <remoteName>';

type AuditRow = {
  id: string;
  name: string;
  target: string;
  verdict: string;
};

// Fixed-width columns so the table reads cleanly in a terminal without
// pulling in a table-formatting dependency for one script.
const printTable = (rows: AuditRow[]): void => {
  const headers = ['id', 'name', 'target', 'verdict'];
  const widths = headers.map((header, index) =>
    Math.max(
      header.length,
      ...rows.map((row) => String(Object.values(row)[index]).length),
    ),
  );
  const printRow = (cells: string[]): void => {
    console.log(cells.map((cell, index) => cell.padEnd(widths[index])).join(' | '));
  };
  printRow(headers);
  printRow(widths.map((width) => '-'.repeat(width)));
  for (const row of rows) {
    printRow([row.id, row.name, row.target, row.verdict]);
  }
};

const run = async () => {
  const remote = loadRemote(process.argv[2], USAGE);

  // Import AFTER env is set so client construction sees the remote.
  const { createDynamicCoreClient } = await import(
    '../src/logic-functions/lib/dynamic-client'
  );
  const { loadAllEnabledFormulas } = await import(
    '../src/logic-functions/lib/formula-repository'
  );
  const { compileFormula, isFormulaError } = await import('../src/engine');
  const { strictKindGateError, selectMembershipGateError, buildTargetSelectOptions } = await import(
    '../src/logic-functions/lib/kind-inference'
  );
  const { resolveKindsForFormula } = await import(
    '../src/logic-functions/lib/recompute'
  );
  const { targetFieldOptions } = await import(
    '../src/logic-functions/lib/metadata-objects'
  );

  // Own throttled transport: the generated CoreApiClient exists only after
  // `twenty dev`/`app:install` for this remote, and nothing else in the stack
  // holds the audit's reads under the API's rate limit.
  const client = createDynamicCoreClient(
    createThrottledFetchTransport(remote),
  );
  const formulas = await loadAllEnabledFormulas(client);

  const rows: AuditRow[] = [];
  const summary = { pass: 0, gated: 0, parse: 0 };

  for (const formula of formulas) {
    const target = `${formula.targetObject ?? ''}.${formula.targetField ?? ''}`;
    const name = formula.name ?? '';

    let compiled;
    try {
      compiled = compileFormula(formula.expression ?? '');
    } catch (error) {
      summary.parse += 1;
      rows.push({
        id: formula.id,
        name,
        target,
        verdict: `PARSE: ${isFormulaError(error) ? error.message : String(error)}`,
      });
      continue;
    }

    // Same resolution path recompute.ts's static gate uses (Task 2/6): the
    // host object plus every cross-referenced object, via the client's
    // metadata-backed fieldKinds resolver.
    const fieldKindsByObject = await resolveKindsForFormula(
      client,
      formula,
      compiled,
    );
    const gateError = strictKindGateError({
      ast: compiled.ast,
      hostObject: formula.targetObject ?? '',
      targetFieldType: formula.targetFieldType,
      fieldKinds: (objectName) => fieldKindsByObject.get(objectName),
    });

    let verdictError = gateError;
    if (verdictError === null && formula.targetFieldType === 'SELECT') {
      // Same two-tier source of truth the recompute pass uses (ADR 0029 D3).
      verdictError = selectMembershipGateError({
        ast: compiled.ast,
        targetFieldType: formula.targetFieldType,
        targetOptions: buildTargetSelectOptions(
          await targetFieldOptions(
            formula.targetObject ?? '',
            formula.targetField ?? '',
          ),
        ),
      });
    }

    if (verdictError === null) {
      summary.pass += 1;
      rows.push({ id: formula.id, name, target, verdict: 'PASS' });
    } else {
      summary.gated += 1;
      rows.push({ id: formula.id, name, target, verdict: `GATED: ${verdictError}` });
    }
  }

  printTable(rows);
  console.log(
    `\nTotal: ${formulas.length}  PASS: ${summary.pass}  GATED: ${summary.gated}  PARSE: ${summary.parse}`,
  );
};

// Reports; never judges — exit 0 even when definitions are GATED or fail to
// parse. Only an unexpected script-level error (bad config, unreachable
// remote) exits non-zero.
run().catch((error) => {
  console.error(error);
  process.exit(1);
});
