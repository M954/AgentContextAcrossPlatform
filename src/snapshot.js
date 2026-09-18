'use strict';

const crypto = require('node:crypto');

const SNAPSHOT_SCHEMA_VERSION = '1.0';
const MAX_EVENT_COUNT = 5000;
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_BYTES = 128 * 1024;
const { containedPath } = require('./local-files');
const { validateNextStep } = require('./requirements');

class SecretDetectionError extends Error {
  constructor(paths) {
    super(
      `Publication blocked: high-confidence secrets were detected at ${paths.join(', ')}. ` +
        'Remove them from the source session and try again.',
    );
    this.name = 'SecretDetectionError';
    this.paths = paths;
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cloneJson(value) {
  checkJson(value);
  return JSON.parse(JSON.stringify(value));
}

function checkJson(value, depth = 0, budget = { nodes: 0 }) {
  budget.nodes += 1;
  if (depth > 30 || budget.nodes > 100000) invalid('', 'JSON structure exceeds limits');
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > MAX_TEXT_BYTES) invalid('', 'text exceeds size limit');
    return;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    for (const item of value) checkJson(item, depth + 1, budget);
    return;
  }
  if (!isObject(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    invalid('', 'only JSON values are supported');
  }
  for (const [key, child] of Object.entries(value)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) invalid('', 'unsafe property');
    if (key.length > 256 || /[\x00-\x1f]/.test(key)) invalid('', 'invalid property name');
    checkJson(child, depth + 1, budget);
  }
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value === undefined ? null : value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }

  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`;
}

function contentHash(snapshot) {
  return crypto.createHash('sha256').update(canonicalJson(snapshot)).digest('hex');
}

function invalid(path, message) {
  throw new Error(`Invalid session snapshot${path ? ` at ${path}` : ''}: ${message}`);
}

function validateSessionSnapshot(snapshot) {
  checkJson(snapshot);
  if (!isObject(snapshot)) {
    invalid('', 'expected an object');
  }
  const allowed = new Set(['schemaVersion', 'source', 'task', 'events', 'workspace', 'resume',
    'requiredCapabilities', 'omitted', 'files', 'attachments']);
  if (Object.keys(snapshot).some((key) => !allowed.has(key))) {
    invalid('', 'unsupported top-level field; record unsupported attachments or state as omissions');
  }
  for (const field of ['omitted', 'requiredCapabilities']) {
    if (snapshot[field] !== undefined &&
        (!Array.isArray(snapshot[field]) || snapshot[field].some((value) => typeof value !== 'string'))) {
      invalid(field, 'expected a list of strings');
    }
  }

  if (snapshot.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
    invalid('schemaVersion', `expected ${SNAPSHOT_SCHEMA_VERSION}`);
  }

  if (!isObject(snapshot.source)) {
    invalid('source', 'expected an object');
  }

  if (typeof snapshot.source.host !== 'string' || snapshot.source.host.length === 0) {
    invalid('source.host', 'expected a non-empty string');
  }

  if (typeof snapshot.source.sessionId !== 'string' || snapshot.source.sessionId.length === 0) {
    invalid('source.sessionId', 'expected a non-empty string');
  }

  if (!Array.isArray(snapshot.events) || snapshot.events.length > MAX_EVENT_COUNT) {
    invalid('events', `expected an array with at most ${MAX_EVENT_COUNT} entries`);
  }

  const eventIds = new Set();
  snapshot.events.forEach((event, index) => {
    if (!isObject(event)) {
      invalid(`events[${index}]`, 'expected an object');
    }
    if (typeof event.eventId !== 'string' || event.eventId.length === 0) {
      invalid(`events[${index}].eventId`, 'expected a non-empty string');
    }
    if (typeof event.type !== 'string' || event.type.length === 0) {
      invalid(`events[${index}].type`, 'expected a non-empty string');
    }
    if (typeof event.timestamp !== 'string' || event.timestamp.length === 0) {
      invalid(`events[${index}].timestamp`, 'expected a non-empty string');
    }
    if (!Number.isFinite(Date.parse(event.timestamp))) invalid('events', 'invalid timestamp');
    if (eventIds.has(event.eventId)) invalid('events', 'duplicate event ID');
    eventIds.add(event.eventId);
  });

  if (!isObject(snapshot.workspace)) {
    invalid('workspace', 'expected an object');
  }

  if (!isObject(snapshot.resume)) {
    invalid('resume', 'expected an object');
  }

  if (typeof snapshot.resume.nextAction !== 'string' || snapshot.resume.nextAction.length === 0) {
    invalid('resume.nextAction', 'expected a non-empty string');
  }

  validateNextStep(snapshot.resume.nextStep);

  if (snapshot.files !== undefined) {
    if (!Array.isArray(snapshot.files) || snapshot.files.length > 20) invalid('files', 'maximum 20 text files');
    const paths = new Set();
    for (const file of snapshot.files) {
      if (!isObject(file) || typeof file.content !== 'string' || file.encoding !== 'utf8') {
        invalid('files', 'only explicitly selected UTF-8 text files are supported');
      }
      containedPath(process.cwd(), file.path);
      if (paths.has(file.path.toLowerCase())) invalid('files', 'duplicate file path');
      paths.add(file.path.toLowerCase());
    }
  }
  if (snapshot.attachments !== undefined) {
    if (!Array.isArray(snapshot.attachments) || snapshot.attachments.length + (snapshot.files?.length || 0) > 20) {
      invalid('attachments', 'maximum 20 selected text files/attachments');
    }
    for (const attachment of snapshot.attachments) {
      if (!isObject(attachment) || typeof attachment.text !== 'string' ||
          Object.keys(attachment).some((key) => !['text', 'name'].includes(key)) ||
          (attachment.name !== undefined && typeof attachment.name !== 'string')) {
        invalid('attachments', 'only selected attachment text is supported; record binary data as omitted');
      }
    }
  }
  if (Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > MAX_SNAPSHOT_BYTES) {
    invalid('', 'snapshot exceeds size limit');
  }
  return snapshot;
}

const SECRET_KEY_PATTERN =
  /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|private[_-]?key|authorization|cookie|connection[_-]?string|account[_-]?key|secret|(?:^|[_-])(?:sig|signature|token)(?:$|[_-]))/i;
const INLINE_SECRET_PATTERN =
  /(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|private[_-]?key|accountkey|sig|signature|secret|token)["']?\s*[:=]\s*)(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^\s,;&]+))/gi;
const BEARER_PATTERN = /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const PRIVATE_KEY_PATTERN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const TOKEN_PATTERN = /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g;

function redactValue(value, path, state) {
  if (typeof value === 'string') {
    if (PRIVATE_KEY_PATTERN.test(value)) {
      state.blocked.push(path);
      return '[REDACTED_PRIVATE_KEY]';
    }

    let redacted = value.replace(BEARER_PATTERN, () => {
      state.blocked.push(path);
      return '[REDACTED_BEARER_TOKEN]';
    });

    redacted = redacted.replace(INLINE_SECRET_PATTERN, (match, prefix, doubleQuoted, singleQuoted, bare) => {
      // Unterminated quoted values must not leave a secret suffix in the text.
      if (bare !== undefined && (bare.startsWith('"') || bare.startsWith("'"))) {
        state.blocked.push(path);
        return `${prefix}[REDACTED]`;
      }
      const secret = doubleQuoted ?? singleQuoted ?? bare;
      if (/^\[REDACTED(?::[^\]]+)?\]$/.test(secret)) return match;
      state.redactions.push(path);
      const quote = doubleQuoted !== undefined ? '"' : singleQuoted !== undefined ? "'" : '';
      return `${prefix}${quote}[REDACTED]${quote}`;
    });
    redacted = redacted.replace(TOKEN_PATTERN, () => {
      state.redactions.push(path);
      return '[REDACTED]';
    });
    redacted = redacted.replace(/\b(https?:\/\/)[^\s/:]+:[^\s/@]+@/gi, (match, scheme) => {
      state.redactions.push(path);
      return `${scheme}[REDACTED]@`;
    });
    redacted = redacted.replace(/((?:^|\n)\s*(?:cookie|set-cookie)\s*:\s*)[^\r\n]+/gi, (match, prefix) => {
      if (match === `${prefix}[REDACTED]`) return match;
      state.redactions.push(path);
      return `${prefix}[REDACTED]`;
    });
    return redacted;
  }

  if (Array.isArray(value)) {
    return value.map((item, index) => redactValue(item, `${path}[${index}]`, state));
  }

  if (isObject(value)) {
    const result = {};
    for (const [key, child] of Object.entries(value)) {
      const childPath = path ? `${path}.${key}` : key;
      if (SECRET_KEY_PATTERN.test(key) && typeof child === 'string' && child.length > 0) {
        const alreadyRedacted = /^\[REDACTED(?::[^\]]+)?\]$/.test(child);
        if (!alreadyRedacted) state.redactions.push(childPath);
        result[key] = alreadyRedacted ? child : '[REDACTED]';
      } else {
        result[key] = redactValue(child, childPath, state);
      }
    }
    return result;
  }

  return value;
}

function prepareSnapshot(input) {
  const snapshot = cloneJson(input);
  validateSessionSnapshot(snapshot);

  const state = { redactions: [], blocked: [] };
  const redacted = redactValue(snapshot, '', state);
  validateSessionSnapshot(redacted);

  if (state.blocked.length > 0) {
    throw new SecretDetectionError(state.blocked);
  }

  return {
    snapshot: redacted,
    redactions: [...new Set(state.redactions)],
  };
}

function createSnapshotRecord(snapshot, options = {}) {
  validateSessionSnapshot(snapshot);

  const snapshotId = `snap_${Date.now().toString(36)}_${crypto.randomBytes(6).toString('hex')}`;
  const serialized = canonicalJson(snapshot);
  const access = options.access || { mode: 'local', expiresAt: null };

  return {
    manifest: {
      snapshotId,
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      status: 'published',
      createdAt: new Date().toISOString(),
      parentSnapshotId: options.parentSnapshotId || null,
      source: snapshot.source,
      repository: snapshot.workspace.repository || null,
      includedScopes: snapshotScopes(snapshot),
      redactions: options.redactions || [],
      contentHash: `sha256:${contentHash(snapshot)}`,
      contentLength: Buffer.byteLength(serialized, 'utf8'),
      access,
    },
    snapshot,
  };
}

function verifySnapshotRecord(record) {
  if (!isObject(record) || !isObject(record.manifest) || !isObject(record.snapshot)) {
    throw new Error('Invalid stored snapshot record');
  }

  validateSessionSnapshot(record.snapshot);
  if (record.manifest.schemaVersion !== SNAPSHOT_SCHEMA_VERSION ||
      !/^snap_[a-z0-9]+_[a-f0-9]+$/.test(record.manifest.snapshotId || '') ||
      canonicalJson(record.manifest.source) !== canonicalJson(record.snapshot.source) ||
      canonicalJson(record.manifest.repository) !== canonicalJson(record.snapshot.workspace.repository || null) ||
      !Array.isArray(record.manifest.redactions)) {
    throw new Error('Invalid snapshot manifest');
  }
  const actualHash = `sha256:${contentHash(record.snapshot)}`;
  if (record.manifest.contentHash !== actualHash) {
    throw new Error(`Snapshot integrity check failed for ${record.manifest.snapshotId}`);
  }

  const actualLength = Buffer.byteLength(canonicalJson(record.snapshot), 'utf8');
  if (record.manifest.contentLength !== actualLength) {
    throw new Error(`Snapshot length check failed for ${record.manifest.snapshotId}`);
  }

  return true;
}

function isSnapshotAccessible(record, now = Date.now()) {
  if (record.manifest.revokedAt) {
    return false;
  }

  const expiresAt = record.manifest.access && record.manifest.access.expiresAt;
  return !expiresAt || Date.parse(expiresAt) > now;
}

function createCloneRecord(record, targetHost = 'fixture-host') {
  verifySnapshotRecord(record);

  return {
    cloneId: `clone_${Date.now().toString(36)}_${crypto.randomBytes(6).toString('hex')}`,
    sourceSnapshotId: record.manifest.snapshotId,
    sourceContentHash: record.manifest.contentHash,
    createdAt: new Date().toISOString(),
    targetHost,
    status: 'context_imported',
    restoreMode: 'context_document',
    executionReadiness: 'not_assessed',
    readiness: { status: 'needs_adaptation', reason: 'Local tools, workspace and permissions have not been assessed.' },
    safety: {
      nativeSessionCreated: false,
      importedAsExternalContext: true,
      sourceCredentialsImported: false,
      toolsReplayed: false,
      repositoryModified: false,
    },
    session: record.snapshot,
  };
}

function snapshotScopes(snapshot) {
  const scopes = ['task-summary', 'workspace-metadata'];
  if (snapshot.events.some((event) => /user|assistant|message/.test(event.type))) scopes.push('conversation');
  if (snapshot.events.some((event) => /tool/.test(event.type))) scopes.push('tool-history');
  if (snapshot.files && snapshot.files.length) scopes.push('selected-text-files');
  if (snapshot.attachments && snapshot.attachments.length) scopes.push('selected-text-attachments');
  return scopes;
}

module.exports = {
  MAX_SNAPSHOT_BYTES,
  MAX_TEXT_BYTES,
  SNAPSHOT_SCHEMA_VERSION,
  SecretDetectionError,
  canonicalJson,
  contentHash,
  createCloneRecord,
  createSnapshotRecord,
  isSnapshotAccessible,
  prepareSnapshot,
  snapshotScopes,
  validateSessionSnapshot,
  verifySnapshotRecord,
};
