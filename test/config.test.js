'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { DEFAULT_CONFIG, getStateDir, loadConfig, saveConfig, validateConfig, stateFiles } = require('../src/config');

const CLIENT_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_ID = '22222222-2222-4222-8222-222222222222';

async function workspace(t) {
  const root = await fs.mkdtemp(path.join(__dirname, '.config-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, state: path.join(root, 'private-state') };
}

test('state directory uses the explicit resolved override or the home default', () => {
  const previous = process.env.AGENT_CONTEXT_HOME;
  try {
    delete process.env.AGENT_CONTEXT_HOME;
    assert.equal(getStateDir(), path.join(os.homedir(), '.agent-context'));
    process.env.AGENT_CONTEXT_HOME = path.join('test', 'relative-state');
    assert.equal(getStateDir(), path.resolve('test', 'relative-state'));
    process.env.AGENT_CONTEXT_HOME = '';
    assert.throws(getStateDir, { code: 'INVALID_CONFIG' });
  } finally {
    if (previous === undefined) delete process.env.AGENT_CONTEXT_HOME;
    else process.env.AGENT_CONTEXT_HOME = previous;
  }
});

test('missing configuration is explicitly unconfigured, isolated, and does not create files', async (t) => {
  const { state } = await workspace(t);
  const config = await loadConfig(state);
  assert.deepEqual(config, {
    clientId: null, tenantId: null, scopes: ['Files.ReadWrite'],
    sharepointHosts: [], downloadHosts: [], driveId: 'me', folderId: 'root',
  });
  config.scopes.push('Files.ReadWrite.All');
  config.sharepointHosts.push('mutated.sharepoint.com');
  assert.deepEqual(await loadConfig(state), DEFAULT_CONFIG);
  await assert.rejects(fs.stat(state), { code: 'ENOENT' });
});

test('saving merges only validated nonsecret fields and round-trips exact defaults through Unicode paths', async (t) => {
  const { root } = await workspace(t);
  const state = path.join(root, "private-中文-'state");
  const saved = await saveConfig({
    clientId: CLIENT_ID.toUpperCase(), tenantId: TENANT_ID,
    sharepointHosts: ['Contoso-My.SharePoint.com'],
    downloadHosts: ['public.dm.files.1drv.com'],
  }, state);
  assert.equal(saved.clientId, CLIENT_ID);
  assert.deepEqual(saved.sharepointHosts, ['contoso-my.sharepoint.com']);
  assert.deepEqual(saved.scopes, ['Files.ReadWrite']);
  const merged = await saveConfig({ folderId: '01TEST_folder!id' }, state);
  assert.equal(merged.clientId, CLIENT_ID);
  assert.equal(merged.folderId, '01TEST_folder!id');
  assert.deepEqual(await loadConfig(state), merged);
  assert.deepEqual((await fs.readdir(state)).sort(), ['config.json']);
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(state)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(path.join(state, 'config.json'))).mode & 0o777, 0o600);
  }
});

test('rejects unknown credential fields, inherited values, accessors, and malformed identifiers', () => {
  const invalid = [
    { accessToken: 'synthetic' }, { refreshToken: 'synthetic' }, { clientSecret: 'synthetic' },
    { authority: 'https://login.microsoftonline.com/common' }, { clientId: '' },
    { clientId: 'not-a-uuid' }, { tenantId: 'common' }, { tenantId: 'organizations' },
    { tenantId: 'consumers' }, { tenantId: '9188040d-6c67-4c5b-b112-36a304b66dad' },
    { tenantId: '00000000-0000-0000-0000-000000000000' }, { clientId: 42 },
    { driveId: '../other' }, { folderId: '..' }, { folderId: 'root?query' },
    { folderId: 'a'.repeat(257) }, { driveId: undefined }, [],
    Object.create({ clientId: CLIENT_ID }),
    JSON.parse('{"__proto__":{"clientId":"not-an-id"}}'),
    { get clientId() { throw new Error('This accessor must not execute'); } },
  ];
  for (const value of invalid) assert.throws(() => validateConfig(value), { code: 'INVALID_CONFIG' });
  assert.deepEqual(validateConfig({ clientId: null, tenantId: null }), DEFAULT_CONFIG);
});

