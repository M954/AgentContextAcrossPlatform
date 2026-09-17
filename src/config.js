'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { isIP } = require('node:net');
const { randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');

const CONFIG_LIMIT = 16 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONSUMER_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad';
const DEFAULT_CONFIG = Object.freeze({
  clientId: null,
  tenantId: null,
  // The delegated Graph /shares API requires Files.ReadWrite, even when inspecting a shared file.
  scopes: Object.freeze(['Files.ReadWrite']),
  sharepointHosts: Object.freeze([]),
  downloadHosts: Object.freeze([]),
  driveId: 'me',
  folderId: 'root',
});

function invalidConfig(message = 'Configuration contains unsupported fields or values.') {
  const error = new Error(message);
  error.code = 'INVALID_CONFIG';
  return error;
}

function stateError() {
  const error = new Error('Private state is unsafe or unavailable. Use a directory owned only by your account, without links, and private regular files.');
  error.code = 'UNSAFE_STATE';
  return error;
}

function resolveDirectory(directory) {
  if (typeof directory !== 'string' || !directory || /[\x00-\x1f]/.test(directory)) {
    throw invalidConfig('The state directory must be a nonempty local directory path.');
  }
  return path.resolve(directory);
}

function getStateDir() {
  return resolveDirectory(process.env.AGENT_CONTEXT_HOME === undefined
    ? path.join(os.homedir(), '.agent-context')
    : process.env.AGENT_CONTEXT_HOME);
}

function hostname(value, sharepoint) {
  if (typeof value !== 'string' || value.length > 253 || value.length < 3) throw invalidConfig();
  const host = value.toLowerCase();
  const labels = host.split('.');
  if (labels.length < 2 || isIP(host) || labels.some((label) =>
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
    /^\d+$/.test(labels.at(-1)) || /(?:^|\.)localhost$/.test(host)) throw invalidConfig();
  if (sharepoint && (labels.length !== 3 || !host.endsWith('.sharepoint.com'))) throw invalidConfig();
  return host;
}

function fields(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(data)) ||
      Reflect.ownKeys(data).some((key) => typeof key !== 'string' || !Object.hasOwn(DEFAULT_CONFIG, key)) ||
      Object.values(Object.getOwnPropertyDescriptors(data)).some((descriptor) => !Object.hasOwn(descriptor, 'value'))) {
    throw invalidConfig();
  }
  const result = {};
  for (const [key, value] of Object.entries(data)) {
    if (key === 'clientId' || key === 'tenantId') {
      if (value !== null && (typeof value !== 'string' || !UUID.test(value) ||
          value === '00000000-0000-0000-0000-000000000000')) {
        throw invalidConfig('clientId and tenantId must be UUIDs or null; use a work/school tenant, not common or consumers.');
      }
      if (key === 'tenantId' && value?.toLowerCase() === CONSUMER_TENANT) throw invalidConfig();
      result[key] = value === null ? null : value.toLowerCase();
    } else if (key === 'scopes') {
      if (!Array.isArray(value) || !value.length || value.length > 32) throw invalidConfig();
      const scopes = Array.from(value, (scope) => {
        if (typeof scope !== 'string' || scope.length > 160) throw invalidConfig();
        const name = scope.replace(/^https:\/\/graph\.microsoft\.com\//, '');
        if (!/^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)*$/.test(name) && name !== 'offline_access') {
          throw invalidConfig('Scopes must be explicit delegated Microsoft Graph permissions; .default and other resources are not supported.');
        }
        return name;
      });
      if (new Set(scopes).size !== scopes.length ||
          !scopes.some((scope) => !['openid', 'profile', 'offline_access'].includes(scope))) throw invalidConfig();
      result[key] = scopes;
    } else if (key === 'sharepointHosts' || key === 'downloadHosts') {
      if (!Array.isArray(value) || value.length > 64) throw invalidConfig();
      result[key] = Array.from(value, (host) => hostname(host, key === 'sharepointHosts'));
      if (new Set(result[key]).size !== result[key].length) throw invalidConfig();
    } else {
      if (typeof value !== 'string' || !/^[A-Za-z0-9!_.-]{1,256}$/.test(value) ||
          value === '.' || value === '..') throw invalidConfig('driveId and folderId must be Microsoft Graph resource identifiers.');
      result[key] = value;
    }
  }
  return result;
}

