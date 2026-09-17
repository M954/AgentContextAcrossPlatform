'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const { createGraphAuth } = require('../src/graph-auth');
const { validateConfig, stateFiles } = require('../src/config');

const CLIENT_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_ID = '22222222-2222-4222-8222-222222222222';
const config = validateConfig({ clientId: CLIENT_ID, tenantId: TENANT_ID });
const accountA = { homeAccountId: `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.${TENANT_ID}`,
  tenantId: TENANT_ID, environment: 'login.windows.net' };
const accountB = { homeAccountId: `bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.${TENANT_ID}`,
  tenantId: TENANT_ID, environment: 'login.windows.net' };
const sensitiveMarker = 'synthetic-sensitive-detail-that-must-not-escape';

function browserUrl() {
  const url = new URL(`https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/authorize`);
  url.search = new URLSearchParams({ client_id: CLIENT_ID, response_type: 'code',
    code_challenge_method: 'S256', code_challenge: 'A'.repeat(43), redirect_uri: 'http://localhost:43210' });
  return url.href;
}

function result(account = accountB) {
  return { accessToken: sensitiveMarker, account, tenantId: TENANT_ID };
}

function harness(overrides = {}) {
  const entries = new Map();
  const nativeData = new Map();
  const calls = { loads: 0, interactive: [], silent: [], clients: [], persisted: [], deleted: [], browsers: [], plain: 0 };
  const options = { accounts: [accountA, accountB], interactiveResult: result(), silentResult: result(), ...overrides };
  const files = {
    async inspect(file, { missing = false, kind = 'file' } = {}) {
      if (options.unsafe) throw new Error(sensitiveMarker);
      const entry = entries.get(file);
      if (!entry && missing) return null;
      if (!entry || entry.kind !== kind) throw new Error(sensitiveMarker);
      return { isFile: () => kind === 'file' };
    },
    async privateDirectory(file) {
      if (options.unsafe) throw new Error(sensitiveMarker);
      entries.set(file, { kind: 'directory' });
      return file;
    },
    async readJson(file) { return structuredClone(entries.get(file)?.json); },
    async writeJson(file, value) {
      if (options.writeFailure) throw new Error(sensitiveMarker);
      calls.persisted.push({ file, json: structuredClone(value) });
      entries.set(file, { kind: 'file', json: structuredClone(value) });
    },
    async removeFile(file) { entries.delete(file); },
    async protectFile() {},
  };
  function native(backend) {
    return {
      async create(file, ...args) {
        calls.persisted.push({ backend, file, args });
        if (options.nativeFailure) throw new Error(sensitiveMarker);
        entries.set(file, { kind: 'file' });
        return {
          async save(contents) { nativeData.set(file, contents); },
          async load() { return nativeData.get(file) || null; },
          async delete() {
            if (options.deleteFailure && file.endsWith('msal-cache.bin')) throw new Error(sensitiveMarker);
            calls.deleted.push(file);
            nativeData.delete(file);
            entries.delete(file);
          },
        };
      },
    };
  }
  const dependencies = {
    stateFiles: files,
    isInteractive: () => options.interactive !== false,
    openBrowser: async (url) => { calls.browsers.push(url); },
    loadSdk: async () => {
      calls.loads++;
      if (options.sdkFailure) throw new Error(sensitiveMarker);
      return {
        msal: {
          LogLevel: { Error: 0 },
          PublicClientApplication: class {
            constructor(clientConfig) {
              this.clientConfig = clientConfig;
              calls.clients.push(clientConfig);
            }
            async cache(changed) {
              const context = { cacheHasChanged: changed, tokenCache: {
                serialize: () => JSON.stringify({ syntheticToken: sensitiveMarker }),
                deserialize() {},
              } };
              await this.clientConfig.cache.cachePlugin.beforeCacheAccess(context);
              await this.clientConfig.cache.cachePlugin.afterCacheAccess(context);
            }
            getTokenCache() {
              return { getAllAccounts: async () => {
                await this.cache(false);
                return options.accounts;
              } };
            }
            async acquireTokenInteractive(request) {
              calls.interactive.push(request);
              await request.openBrowser(options.browserUrl || browserUrl());
              if (options.interactiveFailure) throw new Error(sensitiveMarker);
              await this.cache(true);
              return options.interactiveResult;
            }
            async acquireTokenSilent(request) {
              calls.silent.push(request);
              if (options.silentFailure) throw new Error(sensitiveMarker);
              await this.cache(true);
              if (options.beforeSilentReturn) options.beforeSilentReturn();
              return options.silentResult;
            }
          },
        },
        extensions: {
          DataProtectionScope: { CurrentUser: 'CurrentUser' },
          FilePersistenceWithDataProtection: native('DPAPI'),
          KeychainPersistence: native('Keychain'),
          LibSecretPersistence: native('LibSecret'),
          FilePersistence: { async create() { calls.plain++; throw new Error('Plaintext is prohibited'); } },
          PersistenceCreator: { async createPersistence() { throw new Error('Global validation must not be used'); } },
          PersistenceCachePlugin: class {
            constructor(persistence) { this.persistence = persistence; }
            async beforeCacheAccess(context) {
              const data = await this.persistence.load();
              if (data) context.tokenCache.deserialize(data);
            }
            async afterCacheAccess(context) {
              if (context.cacheHasChanged) await this.persistence.save(context.tokenCache.serialize());
            }
          },
        },
      };
    },
  };
  const root = path.join(__dirname, 'virtual-auth-state');
  return { entries, nativeData, calls, options, dependencies, root,
    auth: createGraphAuth(config, root, dependencies) };
}