test('Graph scopes are delegated, explicit, bounded, and broad scopes require opt-in', () => {
  assert.deepEqual(validateConfig().scopes, ['Files.ReadWrite']);
  assert.deepEqual(validateConfig({ scopes: ['https://graph.microsoft.com/Files.ReadWrite'] }).scopes, ['Files.ReadWrite']);
  assert.deepEqual(validateConfig({ scopes: ['Files.ReadWrite.All'] }).scopes, ['Files.ReadWrite.All']);
  assert.deepEqual(validateConfig({ scopes: ['User.Read', 'openid', 'offline_access'] }).scopes,
    ['User.Read', 'openid', 'offline_access']);
  for (const scopes of [[], ['.default'], ['https://graph.microsoft.com/.default'],
    ['api://application/.default'], ['https://other.example/Files.ReadWrite'], ['Files.ReadWrite Files.Read'],
    ['client_credentials'], ['openid', 'profile'], ['Files.Read', 'Files.Read'], ['Files.Read', null],
    ['Files.Read', ,], 'Files.ReadWrite']) {
    assert.throws(() => validateConfig({ scopes }), { code: 'INVALID_CONFIG' });
  }
});

test('SharePoint inputs are exact per-tenant hosts; extra transfer hosts are separate exact names', () => {
  const config = validateConfig({ sharepointHosts: ['tenant.sharepoint.com', 'tenant-my.sharepoint.com'],
    downloadHosts: ['download.example.test'] });
  assert.deepEqual(config.downloadHosts, ['download.example.test']);
  for (const host of ['sharepoint.com', '*.sharepoint.com', 'sub.tenant.sharepoint.com', 'tenant.sharepoint.com.evil.test',
    'https://tenant.sharepoint.com', 'tenant.sharepoint.com:443', 'tenant.sharepoint.com/', 'tenant.sharepoint.com.',
    'tenant.sharepoint.com\n', '1drv.ms', 'onedrive.cloud.microsoft', '127.0.0.1']) {
    assert.throws(() => validateConfig({ sharepointHosts: [host] }), { code: 'INVALID_CONFIG' });
  }
  for (const host of ['*.1drv.com', 'localhost', 'app.localhost', '127.0.0.1', '[::1]',
    'download.example/path', 'user@download.example', '-bad.example', 'download..example']) {
    assert.throws(() => validateConfig({ downloadHosts: [host] }), { code: 'INVALID_CONFIG' });
  }
  assert.throws(() => validateConfig({ sharepointHosts: ['tenant.sharepoint.com', 'TENANT.sharepoint.com'] }));
  assert.throws(() => validateConfig({ downloadHosts: ['download.example', ,] }));
});

test('invalid changes cannot overwrite or create configuration', async (t) => {
  const { state } = await workspace(t);
  await assert.rejects(saveConfig({ token: 'synthetic' }, state), { code: 'INVALID_CONFIG' });
  await assert.rejects(fs.stat(state), { code: 'ENOENT' });
  await saveConfig({ clientId: CLIENT_ID }, state);
  const before = await fs.readFile(path.join(state, 'config.json'), 'utf8');
  await assert.rejects(saveConfig({ tenantId: 'common' }, state), { code: 'INVALID_CONFIG' });
  assert.equal(await fs.readFile(path.join(state, 'config.json'), 'utf8'), before);
});

