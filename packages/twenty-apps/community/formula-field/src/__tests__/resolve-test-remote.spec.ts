import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveTestRemote } from 'src/__tests__/resolve-test-remote';

const CLOUD_KEY = 'cloud-api-key-do-not-leak';
const ENV_KEY = 'env-api-key-do-not-leak';
const LOCAL_KEY = 'local-api-key';

const CLOUD_REMOTE = { apiUrl: 'https://acme.twenty.com', apiKey: CLOUD_KEY };
const LOCAL_REMOTE = { apiUrl: 'http://localhost:3000', apiKey: LOCAL_KEY };

let fixtureDirectory = '';

beforeEach(() => {
  fixtureDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'formula-field-test-remote-'),
  );
});

afterEach(() => {
  fs.rmSync(fixtureDirectory, { recursive: true, force: true });
});

const writeConfig = (config: unknown): string => {
  const configPath = path.join(fixtureDirectory, 'config.json');
  fs.writeFileSync(
    configPath,
    typeof config === 'string' ? config : JSON.stringify(config),
  );
  return configPath;
};

const missingConfigPath = (): string =>
  path.join(fixtureDirectory, 'absent-config.json');

const cloudDefaultConfig = () =>
  writeConfig({
    defaultRemote: 'cloud',
    remotes: { cloud: CLOUD_REMOTE, dev: LOCAL_REMOTE },
  });

const thrownMessage = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected resolveTestRemote to throw');
};