function selectedFile(fake) {
  return [...fake.entries.keys()].find((file) => file.endsWith('selected-account.json'));
}

function sanitized(error, code) {
  return error.code === code && !error.message.includes(sensitiveMarker) &&
    !error.message.includes('https://') && error.cause === undefined;
}

test('local-only construction and unconfigured auth never import SDKs or use environment tokens', async () => {
  const fake = harness();
  const auth = createGraphAuth({}, fake.root, fake.dependencies);
  for (const method of ['login', 'getIdentity', 'getAccessToken']) {
    await assert.rejects(auth[method](), (error) => sanitized(error, 'NOT_CONFIGURED') && /configure/.test(error.message));
  }
  assert.deepEqual(await auth.logout(), { status: 'signed-out' });
  assert.equal(fake.calls.loads, 0);
  assert.equal(fake.entries.size, 0);
});

test('configured but unsigned accounts do not silently select the first cached account', async () => {
  const fake = harness();
  await assert.rejects(fake.auth.getIdentity(), { code: 'LOGIN_REQUIRED' });
  await assert.rejects(fake.auth.getAccessToken(), { code: 'LOGIN_REQUIRED' });
  assert.equal(fake.calls.loads, 0);
  assert.equal(fake.calls.interactive.length, 0);
  assert.equal(fake.entries.size, 0);
});

test('auth validates runtime configuration and state paths without echoing caller values', () => {
  for (const state of [null, 42, {}, '', `bad\0${sensitiveMarker}`]) {
    assert.throws(() => createGraphAuth(config, state), (error) => sanitized(error, 'UNSAFE_STATE'));
  }
  assert.throws(() => createGraphAuth({ ...config, clientSecret: sensitiveMarker }), { code: 'INVALID_CONFIG' });
  assert.throws(() => createGraphAuth(config, path.join(__dirname, 'unused'), { loadSdk: sensitiveMarker }),
    (error) => error instanceof TypeError && !error.message.includes(sensitiveMarker));
});

test('a token-valued environment variable cannot replace explicit login', async () => {
  const prior = process.env.AGENT_CONTEXT_ACCESS_TOKEN;
  try {
    process.env.AGENT_CONTEXT_ACCESS_TOKEN = sensitiveMarker;
    const fake = harness();
    await assert.rejects(fake.auth.getAccessToken(), { code: 'LOGIN_REQUIRED' });
    assert.equal(fake.calls.loads, 0);
    assert.equal(fake.calls.interactive.length, 0);
  } finally {
    if (prior === undefined) delete process.env.AGENT_CONTEXT_ACCESS_TOKEN;
    else process.env.AGENT_CONTEXT_ACCESS_TOKEN = prior;
  }
});

test('noninteractive login is rejected before browser, cache, or SDK initialization', async () => {
  const fake = harness({ interactive: false });
  await assert.rejects(fake.auth.login(), { code: 'INTERACTIVE_REQUIRED' });
  assert.equal(fake.calls.loads, 0);
  assert.equal(fake.entries.size, 0);
});

