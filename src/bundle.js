'use strict';

const path = require('node:path');
const { TextDecoder } = require('node:util');
const { containedPath, readBoundedFile } = require('./local-files');
const {
  MAX_SNAPSHOT_BYTES, MAX_TEXT_BYTES, canonicalJson, contentHash,
  createSnapshotRecord, prepareSnapshot, verifySnapshotRecord,
} = require('./snapshot');

const MAX_BUNDLE_BYTES = MAX_SNAPSHOT_BYTES + 64 * 1024;
const SENSITIVE_PATH = /(?:^|\/)(?:\.env(?:\..*)?|\.git|\.ssh|\.aws|\.azure|\.copilot|\.claude|\.pi|\.agent-context|node_modules|credentials(?:\..*)?|id_rsa|id_ed25519|.*\.(?:pem|pfx|p12|key))(?:\/|$)/i;
const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.json', '.jsonl', '.js', '.ts', '.jsx', '.tsx', '.py',
  '.go', '.cs', '.sql', '.kql', '.yaml', '.yml', '.xml', '.csv', '.patch', '.diff', '.html', '.css']);

function validateSelectedPath(relative) {
  containedPath(process.cwd(), relative);
  if (SENSITIVE_PATH.test(relative) || !TEXT_EXTENSIONS.has(path.extname(relative).toLowerCase())) {
    throw new Error('Only selected text files are supported; credential and agent-state paths are blocked');
  }
}

async function captureFiles(snapshot, workspace, names = []) {
  if (names.length > 20) throw new Error('Select at most 20 supporting text files');
  const files = [...(snapshot.files || [])];
  for (const name of names) {
    const relative = name.replaceAll('\\', '/');
    validateSelectedPath(relative);
    const bytes = await readBoundedFile(containedPath(workspace, relative), MAX_TEXT_BYTES);
    const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (content.includes('\0')) throw new Error('Binary supporting files are not supported');
    files.push({ path: relative, encoding: 'utf8', content });
  }
  return files.length ? { ...snapshot, files } : snapshot;
}

function createBundle(snapshot, priorRedactions = []) {
  if (!Array.isArray(priorRedactions) || priorRedactions.length > 10000 ||
      priorRedactions.some(value => typeof value !== 'string' || value.length > 4096)) {
    throw new Error('Invalid local capture redaction metadata');
  }
  for (const file of snapshot.files || []) validateSelectedPath(file.path);
  const prepared = prepareSnapshot(snapshot);
  const record = createSnapshotRecord(prepared.snapshot, { redactions: [...new Set([...priorRedactions, ...prepared.redactions])] });
  const bundle = { format: 'agent-context-bundle', bundleVersion: 1, record };
  if (Buffer.byteLength(canonicalJson(bundle)) > MAX_BUNDLE_BYTES) throw new Error('Bundle exceeds size limit');
  return bundle;
}

function verifyBundle(bundle) {
  if (!bundle || bundle.format !== 'agent-context-bundle' || bundle.bundleVersion !== 1) {
    throw new Error('Not a supported AgentContext session bundle');
  }
  if (Buffer.byteLength(JSON.stringify(bundle)) > MAX_BUNDLE_BYTES) throw new Error('Bundle exceeds size limit');
  verifySnapshotRecord(bundle.record);
  for (const file of bundle.record.snapshot.files || []) validateSelectedPath(file.path);
  const prepared = prepareSnapshot(bundle.record.snapshot);
  if (prepared.redactions.length || contentHash(prepared.snapshot) !== contentHash(bundle.record.snapshot)) {
    throw new Error('Incoming bundle contains secret-like content; ask the sender to redact and share again');
  }
  return bundle;
}

function parseBundle(bytes) {
  if (bytes.length > MAX_BUNDLE_BYTES) throw new Error('Bundle exceeds size limit');
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new Error('Expected a UTF-8 JSON session bundle, not an Office document or webpage');
  }
  return verifyBundle(parsed);
}

module.exports = { MAX_BUNDLE_BYTES, captureFiles, createBundle, parseBundle, verifyBundle };
