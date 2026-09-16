'use strict';

const crypto = require('node:crypto');

const SNAPSHOT_SCHEMA_VERSION = '1.0';
const MAX_EVENT_COUNT = 5000;

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
  return JSON.parse(JSON.stringify(value));
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
  if (!isObject(snapshot)) {
    invalid('', 'expected an object');
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

  return snapshot;
}

const SECRET_KEY_PATTERN =
  /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|private[_-]?key|authorization)/i;
const INLINE_SECRET_PATTERN =
  /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|private[_-]?key)\s*[:=]\s*)([^\s,;]+)/gi;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/g;
const PRIVATE_KEY_PATTERN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;

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

    redacted = redacted.replace(INLINE_SECRET_PATTERN, (prefix) => {
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
        state.redactions.push(childPath);
        result[key] = `[REDACTED:${key}]`;
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
      includedScopes: options.includedScopes || [
        'conversation',
        'tool-history',
        'task-summary',
        'workspace-metadata',
      ],
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
    createdAt: new Date().toISOString(),
    targetHost,
    status: 'ready',
    safety: {
      importedAsExternalContext: true,
      sourceCredentialsImported: false,
      toolsReplayed: false,
      repositoryModified: false,
    },
    session: record.snapshot,
  };
}

module.exports = {
  SNAPSHOT_SCHEMA_VERSION,
  SecretDetectionError,
  canonicalJson,
  contentHash,
  createCloneRecord,
  createSnapshotRecord,
  isSnapshotAccessible,
  prepareSnapshot,
  validateSessionSnapshot,
  verifySnapshotRecord,
};
