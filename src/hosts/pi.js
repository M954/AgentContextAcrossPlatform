'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { verifySnapshotRecord } = require('../snapshot');
const { privateTemporary } = require('./private-temp');
const { readBoundedFile } = require('../local-files');
const MAX_RPC_BYTES = 8 * 1024 * 1024;
const WORKER = path.resolve(__dirname, '..', '..', 'extensions', 'pi-import-worker.ts');

function workerEnvironment(configDir, extra = {}) {
  // Forward only process-launch essentials; do not hand credentials, source
  // session markers, provider commands, or configured extension paths to pi.
  const env = {};
  const allowed = /^(?:path|pathext|systemroot|windir|comspec|home|userprofile|appdata|localappdata|temp|tmp|tmpdir|lang|lc_all)$/i;
  for (const [key, value] of Object.entries(process.env)) if (allowed.test(key)) env[key] = value;
  return { ...env, PI_CODING_AGENT_DIR: configDir, PI_OFFLINE: '1', PI_TELEMETRY: '0', PI_SKIP_VERSION_CHECK: '1', ...extra };
}

function runPiWorker({ cwd, configDir, sessionDir, recordPath, tempRoot, executable, timeoutMs = 60000 }) {
  const args = ['--mode', 'rpc', '--offline', '--no-extensions', '--no-skills', '--no-prompt-templates',
    '--no-themes', '--no-context-files', '--no-tools', '--no-approve', '--no-session', '-e', WORKER];
  return new Promise((resolve, reject) => {
    const child = spawn(executable || process.env.AGENT_CONTEXT_PI_BIN || 'pi', args, {
      cwd, env: workerEnvironment(configDir, {
        ...(recordPath ? { AGENT_CONTEXT_PI_IMPORT_FILE: recordPath } : {}),
        ...(sessionDir ? { AGENT_CONTEXT_PI_SESSION_DIR: sessionDir } : {}),
        ...(tempRoot ? { AGENT_CONTEXT_PI_TEMP_ROOT: tempRoot } : {}),
      }), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buffer = '';
    let bytes = 0;
    let result;
    let completed = false;
    let settled = false;
    let failure;
    const timer = setTimeout(() => finish(new Error('Pi import timed out; inspect the destination before retrying. No automatic retry was attempted.')), timeoutMs);
    function finish(error, value) {
      if (settled) return;
      settled = true;
      failure = error;
      result = value;
      child.stdin.end();
      child.kill();
    }
    child.on('error', () => finish(new Error('Unable to start pi; install it or configure AGENT_CONTEXT_PI_BIN')));
    child.stdin.on('error', () => finish(new Error('Pi RPC input closed before completion')));
    child.stderr.on('data', () => { /* Do not forward internal paths or imported text into logs. */ });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (settled) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_RPC_BYTES) return finish(new Error('Pi RPC output exceeds its limit'));
      buffer += chunk;
      let newline;
      while (!settled && (newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let event;
        try { event = JSON.parse(line); } catch { return finish(new Error('Invalid pi RPC JSONL')); }
        if (event.type === 'agent_start' || event.type === 'tool_execution_start') {
          return finish(new Error('Unexpected execution event during offline pi import'));
        }
        if (event.type === 'extension_error') return finish(new Error('Pi import extension failed; inspect the destination before retrying'));
        if (event.type === 'extension_ui_request' && event.method === 'notify') {
          try {
            const payload = JSON.parse(event.message);
            if (payload.marker === 'agent-context-pi-import-result') result = payload.result;
          } catch { /* Ignore unrelated notifications. */ }
        }
        if (event.type !== 'response') continue;
        if (event.success !== true) return finish(new Error('Pi RPC command failed; no automatic retry was attempted'));
        if (event.id === 'capabilities') {
          if (!event.data?.commands?.some(command => command.name === 'ac-internal-import' && command.source === 'extension')) {
            return finish(new Error('Pi could not load the required import extension'));
          }
          if (!recordPath) return finish(null, { host: 'pi', nativeImport: true, method: 'SessionManager.forkFrom via isolated RPC extension', liveCapture: 'with-pi-extension' });
          child.stdin.write(JSON.stringify({ id: 'import', type: 'prompt', message: '/ac-internal-import' }) + '\n');
        } else if (event.id === 'import') {
          completed = true;
          if (!result || result.status !== 'native_session_created' || !result.sessionFile || !result.localSessionId) {
            return finish(new Error('Pi did not confirm persistent session creation'));
          }
          return finish(null, result);
        }
      }
    });
    child.on('close', () => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (settled && (!recordPath || completed)) resolve(result);
      else reject(new Error('Pi exited before confirming import capability or completion'));
    });
    child.stdin.write(JSON.stringify({ id: 'capabilities', type: 'get_commands' }) + '\n');
  });
}