function validateConfig(data = {}) {
  const config = {
    ...DEFAULT_CONFIG,
    scopes: [...DEFAULT_CONFIG.scopes],
    sharepointHosts: [],
    downloadHosts: [],
    ...fields(data),
  };
  if (Buffer.byteLength(JSON.stringify(config)) > CONFIG_LIMIT) throw invalidConfig('Configuration exceeds the size limit.');
  return config;
}

// chmod does not enforce Windows ACLs. Inspect native ownership/reparse attributes
// and protect newly created state without altering an existing user's directory.
const WINDOWS_BOUNDARY_SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
  [Console]::InputEncoding = New-Object Text.UTF8Encoding($false)
  [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  foreach ($entry in $request.paths) {
    if (([IO.File]::GetAttributes($entry) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { exit 1 }
  }
  foreach ($check in $request.targets) {
    if (!$check.target) { continue }
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl = Get-Acl -LiteralPath $check.target
    if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { exit 1 }
    if ($check.protect) {
      if ([IO.Directory]::Exists($check.target)) {
        $acl = New-Object Security.AccessControl.DirectorySecurity
        $inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
      } else {
        $acl = New-Object Security.AccessControl.FileSecurity
        $inherit = [Security.AccessControl.InheritanceFlags]::None
      }
      $acl.SetOwner($sid)
      $acl.SetAccessRuleProtection($true, $false)
      foreach ($trusted in @($sid.Value, 'S-1-5-18', 'S-1-5-32-544')) {
        $identity = New-Object Security.Principal.SecurityIdentifier($trusted)
        $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', $inherit, 'None', 'Allow')
        $acl.AddAccessRule($rule)
      }
      Set-Acl -LiteralPath $check.target -AclObject $acl
      $acl = Get-Acl -LiteralPath $check.target
    }
    if ($check.private) {
      $ownerAllowed = $false
      foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        if ($rule.AccessControlType -eq 'Allow' -and
            $rule.IdentityReference.Value -notin @($sid.Value, 'S-1-5-18', 'S-1-5-32-544')) { exit 1 }
        if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -eq $sid.Value) { $ownerAllowed = $true }
      }
      if (!$ownerAllowed) { exit 1 }
    }
  }
  [Console]::Out.Write('ok')
} catch { exit 1 }
`;

async function windowsBoundary(paths, target, { protect = false, privateTarget = true } = {}) {
  if (process.platform !== 'win32') return;
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32',
    'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath'));
  env.PSModulePath = path.join(path.dirname(executable), 'Modules');
  await new Promise((resolve, reject) => {
    const child = execFile(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_BOUNDARY_SCRIPT],
      { windowsHide: true, timeout: 15000, maxBuffer: 4096, env }, (error, stdout) => {
        if (error || stdout.trim() !== 'ok') reject(stateError());
        else resolve();
      });
    child.stdin.on('error', () => {});
    const targets = Array.isArray(target) ? target : [{ target, protect, private: privateTarget }];
    child.stdin.end(JSON.stringify({ paths, targets }));
  });
}

function assertStat(stat, kind, privateTarget = true) {
  if (stat.isSymbolicLink() || (kind === 'directory' ? !stat.isDirectory() : !stat.isFile()) ||
      (kind === 'file' && stat.nlink !== 1) ||
      (typeof process.getuid === 'function' && (stat.uid !== process.getuid() ||
        (privateTarget && (stat.mode & 0o077) !== 0)))) throw stateError();
}

async function inspectMany(checks) {
  try {
    const results = await Promise.all(checks.map(async ({ target, kind = 'file', missing = false, privateTarget = true }) => {
      const absolute = resolveDirectory(target);
      const root = path.parse(absolute).root;
      let current = root;
      let stat;
      const existing = [root];
      for (const part of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
        current = path.join(current, part);
        try { stat = await fs.lstat(current); } catch (error) {
          if (error.code !== 'ENOENT' || !missing) throw error;
          return { stat: null, existing, check: {} };
        }
        if (stat.isSymbolicLink() || (current !== absolute && !stat.isDirectory())) throw stateError();
        existing.push(current);
      }
      stat ||= await fs.lstat(absolute);
      assertStat(stat, kind, privateTarget);
      return { stat, existing, check: { target: absolute, private: privateTarget } };
    }));
    await windowsBoundary([...new Set(results.flatMap((result) => result.existing))], results.map((result) => result.check));
    return results.map((result) => result.stat);
  } catch {
    throw stateError();
  }
}

async function inspect(target, options = {}) {
  return (await inspectMany([{ target, ...options }]))[0];
}

async function protectFile(file) {
  try { await fs.lstat(file); } catch (error) { if (error.code === 'ENOENT') return; throw stateError(); }
  const stat = await inspect(file, { missing: true, privateTarget: false });
  if (!stat) return;
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = await handle.stat();
    if (opened.ino !== stat.ino || opened.dev !== stat.dev) throw stateError();
    assertStat(opened, 'file', false);
    if (process.platform === 'win32') await windowsBoundary([file], file, { protect: true });
    else await handle.chmod(0o600);
  } finally {
    await handle.close();
  }
}

async function privateDirectory(directory) {
  const absolute = resolveDirectory(directory);
  if (await inspect(absolute, { kind: 'directory', missing: true })) return absolute;
  try {
    const firstCreated = await fs.mkdir(absolute, { recursive: true, mode: 0o700 });
    if (firstCreated && process.platform === 'win32') {
      const first = firstCreated.startsWith('\\\\?\\UNC\\') ? `\\\\${firstCreated.slice(8)}`
        : firstCreated.startsWith('\\\\?\\') ? firstCreated.slice(4) : firstCreated;
      const relative = path.relative(first, absolute);
      if (path.isAbsolute(relative) || relative.split(path.sep).includes('..')) throw stateError();
      const created = [first];
      for (const part of relative.split(path.sep).filter(Boolean)) {
        created.push(path.join(created.at(-1), part));
      }
      for (const entry of created) await windowsBoundary([entry], entry, { protect: true });
    }
    await inspect(absolute, { kind: 'directory' });
    return absolute;
  } catch {
    throw stateError();
  }
}

async function readJson(file, limit = CONFIG_LIMIT, parents = []) {
  const checks = [...new Set([path.dirname(file), ...parents])].map((target) =>
    ({ target, kind: 'directory', missing: true }));
  checks.push({ target: file, missing: true });
  const stat = (await inspectMany(checks)).at(-1);
  if (!stat) return undefined;
  if (stat.size > limit) throw stateError();
  let handle;
  try {
    handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
    const opened = await handle.stat();
    assertStat(opened, 'file');
    if (opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size > limit) throw stateError();
    const bytes = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < bytes.length) {
      const result = await handle.read(bytes, size, bytes.length - size, null);
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    const after = await handle.stat();
    if (size > limit || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) throw stateError();
    const current = (await inspectMany(checks)).at(-1);
    if (!current || current.ino !== opened.ino || current.dev !== opened.dev) throw stateError();
    return JSON.parse(bytes.subarray(0, size).toString('utf8'));
  } catch {
    throw stateError();
  } finally {
    await handle?.close();
  }
}

async function writeJson(file, value) {
  const bytes = JSON.stringify(value);
  if (Buffer.byteLength(bytes) > CONFIG_LIMIT) throw stateError();
  await privateDirectory(path.dirname(file));
  await inspect(file, { missing: true });
  const staging = path.join(path.dirname(file), `.state-${randomUUID()}.new`);
  let handle;
  try {
    handle = await fs.open(staging, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY |
      (constants.O_NOFOLLOW || 0), 0o600);
    if (process.platform === 'win32') await windowsBoundary([staging], staging, { protect: true });
    await handle.writeFile(bytes, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await inspect(file, { missing: true });
    await fs.rename(staging, file);
    await inspect(file);
  } catch {
    throw stateError();
  } finally {
    await handle?.close();
    await fs.unlink(staging).catch((error) => { if (error.code !== 'ENOENT') throw stateError(); });
  }
}

async function removeFile(file) {
  if (await inspect(file, { missing: true })) {
    try { await fs.unlink(file); } catch { throw stateError(); }
  }
}

async function loadConfig(stateDir = getStateDir()) {
  const directory = resolveDirectory(stateDir);
  const data = await readJson(path.join(directory, 'config.json'));
  return data === undefined ? validateConfig() : validateConfig(data);
}

async function saveConfig(data, stateDir = getStateDir()) {
  const changes = fields(data);
  const directory = await privateDirectory(resolveDirectory(stateDir));
  const config = validateConfig({ ...await loadConfig(directory), ...changes });
  await writeJson(path.join(directory, 'config.json'), config);
  return config;
}

module.exports = {
  DEFAULT_CONFIG, getStateDir, loadConfig, saveConfig, validateConfig,
  stateFiles: { inspect, inspectMany, privateDirectory, readJson, writeJson, removeFile, protectFile },
};
