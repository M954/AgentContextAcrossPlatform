'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { contentHash } = require('../snapshot');
const { assertNoLinks } = require('../local-files');

const TARGETS = new Set(['document', 'pi', 'copilot']);

async function workspaceBinding(workspace) {
  if (workspace === undefined || workspace === null) return null;
  if (typeof workspace !== 'string' || !path.isAbsolute(workspace) ||
      /^[\\/]{2}/.test(workspace) || /[\x00-\x1f]/.test(workspace)) {
    throw new Error('Select an absolute local recipient workspace, not a source path or network directory');
  }
  const absolute = await assertNoLinks(workspace);
  const stat = await fs.stat(absolute, { bigint: true });
  if (!stat.isDirectory()) throw new Error('Recipient workspace must be an existing directory');
  return { path: await fs.realpath(absolute), device: String(stat.dev), inode: String(stat.ino) };
}

async function nativeBinding(target) {
  if (target === 'document') return null;
  const executable = process.env[target === 'pi' ? 'AGENT_CONTEXT_PI_BIN' : 'AGENT_CONTEXT_COPILOT_BIN'] || target;
  if (typeof executable !== 'string' || !executable.trim() || /^[\\/]{2}/.test(executable) || /[\x00-\x1f]/.test(executable)) {
    throw new Error('Invalid locally configured host executable');
  }
  const directories = executable.includes('/') || executable.includes('\\')
    ? [''] : (process.env.PATH || process.env.Path || '').split(path.delimiter);
  const extensions = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
  let binary = null;
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = path.resolve(directory, executable + extension);
      try {
        const stat = await fs.stat(candidate, { bigint: true });
        if (stat.isFile()) {
          binary = { path: await fs.realpath(candidate), size: String(stat.size), modified: String(stat.mtimeNs), inode: String(stat.ino) };
          break;
        }
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw new Error('Unable to inspect the locally configured host executable');
      }
    }
    if (binary) break;
  }
  const files = target === 'pi'
    ? ['pi.js', 'pi-native.js', 'private-temp.js', '../../extensions/pi-import-worker.ts'] : ['copilot.js', 'private-temp.js'];
  const code = await Promise.all(files.map(async file => contentHash(await fs.readFile(path.resolve(__dirname, file), 'utf8'))));
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(?:path|pathext|systemroot|windir|comspec|home|userprofile|appdata|localappdata|temp|tmp|tmpdir|lang|lc_all)$/i.test(key)));
  return {
    executable: binary?.path || executable,
    binaryFound: Boolean(binary),
    fingerprint: contentHash({ target, executable, binary, code, environment }),
  };
}

async function prepareImportTarget({ target = 'document', workspaceRoot } = {}, stateDir) {
  if (!TARGETS.has(target)) throw new Error('Choose import target document, pi, or copilot');
  const workspace = await workspaceBinding(workspaceRoot);
  if (target !== 'document' && !workspace) throw new Error('Native import requires an explicit recipient workspace');
  const importId = `import_${crypto.randomBytes(16).toString('hex')}`;
  return {
    target, workspace, importId,
    directory: path.resolve(stateDir, 'imports', importId),
    host: await nativeBinding(target),
    historyRepresentation: target === 'document' ? 'context_document' : 'external_reference_context',
    executionReadiness: 'not_assessed',
    scope: 'isolated local artifacts and optional native session; no repository changes or model turn',
  };
}

async function assertImportTarget(plan, stateDir) {
  if (!plan || !TARGETS.has(plan.target) || !/^import_[a-f0-9]{32}$/.test(plan.importId || '') ||
      plan.directory !== path.resolve(stateDir, 'imports', plan.importId)) {
    throw new Error('Import destination changed; inspect and approve a new review');
  }
  const workspace = await workspaceBinding(plan.workspace?.path);
  if (contentHash(workspace) !== contentHash(plan.workspace) ||
      (plan.target !== 'document' && !workspace)) {
    throw new Error('Recipient workspace changed; inspect and approve a new review');
  }
  const host = await nativeBinding(plan.target);
  if (contentHash(host) !== contentHash(plan.host)) {
    throw new Error('Native host configuration changed; inspect and approve a new review');
  }
  await assertNoLinks(plan.directory);
}

module.exports = { TARGETS, prepareImportTarget, assertImportTarget, workspaceBinding };
