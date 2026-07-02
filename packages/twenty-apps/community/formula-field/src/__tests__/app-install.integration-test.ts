import * as fs from 'fs';
import * as path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MetadataApiClient } from 'twenty-client-sdk/metadata';
import { appBuild, appDeploy, appInstall, appUninstall } from 'twenty-sdk/cli';

import { APPLICATION_UNIVERSAL_IDENTIFIER } from 'src/application-config';

// End-to-end integration test: install the app on the live local workspace, then
// exercise the acceptance criteria (provisioning, recompute on edit, cross-object
// recompute, cycle rejection), then uninstall cleanly. Requires a running server
// and a configured local remote (see setup-test.ts / context.md runbook).
//
// Record CRUD goes through raw fetch rather than CoreApiClient: the typed core
// client is generated from the app's schema and is bound to its un-generated
// stub at import time (before appBuild regenerates it in beforeAll). fetch has no
// such lifecycle coupling. MetadataApiClient is schema-stable and used as-is.

const APP_PATH = process.cwd();

const gql = async (query: string, variables: Record<string, unknown> = {}) => {
  const response = await fetch(`${process.env.TWENTY_API_URL}/graphql`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.TWENTY_API_KEY}`,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await response.json();
  if (json.errors) {
    throw new Error(JSON.stringify(json.errors));
  }
  return json.data;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Deletes every FormulaDefinition for test isolation. Record data can outlive an
// uninstall/reinstall cycle, so each test starts from a clean formula set.
const deleteAllFormulas = async () => {
  const data = await gql(
    `query{ formulaDefinitions(first: 200){ edges { node { id } } } }`,
  );
  for (const edge of data.formulaDefinitions.edges) {
    await gql(`mutation($id: UUID!){ deleteFormulaDefinition(id: $id){ id } }`, {
      id: edge.node.id,
    });
  }
};

const waitForValue = async <T>(
  read: () => Promise<T>,
  expected: T,
  timeoutMs = 25000,
): Promise<T> => {
  const start = Date.now();
  let last: T = await read();
  while (Date.now() - start < timeoutMs) {
    last = await read();
    if (last === expected) return last;
    await sleep(1500);
  }
  return last;
};

// The registry rejects re-deploying an already-deployed version, so bump the
// patch to a monotonic value (ms timestamp) for each run and restore the file
// afterwards. package.json version is only used for the deploy handshake.
const PACKAGE_JSON = path.join(APP_PATH, 'package.json');
let originalPackageJson = '';

const bumpVersionForDeploy = () => {
  originalPackageJson = fs.readFileSync(PACKAGE_JSON, 'utf8');
  const parsed = JSON.parse(originalPackageJson);
  parsed.version = `0.1.${Date.now()}`;
  fs.writeFileSync(PACKAGE_JSON, `${JSON.stringify(parsed, null, 2)}\n`);
};

const restoreVersion = () => {
  if (originalPackageJson) {
    fs.writeFileSync(PACKAGE_JSON, originalPackageJson);
  }
};

describe('Formula Field app', () => {
  beforeAll(async () => {
    bumpVersionForDeploy();
    const build = await appBuild({ appPath: APP_PATH, tarball: true });
    if (!build.success) {
      throw new Error(`Build failed: ${build.error?.message ?? 'unknown'}`);
    }
    const deploy = await appDeploy({ tarballPath: build.data.tarballPath! });
    if (!deploy.success) {
      throw new Error(`Deploy failed: ${deploy.error?.message ?? 'unknown'}`);
    }
    const install = await appInstall({ appPath: APP_PATH });
    restoreVersion();
    if (!install.success) {
      throw new Error(`Install failed: ${install.error?.message ?? 'unknown'}`);
    }
    await sleep(3000); // let post-install seed the demo formula
  }, 180000);

  afterAll(async () => {
    restoreVersion();
    const uninstall = await appUninstall({ appPath: APP_PATH });
    if (!uninstall.success) {
      console.warn(`Uninstall failed: ${uninstall.error?.message ?? 'unknown'}`);
    }
  }, 60000);

  // Clean formula set before each test for isolation (see deleteAllFormulas).
  beforeEach(async () => {
    await deleteAllFormulas();
  });

  it('criterion 1: provisions the application on install', async () => {
    const metadata = new MetadataApiClient();
    const apps = await metadata.query({
      findManyApplications: { id: true, universalIdentifier: true },
    });
    const installed = apps.findManyApplications.find(
      (application: { universalIdentifier: string }) =>
        application.universalIdentifier === APPLICATION_UNIVERSAL_IDENTIFIER,
    );
    expect(installed).toBeDefined();
  });

  it('criterion 2 & 4: recomputes a same-record formula on edit; value lives in the value field', async () => {
    // Opportunity first, then the formula — the formula's create-trigger
    // recomputes existing records, so the value populates.
    const created = await gql(
      `mutation($d:OpportunityCreateInput!){ createOpportunity(data:$d){ id } }`,
      { d: { name: `IT same ${Date.now()}`, formulaInputA: 5, formulaInputB: 10 } },
    );
    const oppId = created.createOpportunity.id as string;

    await gql(
      `mutation($d:FormulaDefinitionCreateInput!){ createFormulaDefinition(data:$d){ id } }`,
      {
        d: {
          name: `IT same ${Date.now()}`,
          targetObject: 'opportunity',
          targetField: 'formulaScore',
          expression: 'formulaInputA + formulaInputB * 2',
          enabled: true,
        },
      },
    );

    const readScore = async () => {
      const data = await gql(
        `query($id:UUID!){ opportunity(filter:{id:{eq:$id}}){ formulaScore } }`,
        { id: oppId },
      );
      return data.opportunity?.formulaScore ?? null;
    };

    // Demo formula formulaInputA + formulaInputB * 2 = 5 + 20 = 25.
    expect(await waitForValue(readScore, 25)).toBe(25);

    await gql(
      `mutation($id:UUID!,$d:OpportunityUpdateInput!){ updateOpportunity(id:$id,data:$d){ id } }`,
      { id: oppId, d: { formulaInputA: 7 } },
    );
    // Edit an input -> recompute: 7 + 20 = 27.
    expect(await waitForValue(readScore, 27)).toBe(27);
  }, 90000);

  it('criterion 3: recomputes a cross-object formula when the referenced record changes', async () => {
    const stamp = Date.now();
    const company = await gql(
      `mutation($d:CompanyCreateInput!){ createCompany(data:$d){ id } }`,
      { d: { name: `IT co ${stamp}`, employees: 100 } },
    );
    const companyId = company.createCompany.id as string;

    const opp = await gql(
      `mutation($d:OpportunityCreateInput!){ createOpportunity(data:$d){ id } }`,
      { d: { name: `IT cross ${stamp}`, formulaInputA: 5 } },
    );
    const oppId = opp.createOpportunity.id as string;

    await gql(
      `mutation($d:FormulaDefinitionCreateInput!){ createFormulaDefinition(data:$d){ id } }`,
      {
        d: {
          name: `IT cross ${stamp}`,
          targetObject: 'opportunity',
          targetField: 'formulaCrossScore',
          expression: `formulaInputA + [company:${companyId}:employees]`,
          enabled: true,
        },
      },
    );

    const readCross = async () => {
      const data = await gql(
        `query($id:UUID!){ opportunity(filter:{id:{eq:$id}}){ formulaCrossScore } }`,
        { id: oppId },
      );
      return data.opportunity?.formulaCrossScore ?? null;
    };

    // 5 + 100 = 105 after formula creation.
    expect(await waitForValue(readCross, 105)).toBe(105);

    await gql(
      `mutation($id:UUID!,$d:CompanyUpdateInput!){ updateCompany(id:$id,data:$d){ id } }`,
      { id: companyId, d: { employees: 200 } },
    );
    // Cross-object recompute when the company changes: 5 + 200 = 205.
    expect(await waitForValue(readCross, 205)).toBe(205);
  }, 90000);

  it('criterion 5: rejects a formula that creates a dependency cycle', async () => {
    const stamp = Date.now();
    await gql(
      `mutation($d:FormulaDefinitionCreateInput!){ createFormulaDefinition(data:$d){ id } }`,
      {
        d: {
          name: `IT cyc a ${stamp}`,
          targetObject: 'opportunity',
          targetField: 'formulaScore',
          expression: 'formulaCrossScore + 1',
          enabled: true,
        },
      },
    );
    // Let the first formula settle (validated as acyclic) before adding the one
    // that closes the cycle — criterion 5 is about saving a formula that CREATES
    // a cycle against an established set.
    await sleep(4000);
    const bResult = await gql(
      `mutation($d:FormulaDefinitionCreateInput!){ createFormulaDefinition(data:$d){ id } }`,
      {
        d: {
          name: `IT cyc b ${stamp}`,
          targetObject: 'opportunity',
          targetField: 'formulaCrossScore',
          expression: 'formulaScore + 1',
          enabled: true,
        },
      },
    );
    const bId = bResult.createFormulaDefinition.id as string;

    const readB = async () => {
      const data = await gql(
        `query($id:UUID!){ formulaDefinition(filter:{id:{eq:$id}}){ enabled lastError } }`,
        { id: bId },
      );
      return data.formulaDefinition;
    };

    const start = Date.now();
    let record = await readB();
    while (Date.now() - start < 25000) {
      record = await readB();
      if (record?.enabled === false && /cycle/i.test(record?.lastError ?? '')) {
        break;
      }
      await sleep(1500);
    }
    expect(record?.enabled).toBe(false);
    expect(record?.lastError ?? '').toMatch(/cycle/i);
  }, 90000);
});