async function getPiCapabilities(options = {}) {
  const temporary = await privateTemporary('agent-context-pi-check-');
  const root = temporary.directory;
  try {
    return await runPiWorker({ cwd: root, configDir: path.join(root, 'config'), executable: options.executable });
  } catch (error) {
    return { host: 'pi', nativeImport: false, liveCapture: false, reason: error.message };
  } finally {
    await temporary.dispose();
  }
}

async function importPiSession(record, options = {}) {
  verifySnapshotRecord(record);
  if (typeof options.workspace !== 'string' || !options.workspace.trim() || /^[\\/]{2}/.test(options.workspace)) {
    throw new Error('Select a local recipient workspace explicitly for pi import');
  }
  const workspace = await fs.realpath(path.resolve(options.workspace));
  if (!(await fs.stat(workspace)).isDirectory()) throw new Error('Recipient workspace must be a directory');
  if (typeof options.sessionDir !== 'string' || !path.isAbsolute(options.sessionDir)) throw new Error('A reviewed private pi session directory is required');
  const capabilities = await getPiCapabilities({ executable: options.executable });
  if (!capabilities.nativeImport) throw new Error(capabilities.reason);
  if (options.approval !== true) return {
    status: 'confirmation-required', targetHost: 'pi', restoreMode: 'native_session',
    sourceSnapshotId: record.manifest.snapshotId, sourceContentHash: record.manifest.contentHash,
    workspace, historyRepresentation: 'external_custom_message', executionReadiness: 'not_assessed',
    warning: 'Create a new persisted pi session with external context. No model or tool runs; source environment and permissions are not restored.',
  };
  const sessionDir = path.resolve(options.sessionDir);
  const temporary = await privateTemporary('agent-context-pi-import-', options.tempRoot);
  const root = temporary.directory;
  try {
    const recordPath = path.join(root, 'record.json');
    await fs.writeFile(recordPath, JSON.stringify(record), { mode: 0o600, flag: 'wx' });
    const result = await runPiWorker({ cwd: workspace, configDir: path.join(root, 'config'), sessionDir, recordPath,
      tempRoot: options.tempRoot, executable: options.executable });
    const relative = path.relative(sessionDir, result.sessionFile);
    if (path.isAbsolute(relative) || relative.startsWith('..') || !relative) throw new Error('Pi returned an unexpected session location');
    const entries = (await readBoundedFile(result.sessionFile, 8 * 1024 * 1024)).toString('utf8').trim().split('\n').map(line => JSON.parse(line));
    if (entries[0]?.type !== 'session' || entries[0].id !== result.localSessionId ||
        !entries.some(entry => entry.type === 'custom_message' && entry.details?.sourceContentHash === record.manifest.contentHash)) {
      throw new Error('Pi persisted-session verification failed');
    }
    return result;
  } finally {
    await temporary.dispose();
  }
}

module.exports = { getPiCapabilities, importPiSession, workerEnvironment, runPiWorker };
