// Pre-deploy blast-radius audit (strict-typing arc, Task 8): for every
// ENABLED formula definition on a remote, reports whether it would pass
// strictKindGateError — the same gate recompute.ts applies at sweep/save
// time — WITHOUT writing or evaluating anything. Read-only: no mutation
// call exists anywhere in this script.
//
// Usage: npx tsx scripts/audit-strict-gate.ts <remoteName>
// Reads apiUrl + apiKey for <remoteName> from ~/.twenty/config.json (same
// source the integration setup uses — src/__tests__/setup-test.ts — and the
// pattern scripts/retro-purge-timeline.ts follows).
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const remoteName = process.argv[2];
if (!remoteName) {
  console.error('Usage: npx tsx scripts/audit-strict-gate.ts <remoteName>');
  process.exit(1);
}
const config = JSON.parse(
  fs.readFileSync(path.join(os.homedir(), '.twenty', 'config.json'), 'utf8'),
);
const remote = config.remotes?.[remoteName];
if (!remote?.apiUrl || !remote?.apiKey) {
  console.error(
    `Remote "${remoteName}" with apiUrl+apiKey not found in ~/.twenty/config.json`,
  );
  process.exit(1);
}
// SDK clients (CoreApiClient, via createDynamicCoreClient) read these env vars
// — same bridge as setup-test.ts / the deployed logic function's runtime.
process.env.TWENTY_API_URL = remote.apiUrl;
process.env.TWENTY_API_KEY = remote.apiKey;
process.env.TWENTY_APP_ACCESS_TOKEN ??= remote.apiKey;

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
  // Import AFTER env is set so client construction sees the remote.
  const { createDynamicCoreClient } = await import(
    '../src/logic-functions/lib/dynamic-client'
  );
  const { loadAllEnabledFormulas } = await import(
    '../src/logic-functions/lib/formula-repository'
  );
  const { compileFormula, isFormulaError } = await import('../src/engine');
  const { strictKindGateError } = await import(
    '../src/logic-functions/lib/kind-inference'
  );
  const { resolveKindsForFormula } = await import(
    '../src/logic-functions/lib/recompute'
  );

  const client = createDynamicCoreClient();
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

    if (gateError === null) {
      summary.pass += 1;
      rows.push({ id: formula.id, name, target, verdict: 'PASS' });
    } else {
      summary.gated += 1;
      rows.push({ id: formula.id, name, target, verdict: `GATED: ${gateError}` });
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