test('validation and persistence use the same configuration byte limit', () => {
  const host = ['a'.repeat(60), 'b'.repeat(62), 'c'.repeat(62), 'd'.repeat(62)].join('.');
  assert.throws(() => validateConfig({
    downloadHosts: Array.from({ length: 64 }, (_, index) => `${String(index).padStart(2, '0')}${host}`),
    sharepointHosts: Array.from({ length: 64 }, (_, index) => `tenant-${index}.sharepoint.com`),
  }), { code: 'INVALID_CONFIG' });
});

test('malformed, null, oversized and unknown-key on-disk configuration fails closed without echoing contents', async (t) => {
  const { state } = await workspace(t);
  await saveConfig({}, state);
  const file = path.join(state, 'config.json');
  for (const contents of ['{"never-echo-this":', 'null', '[]', '{"token":"never-echo-this"}', ' '.repeat(16 * 1024 + 1)]) {
    await fs.writeFile(file, contents);
    await assert.rejects(loadConfig(state), (error) =>
      ['UNSAFE_STATE', 'INVALID_CONFIG'].includes(error.code) && !error.message.includes('never-echo-this'));
  }
});

test('configuration rejects directories, linked files, and linked state parents', async (t) => {
  const { root, state } = await workspace(t);
  await stateFiles.privateDirectory(state);
  const file = path.join(state, 'config.json');
  await fs.mkdir(file);
  await assert.rejects(loadConfig(state), { code: 'UNSAFE_STATE' });
  await assert.rejects(saveConfig({}, state), { code: 'UNSAFE_STATE' });
  await fs.rmdir(file);
  const outside = path.join(root, 'outside');
  await fs.mkdir(outside);
  await fs.symlink(outside, file, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(loadConfig(state), { code: 'UNSAFE_STATE' });
  await assert.rejects(saveConfig({}, state), { code: 'UNSAFE_STATE' });
  const alias = path.join(root, 'linked-state');
  await fs.symlink(state, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(loadConfig(alias), { code: 'UNSAFE_STATE' });
});

test('hard-linked configuration cannot be read or overwritten', async (t) => {
  const { state } = await workspace(t);
  await saveConfig({}, state);
  const file = path.join(state, 'config.json');
  await fs.link(file, path.join(state, 'second-name.json'));
  await assert.rejects(loadConfig(state), { code: 'UNSAFE_STATE' });
  await assert.rejects(saveConfig({ folderId: 'new' }, state), { code: 'UNSAFE_STATE' });
});

test('existing broadly accessible state is rejected, not silently repaired', async (t) => {
  const { state } = await workspace(t);
  await saveConfig({}, state);
  if (process.platform === 'win32') {
    const script = `$p = [Console]::In.ReadToEnd(); ` +
      `$a = [IO.Directory]::GetAccessControl($p, [Security.AccessControl.AccessControlSections]::Access); ` +
      `$s = New-Object Security.Principal.SecurityIdentifier('S-1-1-0'); ` +
      `$r = New-Object Security.AccessControl.FileSystemAccessRule($s, 'Read', 'Allow'); ` +
      `$a.AddAccessRule($r); [IO.Directory]::SetAccessControl($p, $a)`;
    await new Promise((resolve, reject) => {
      const executable = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath'));
      env.PSModulePath = path.join(path.dirname(executable), 'Modules');
      const child = execFile(executable, ['-NoProfile', '-NonInteractive', '-Command', script],
        { windowsHide: true, env }, (error) => error ? reject(error) : resolve());
      child.stdin.end(state);
    });
  } else {
    await fs.chmod(state, 0o755);
  }
  await assert.rejects(loadConfig(state), { code: 'UNSAFE_STATE' });
  await assert.rejects(saveConfig({}, state), { code: 'UNSAFE_STATE' });
});

test('nonregular FIFO configuration is rejected without opening it', { skip: process.platform === 'win32' }, async (t) => {
  const { state } = await workspace(t);
  await stateFiles.privateDirectory(state);
  await promisify(execFile)('mkfifo', [path.join(state, 'config.json')]);
  await assert.rejects(loadConfig(state), { code: 'UNSAFE_STATE' });
});