test('explicit delegated login selects B, returns only safe identity, and persists no plaintext tokens', async () => {
  const fake = harness();
  const signedIn = await fake.auth.login();
  assert.deepEqual(signedIn, { status: 'signed-in', accountId: accountB.homeAccountId, tenantId: TENANT_ID });
  assert.equal(await fake.auth.getIdentity(), accountB.homeAccountId);
  assert.equal((await fake.auth.getAccessToken()).length, sensitiveMarker.length);
  assert.equal(fake.calls.silent[0].account.homeAccountId, accountB.homeAccountId);
  assert.deepEqual(fake.calls.silent[0].scopes, ['Files.ReadWrite']);
  assert.equal(fake.calls.silent[0].authority, `https://login.microsoftonline.com/${TENANT_ID}`);
  assert.equal(fake.calls.interactive.length, 1);
  assert.equal(fake.calls.interactive[0].prompt, 'select_account');
  assert.equal(fake.calls.plain, 0);
  assert.ok(!JSON.stringify([...fake.entries.values()]).includes(sensitiveMarker));
  assert.ok(!JSON.stringify(signedIn).includes(sensitiveMarker));
  assert.ok(fake.calls.clients[0].cache.cachePlugin);
  assert.equal(fake.calls.clients[0].system.loggerOptions.piiLoggingEnabled, false);
  assert.equal(fake.calls.clients[0].system.loggerOptions.loggerCallback(0, sensitiveMarker, true), undefined);
  assert.equal(fake.calls.clients[0].auth.clientSecret, undefined);
  assert.equal(fake.calls.clients[0].broker, undefined);
  const backend = fake.calls.persisted.find((call) => call.backend);
  assert.equal(backend.backend, process.platform === 'win32' ? 'DPAPI' : process.platform === 'darwin' ? 'Keychain' : 'LibSecret');
  if (process.platform === 'win32') assert.equal(backend.args[0], 'CurrentUser');
});

test('selected identity survives a new instance without touching the secure store', async () => {
  const fake = harness();
  await fake.auth.login();
  const loads = fake.calls.loads;
  const second = createGraphAuth(config, fake.root, fake.dependencies);
  assert.equal(await second.getIdentity(), accountB.homeAccountId);
  assert.equal(fake.calls.loads, loads);
  await second.getAccessToken();
  assert.equal(fake.calls.interactive.length, 1);
});

test('selected-account absence, mismatch, and ambiguous cache results never select another account', async () => {
  for (const accounts of [[accountA], [], [accountB, accountB]]) {
    const fake = harness({ accounts });
    await fake.auth.login();
    await assert.rejects(fake.auth.getAccessToken(), { code: 'LOGIN_REQUIRED' });
    assert.equal(fake.calls.silent.length, 0);
    assert.equal(fake.calls.interactive.length, 1);
  }
  const fake = harness();
  await fake.auth.login();
  fake.entries.delete(selectedFile(fake));
  await assert.rejects(fake.auth.getAccessToken(), { code: 'LOGIN_REQUIRED' });
  assert.equal(fake.calls.silent.length, 0);
});

test('identity binding rejects account switches before or during silent acquisition', async () => {
  for (const duringRequest of [false, true]) {
    const fake = harness();
    await fake.auth.login();
    const switchAccount = () => { fake.entries.get(selectedFile(fake)).json.homeAccountId = accountA.homeAccountId; };
    if (duringRequest) fake.options.beforeSilentReturn = switchAccount;
    else switchAccount();
    await assert.rejects(fake.auth.getAccessToken(), { code: 'ACCOUNT_CHANGED' });
    assert.equal(fake.calls.interactive.length, 1);
  }
});

test('silent failures are fixed actionable errors with no automatic interactive fallback', async () => {
  const fake = harness({ silentFailure: true });
  await fake.auth.login();
  await assert.rejects(fake.auth.getAccessToken(), (error) =>
    sanitized(error, 'SILENT_FAILED') && /login/.test(error.message) && /No interactive fallback/.test(error.message));
  assert.equal(fake.calls.interactive.length, 1);
  assert.equal(fake.calls.browsers.length, 1);
});

test('tenant mismatch, consumer account, wrong silent account, and empty tokens fail closed', async () => {
  const consumer = { ...accountB, homeAccountId: 'personal.9188040d-6c67-4c5b-b112-36a304b66dad' };
  for (const response of [result(consumer), result({ ...accountB, tenantId: CLIENT_ID }),
    { ...result(), tenantId: CLIENT_ID }, { ...result(), accessToken: '' }, { ...result(), account: null }]) {
    const fake = harness({ interactiveResult: response });
    await assert.rejects(fake.auth.login(), { code: 'ACCOUNT_CHANGED' });
    assert.equal(selectedFile(fake), undefined);
  }
  const fake = harness({ silentResult: result(accountA) });
  await fake.auth.login();
  await assert.rejects(fake.auth.getAccessToken(), { code: 'ACCOUNT_CHANGED' });
});

test('SDK or native secure-store unavailability has no plaintext, memory-only, or device-code fallback', async () => {
  for (const options of [{ sdkFailure: true }, { nativeFailure: true }, { unsafe: true }]) {
    const fake = harness(options);
    await assert.rejects(fake.auth.login(), (error) =>
      sanitized(error, options.unsafe ? 'UNSAFE_STATE' : 'SECURE_STORE_UNAVAILABLE'));
    assert.equal(fake.calls.plain, 0);
    assert.equal(fake.calls.interactive.length, 0);
    assert.equal(fake.calls.browsers.length, 0);
    assert.equal(selectedFile(fake), undefined);
  }
});

