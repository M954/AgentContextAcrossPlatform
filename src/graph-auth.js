'use strict';

const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { getStateDir, validateConfig, stateFiles } = require('./config');

const MESSAGES = Object.freeze({
  NOT_CONFIGURED: 'Microsoft Graph sign-in is not configured. Run node src/cli.js configure --client-id <app-UUID> --tenant-id <work-school-tenant-UUID>, then run node src/cli.js login.',
  LOGIN_REQUIRED: 'No usable selected work/school account is signed in. Run node src/cli.js login in your own interactive terminal.',
  INTERACTIVE_REQUIRED: 'Sign-in requires an explicit login command in your own interactive terminal. Model tools cannot start sign-in.',
  SECURE_STORE_UNAVAILABLE: 'OS-protected token storage is unavailable or locked. Enable or unlock Windows DPAPI, macOS Keychain, or Linux Secret Service, then run node src/cli.js login. Plaintext token storage is not supported.',
  UNSAFE_STATE: 'Private sign-in state could not be accessed safely. Check directory ownership, permissions, and links, then run node src/cli.js login.',
  LOGIN_FAILED: 'Microsoft work/school sign-in did not complete. Check tenant, app registration, localhost redirect URI, and consent, then run node src/cli.js login again.',
  SILENT_FAILED: 'Silent Microsoft Graph sign-in failed. Check connectivity and consent, then run node src/cli.js login in your own interactive terminal. No interactive fallback was started.',
  ACCOUNT_CHANGED: 'The selected work/school account changed or does not match the configured tenant. Run node src/cli.js login and review the action again.',
  BROWSER_FAILED: 'The sign-in browser could not be opened safely. Configure a system browser and run node src/cli.js login again.',
  LOGOUT_FAILED: 'The local sign-in selection was cleared, but the app-specific encrypted cache could not be removed. Unlock OS-protected storage and run node src/cli.js logout again.',
});

class GraphAuthError extends Error {
  constructor(code) {
    super(MESSAGES[code]);
    this.name = 'GraphAuthError';
    this.code = code;
  }
}

function failure(code, error) {
  return error instanceof GraphAuthError ? error : new GraphAuthError(code);
}

function validAccountId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._-]{1,512}$/.test(value) &&
    !value.toLowerCase().endsWith('.9188040d-6c67-4c5b-b112-36a304b66dad');
}

function checkBrowserUrl(value, config) {
  try {
    if (typeof value !== 'string' || value.length > 32768 || /[\x00-\x20"'\\]/.test(value)) throw new Error();
    const url = new URL(value);
    const redirect = new URL(url.searchParams.get('redirect_uri'));
    if (url.protocol !== 'https:' || url.hostname !== 'login.microsoftonline.com' ||
        url.port || url.username || url.password || url.hash ||
        url.pathname.toLowerCase() !== `/${config.tenantId}/oauth2/v2.0/authorize` ||
        url.searchParams.get('client_id')?.toLowerCase() !== config.clientId ||
        url.searchParams.get('response_type') !== 'code' ||
        url.searchParams.get('code_challenge_method') !== 'S256' ||
        !/^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get('code_challenge') || '') ||
        redirect.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(redirect.hostname) ||
        !redirect.port || redirect.username || redirect.password || redirect.hash || redirect.search) throw new Error();
    return url.href;
  } catch {
    throw new GraphAuthError('BROWSER_FAILED');
  }
}

async function launchBrowser(url) {
  let executable;
  let args;
  if (process.platform === 'win32') {
    executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'rundll32.exe');
    args = ['url.dll,FileProtocolHandler', url];
  } else if (process.platform === 'darwin') {
    executable = '/usr/bin/open';
    args = [url];
  } else if (process.platform === 'linux') {
    executable = 'xdg-open';
    args = [url];
  } else {
    throw new GraphAuthError('BROWSER_FAILED');
  }
  await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, stdio: 'ignore', windowsHide: true });
    child.once('error', () => reject(new GraphAuthError('BROWSER_FAILED')));
    child.once('exit', (code) => code === 0 ? resolve() : reject(new GraphAuthError('BROWSER_FAILED')));
  });
}