describe('resolveTestRemote', () => {
  describe('source selection', () => {
    it('uses the env pair when both TWENTY_API_URL and TWENTY_API_KEY are set', () => {
      const remote = resolveTestRemote({
        env: { TWENTY_API_URL: 'http://localhost:3000', TWENTY_API_KEY: ENV_KEY },
        configPath: cloudDefaultConfig(),
      });

      expect(remote.apiUrl).toBe('http://localhost:3000');
      expect(remote.apiKey).toBe(ENV_KEY);
    });

    it('takes both values from the config default remote when the env key is unset', () => {
      const remote = resolveTestRemote({
        env: { TWENTY_API_URL: 'http://127.0.0.1:4000' },
        configPath: writeConfig({
          defaultRemote: 'dev',
          remotes: { dev: LOCAL_REMOTE },
        }),
      });

      expect(remote).toMatchObject(LOCAL_REMOTE);
    });

    it('takes both values from the config default remote when the env url is unset', () => {
      const remote = resolveTestRemote({
        env: { TWENTY_API_KEY: ENV_KEY },
        configPath: writeConfig({
          defaultRemote: 'dev',
          remotes: { dev: LOCAL_REMOTE },
        }),
      });

      expect(remote).toMatchObject(LOCAL_REMOTE);
    });

    it('treats an empty env key as unset', () => {
      // vitest.integration.config.ts injects TWENTY_API_KEY='' when it is unset.
      const remote = resolveTestRemote({
        env: { TWENTY_API_URL: 'http://127.0.0.1:3000', TWENTY_API_KEY: '' },
        configPath: writeConfig({
          defaultRemote: 'dev',
          remotes: { dev: LOCAL_REMOTE },
        }),
      });

      expect(remote).toMatchObject(LOCAL_REMOTE);
    });

    it('selects the "local" remote when defaultRemote is absent', () => {
      const remote = resolveTestRemote({
        env: {},
        configPath: writeConfig({
          remotes: { local: LOCAL_REMOTE, cloud: CLOUD_REMOTE },
        }),
      });

      expect(remote).toMatchObject(LOCAL_REMOTE);
    });

    it('never pairs the env key with a config remote that has no apiKey', () => {
      expect(() =>
        resolveTestRemote({
          env: { TWENTY_API_KEY: ENV_KEY },
          configPath: writeConfig({
            defaultRemote: 'dev',
            remotes: { dev: { apiUrl: 'http://localhost:3000' } },
          }),
        }),
      ).toThrow(/dev/);
    });

    it('throws when there is no env pair and no config file', () => {
      expect(() =>
        resolveTestRemote({ env: {}, configPath: missingConfigPath() }),
      ).toThrow(/TWENTY_API_URL and TWENTY_API_KEY/);
    });
  });

  describe('loopback guard', () => {
    it.each([
      'http://localhost:3000',
      'http://apple.localhost:3001',
      'http://127.0.0.1:3000',
      'http://127.5.6.7',
      'http://[::1]:3000',
    ])('accepts the loopback url %s', (apiUrl) => {
      const remote = resolveTestRemote({
        env: { TWENTY_API_URL: apiUrl, TWENTY_API_KEY: ENV_KEY },
        configPath: missingConfigPath(),
      });

      expect(remote.apiUrl).toBe(apiUrl);
    });

    it('refuses the cloud defaultRemote from config.json', () => {
      const message = thrownMessage(() =>
        resolveTestRemote({ env: {}, configPath: cloudDefaultConfig() }),
      );

      expect(message).toContain('"cloud"');
      expect(message).toContain('acme.twenty.com');
      expect(message).toContain('TWENTY_API_URL');
      expect(message).toContain('TWENTY_API_KEY');
    });

    it('refuses an https non-local env url', () => {
      const message = thrownMessage(() =>
        resolveTestRemote({
          env: {
            TWENTY_API_URL: 'https://acme.twenty.com',
            TWENTY_API_KEY: ENV_KEY,
          },
          configPath: missingConfigPath(),
        }),
      );

      expect(message).toContain('env');
      expect(message).toContain('acme.twenty.com');
    });

    it('refuses a local env url whose missing key sends the pair to a cloud config remote', () => {
      const message = thrownMessage(() =>
        resolveTestRemote({
          env: { TWENTY_API_URL: 'http://127.0.0.1:3000' },
          configPath: cloudDefaultConfig(),
        }),
      );

      expect(message).toContain('"cloud"');
      expect(message).toContain('acme.twenty.com');
    });

    it.each([
      'http://localhost.example.com',
      'http://127.0.0.1.example.com',
      'http://mylocalhost',
      'http://0.0.0.0:3000',
      'http://[::ffff:127.0.0.1]',
    ])('refuses the lookalike host %s', (apiUrl) => {
      expect(() =>
        resolveTestRemote({
          env: { TWENTY_API_URL: apiUrl, TWENTY_API_KEY: ENV_KEY },
          configPath: missingConfigPath(),
        }),
      ).toThrow(/Refusing/);
    });

    it.each(['not a url', 'localhost:3000'])(
      'refuses the malformed url %j',
      (apiUrl) => {
        expect(() =>
          resolveTestRemote({
            env: { TWENTY_API_URL: apiUrl, TWENTY_API_KEY: ENV_KEY },
            configPath: missingConfigPath(),
          }),
        ).toThrow(/not a valid http\(s\) URL/);
      },
    );
  });

  describe('secret hygiene', () => {
    it('keeps the config api key out of the refusal message', () => {
      const message = thrownMessage(() =>
        resolveTestRemote({ env: {}, configPath: cloudDefaultConfig() }),
      );

      expect(message).not.toContain(CLOUD_KEY);
    });

    it('keeps the env api key out of the refusal message', () => {
      const message = thrownMessage(() =>
        resolveTestRemote({
          env: {
            TWENTY_API_URL: 'https://acme.twenty.com',
            TWENTY_API_KEY: ENV_KEY,
          },
          configPath: missingConfigPath(),
        }),
      );

      expect(message).not.toContain(ENV_KEY);
    });

    it('keeps config.json contents out of the error when the file is not valid JSON', () => {
      // V8's JSON.parse SyntaxError quotes the text around the bad token.
      const message = thrownMessage(() =>
        resolveTestRemote({
          env: {},
          configPath: writeConfig(
            `{"defaultRemote":"cloud","remotes":{"cloud":{"apiKey": ${CLOUD_KEY}}}}`,
          ),
        }),
      );

      expect(message).toContain('not valid JSON');
      expect(message).not.toContain('cloud-api');
    });
  });
});