test('native-store failure during silent access remains sanitized and cannot start login', async () => {
  const fake = harness();
  await fake.auth.login();
  fake.options.nativeFailure = true;
  const second = createGraphAuth(config, fake.root, fake.dependencies);
  await assert.rejects(second.getAccessToken(), (error) => sanitized(error, 'SECURE_STORE_UNAVAILABLE'));
  assert.equal(fake.calls.interactive.length, 1);
});

test('browser callback accepts only this tenant/client authorization-code PKCE request', async () => {
  for (const url of [
    browserUrl().replace('login.microsoftonline.com', 'login.microsoftonline.com.evil.test'),
    browserUrl().replace('https:', 'http:'),
    browserUrl().replace(`/${TENANT_ID}/`, '/common/'),
    browserUrl().replace('response_type=code', 'response_type=token'),
    browserUrl().replace('code_challenge_method=S256', 'code_challenge_method=plain'),
    browserUrl().replace(`client_id=${CLIENT_ID}`, `client_id=${TENANT_ID}`),
    browserUrl().replace('localhost%3A43210', 'evil.test%3A43210'),
    `${browserUrl()}" & unsafe-command`,
  ]) {
    const fake = harness({ browserUrl: url });
    await assert.rejects(fake.auth.login(), (error) => sanitized(error, 'BROWSER_FAILED'));
    assert.equal(fake.calls.browsers.length, 0);
    assert.equal(selectedFile(fake), undefined);
  }
});

test('interactive SDK errors and metadata write errors are sanitized and cannot report successful sign-in', async () => {
  for (const options of [{ interactiveFailure: true }, { writeFailure: true }]) {
    const fake = harness(options);
    await assert.rejects(fake.auth.login(), (error) => sanitized(error, 'LOGIN_FAILED'));
    assert.equal(selectedFile(fake), undefined);
  }
});

test('logout clears only this app namespace and never deletes global credentials', async () => {
  const fake = harness();
  await fake.auth.login();
  const unrelated = path.join(fake.root, 'other-app-cache');
  fake.entries.set(unrelated, { kind: 'file', json: { unrelated: true } });
  assert.deepEqual(await fake.auth.logout(), { status: 'signed-out' });
  assert.equal(selectedFile(fake), undefined);
  assert.ok(fake.entries.has(unrelated));
  assert.ok(fake.calls.deleted.some((file) => file.endsWith('msal-cache.bin')));
  assert.ok(fake.calls.deleted.every((file) => file.startsWith(path.join(fake.root, 'auth-'))));
  await assert.rejects(fake.auth.getIdentity(), { code: 'LOGIN_REQUIRED' });
  await assert.rejects(fake.auth.getAccessToken(), { code: 'LOGIN_REQUIRED' });
});

test('logout removes local selection even when native cleanup fails and reports incomplete cleanup honestly', async () => {
  const fake = harness({ deleteFailure: true });
  await fake.auth.login();
  await assert.rejects(fake.auth.logout(), (error) => sanitized(error, 'LOGOUT_FAILED'));
  assert.equal(selectedFile(fake), undefined);
  await assert.rejects(fake.auth.getIdentity(), { code: 'LOGIN_REQUIRED' });
});

test('cache namespace isolates client, tenant, and state directory changes', async () => {
  const fake = harness();
  await fake.auth.login();
  for (const [otherConfig, otherRoot] of [
    [{ ...config, clientId: TENANT_ID }, fake.root],
    [{ ...config, tenantId: CLIENT_ID }, fake.root],
    [config, path.join(fake.root, 'different-state')],
  ]) {
    const other = createGraphAuth(otherConfig, otherRoot, fake.dependencies);
    await assert.rejects(other.getIdentity(), { code: 'LOGIN_REQUIRED' });
  }
});

test('real private selection files contain only account metadata, not token material', async (t) => {
  const root = await fs.mkdtemp(path.join(__dirname, '.auth-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const fake = harness();
  const state = path.join(root, 'private-state');
  const auth = createGraphAuth(config, state, { ...fake.dependencies, stateFiles });
  await auth.login();
  const [authName] = await fs.readdir(state);
  const directory = path.join(state, authName);
  assert.deepEqual(await fs.readdir(directory), ['selected-account.json']);
  const bytes = await fs.readFile(path.join(directory, 'selected-account.json'), 'utf8');
  assert.ok(!bytes.includes(sensitiveMarker));
  assert.deepEqual(Object.keys(JSON.parse(bytes)).sort(), ['clientId', 'homeAccountId', 'tenantId', 'version']);
  assert.equal(await createGraphAuth(config, state, { ...fake.dependencies, stateFiles }).getIdentity(), accountB.homeAccountId);
});