function createGraphAuth(inputConfig = {}, stateDir = getStateDir(), dependencies = {}) {
  const config = validateConfig(inputConfig);
  if (typeof stateDir !== 'string' || !stateDir || /[\x00-\x1f]/.test(stateDir)) throw new GraphAuthError('UNSAFE_STATE');
  if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies) ||
      ['loadSdk', 'isInteractive', 'openBrowser'].some((name) =>
        dependencies[name] !== undefined && typeof dependencies[name] !== 'function')) {
    throw new TypeError('Authentication dependency callbacks must be functions.');
  }
  const directory = path.resolve(stateDir);
  const namespace = createHash('sha256').update(JSON.stringify([
    'agent-context-auth-v1', process.platform === 'win32' ? directory.toLowerCase() : directory,
    config.clientId, config.tenantId,
  ])).digest('hex');
  const authDirectory = path.join(directory, `auth-${namespace}`);
  const selectionFile = path.join(authDirectory, 'selected-account.json');
  const cacheFile = path.join(authDirectory, 'msal-cache.bin');
  const lockFile = `${cacheFile}.lockfile`;
  const loadSdk = dependencies.loadSdk || (() => ({
    msal: require('@azure/msal-node'),
    extensions: require('@azure/msal-node-extensions'),
  }));
  const isInteractive = dependencies.isInteractive || (() => process.stdin.isTTY === true && process.stdout.isTTY === true);
  const openBrowser = dependencies.openBrowser || launchBrowser;
  const files = dependencies.stateFiles || stateFiles;
  let initialized;
  let boundAccountId;
  let signedOut = false;
  let operations = Promise.resolve();

  function configured() {
    if (!config.clientId || !config.tenantId) throw new GraphAuthError('NOT_CONFIGURED');
  }

  function exclusive(operation) {
    const current = operations.then(operation);
    operations = current.catch(() => {});
    return current;
  }

  async function readSelection() {
    configured();
    let selected;
    try {
      selected = await files.readJson(selectionFile, 4096, [directory]);
    } catch (error) {
      throw failure('UNSAFE_STATE', error);
    }
    if (signedOut || !selected || Object.keys(selected).sort().join(',') !== 'clientId,homeAccountId,tenantId,version' ||
        selected.version !== 1 || selected.clientId !== config.clientId || selected.tenantId !== config.tenantId ||
        !validAccountId(selected.homeAccountId)) throw new GraphAuthError('LOGIN_REQUIRED');
    if (boundAccountId && boundAccountId !== selected.homeAccountId) throw new GraphAuthError('ACCOUNT_CHANGED');
    boundAccountId = selected.homeAccountId;
    return selected;
  }

  function accountMatches(account, accountId, cache = false) {
    return account && validAccountId(account.homeAccountId) &&
      (!accountId || account.homeAccountId === accountId) &&
      (account.tenantId?.toLowerCase() === config.tenantId ||
        (cache && account.tenantProfiles instanceof Map && account.tenantProfiles.has(config.tenantId))) &&
      (!account.environment || ['login.microsoftonline.com', 'login.windows.net', 'sts.windows.net'].includes(account.environment.toLowerCase())) &&
      account.idTokenClaims?.idp !== 'live.com';
  }

  async function assertCacheFiles() {
    const checks = [
      { target: directory, kind: 'directory' }, { target: authDirectory, kind: 'directory' },
      { target: cacheFile, missing: true }, { target: lockFile, missing: true, privateTarget: false },
    ];
    if (files.inspectMany) await files.inspectMany(checks);
    else await Promise.all(checks.map(({ target, ...options }) => files.inspect(target, options)));
  }

  async function initialize() {
    configured();
    if (initialized) return initialized;
    initialized = (async () => {
      try {
        await files.privateDirectory(directory);
        await files.privateDirectory(authDirectory);
        await assertCacheFiles();
      } catch {
        throw new GraphAuthError('UNSAFE_STATE');
      }
      try {
        const { msal, extensions } = await loadSdk();
        const loggerOptions = { loggerCallback() {}, piiLoggingEnabled: false, logLevel: msal.LogLevel.Error };
        const createPersistence = (file, account) => {
          if (process.platform === 'win32') {
            return extensions.FilePersistenceWithDataProtection.create(file,
              extensions.DataProtectionScope.CurrentUser, namespace, loggerOptions);
          }
          if (process.platform === 'darwin') {
            return extensions.KeychainPersistence.create(file, 'AgentContextAcrossPlatform', account, loggerOptions);
          }
          if (process.platform === 'linux') {
            return extensions.LibSecretPersistence.create(file, 'AgentContextAcrossPlatform', account, loggerOptions);
          }
          throw new GraphAuthError('SECURE_STORE_UNAVAILABLE');
        };
        // Avoid PersistenceCreator's globally named validation credential: this probe
        // is app-scoped, uses the native backend, and can never fall back to plaintext.
        const probeId = randomUUID();
        const probeFile = path.join(authDirectory, `.secure-probe-${probeId}`);
        let probe;
        try {
          probe = await createPersistence(probeFile, `${namespace}:probe:${probeId}`);
          await probe.save('agent-context-secure-storage-check');
          if (await probe.load() !== 'agent-context-secure-storage-check') throw new Error();
        } finally {
          if (probe) await probe.delete();
        }
        const persistence = await createPersistence(cacheFile, namespace);
        await assertCacheFiles();
        const nativePlugin = new extensions.PersistenceCachePlugin(persistence, { retryNumber: 50, retryDelay: 100 });
        const cachePlugin = {
          async beforeCacheAccess(context) {
            await assertCacheFiles();
            await nativePlugin.beforeCacheAccess(context);
            await files.protectFile(lockFile);
          },
          async afterCacheAccess(context) {
            try {
              await assertCacheFiles();
              await nativePlugin.afterCacheAccess(context);
            } finally {
              await files.protectFile(lockFile);
            }
            await assertCacheFiles();
          },
        };
        const client = new msal.PublicClientApplication({
          auth: { clientId: config.clientId, authority: `https://login.microsoftonline.com/${config.tenantId}` },
          cache: { cachePlugin },
          system: { loggerOptions },
        });
        return { client, persistence };
      } catch (error) {
        throw failure('SECURE_STORE_UNAVAILABLE', error);
      }
    })();
    try { return await initialized; } catch (error) { initialized = undefined; throw error; }
  }

  async function login() {
    configured();
    if (!isInteractive()) throw new GraphAuthError('INTERACTIVE_REQUIRED');
    return exclusive(async () => {
      const { client } = await initialize();
      try {
        const result = await client.acquireTokenInteractive({
          scopes: [...config.scopes],
          prompt: 'select_account',
          openBrowser: (url) => openBrowser(checkBrowserUrl(url, config)),
          successTemplate: '<!doctype html><title>Signed in</title><p>Return to the AgentContext terminal.</p>',
          errorTemplate: '<!doctype html><title>Sign-in failed</title><p>Return to the AgentContext terminal and try login again.</p>',
        });
        if (!accountMatches(result?.account) || result.tenantId?.toLowerCase() !== config.tenantId ||
            typeof result.accessToken !== 'string' || !result.accessToken) throw new GraphAuthError('ACCOUNT_CHANGED');
        await files.writeJson(selectionFile, {
          version: 1, clientId: config.clientId, tenantId: config.tenantId,
          homeAccountId: result.account.homeAccountId,
        });
        boundAccountId = result.account.homeAccountId;
        signedOut = false;
        return { status: 'signed-in', accountId: boundAccountId, tenantId: config.tenantId };
      } catch (error) {
        throw failure('LOGIN_FAILED', error);
      }
    });
  }

  async function getIdentity() {
    return exclusive(async () => (await readSelection()).homeAccountId);
  }

  async function getAccessToken() {
    return exclusive(async () => {
      const selected = await readSelection();
      const { client } = await initialize();
      try {
        const accounts = (await client.getTokenCache().getAllAccounts())
          .filter((account) => accountMatches(account, selected.homeAccountId, true));
        if (accounts.length !== 1) throw new GraphAuthError('LOGIN_REQUIRED');
        const result = await client.acquireTokenSilent({
          scopes: [...config.scopes], account: accounts[0],
          authority: `https://login.microsoftonline.com/${config.tenantId}`,
        });
        if (!accountMatches(result?.account, selected.homeAccountId) ||
            result.tenantId?.toLowerCase() !== config.tenantId ||
            typeof result.accessToken !== 'string' || !result.accessToken) throw new GraphAuthError('ACCOUNT_CHANGED');
        await readSelection();
        return result.accessToken;
      } catch (error) {
        throw failure('SILENT_FAILED', error);
      }
    });
  }

  async function logout() {
    return exclusive(async () => {
      signedOut = true;
      boundAccountId = undefined;
      if (!config.clientId || !config.tenantId) return { status: 'signed-out' };
      try {
        if (!await files.inspect(authDirectory, { kind: 'directory', missing: true })) return { status: 'signed-out' };
        await files.removeFile(selectionFile);
      } catch {
        throw new GraphAuthError('UNSAFE_STATE');
      }
      try {
        const { persistence } = await initialize();
        await assertCacheFiles();
        // delete() is confined to this directory's client/tenant namespace, not a
        // broker sign-out or a global system-account/credential-store deletion.
        await persistence.delete();
        initialized = undefined;
        return { status: 'signed-out' };
      } catch {
        initialized = undefined;
        throw new GraphAuthError('LOGOUT_FAILED');
      }
    });
  }

  return { login, getAccessToken, getIdentity, logout };
}

module.exports = { createGraphAuth };
