'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const fixture = require('../fixtures/sample-session.json');
const {
  createCloneRecord,
  createSnapshotRecord,
  prepareSnapshot,
} = require('../src/snapshot');

function makeSnapshot(content) {
  const snapshot = structuredClone(fixture);
  snapshot.events[1].content = content;
  return snapshot;
}

for (const key of [
  'password',
  'API_KEY',
  'api-key',
  'access_token',
  'refresh-token',
  'client_secret',
  'private_key',
]) {
  test(`removes the entire inline ${key} value`, () => {
    const secret = 'SYNTHETIC_VALUE_ONLY';
    const snapshot = makeSnapshot(`before ${key}=${secret}; after`);
    const original = structuredClone(snapshot);
    const prepared = prepareSnapshot(snapshot);

    assert.equal(prepared.snapshot.events[1].content, `before ${key}=[REDACTED]; after`);
    assert.equal(JSON.stringify(prepared).includes(secret), false);
    assert.deepEqual(prepared.redactions, ['events[1].content']);
    assert.deepEqual(snapshot, original, 'preparation must not mutate the source record');
  });
}

test('redacts multiple inline values while preserving unrelated text', () => {
  const secrets = ['SYNTHETIC_FIRST', 'SYNTHETIC_SECOND', 'SYNTHETIC_THIRD'];
  const prepared = prepareSnapshot(
    makeSnapshot(`password: ${secrets[0]}, api_key=${secrets[1]};\naccess_token = ${secrets[2]} done`),
  );

  assert.equal(
    prepared.snapshot.events[1].content,
    'password: [REDACTED], api_key=[REDACTED];\naccess_token = [REDACTED] done',
  );
  for (const secret of secrets) {
    assert.equal(JSON.stringify(prepared).includes(secret), false);
  }
  assert.deepEqual(prepared.redactions, ['events[1].content']);
});

for (const [label, content, expected, secretParts] of [
  [
    'double-quoted values with spaces',
    'password="SYNTHETIC_PREFIX SYNTHETIC_SUFFIX"; keep this',
    'password="[REDACTED]"; keep this',
    ['SYNTHETIC_PREFIX', 'SYNTHETIC_SUFFIX'],
  ],
  [
    'single-quoted values with separators',
    "client_secret='SYNTHETIC_PREFIX, SYNTHETIC_SUFFIX'; keep this",
    "client_secret='[REDACTED]'; keep this",
    ['SYNTHETIC_PREFIX', 'SYNTHETIC_SUFFIX'],
  ],
  [
    'JSON-formatted log messages with escaped quotes',
    JSON.stringify({ password: 'SYNTHETIC_PREFIX "SYNTHETIC_SUFFIX"', count: 3 }),
    JSON.stringify({ password: '[REDACTED]', count: 3 }),
    ['SYNTHETIC_PREFIX', 'SYNTHETIC_SUFFIX'],
  ],
]) {
  test(`redacts ${label}`, () => {
    const prepared = prepareSnapshot(makeSnapshot(content));
    assert.equal(prepared.snapshot.events[1].content, expected);
    for (const secretPart of secretParts) {
      assert.equal(JSON.stringify(prepared).includes(secretPart), false);
    }
  });
}

for (const content of [
  'password="SYNTHETIC_PREFIX SYNTHETIC_SUFFIX',
  "password='SYNTHETIC_PREFIX SYNTHETIC_SUFFIX",
  'password="SYNTHETIC_PREFIX \\"SYNTHETIC_SUFFIX\\"',
]) {
  test(`blocks incomplete quoted credentials: ${JSON.stringify(content)}`, () => {
    assert.throws(() => prepareSnapshot(makeSnapshot(content)), (error) => {
      assert.equal(error.name, 'SecretDetectionError');
      assert.equal(error.message.includes('SYNTHETIC_'), false);
      return true;
    });
  });
}

test('redacts nested tool arguments, results, arrays, and attachment text', () => {
  const snapshot = makeSnapshot('An unrelated result.');
  const secrets = ['SYNTHETIC_KEY', 'SYNTHETIC_LOG', 'SYNTHETIC_ATTACHMENT'];
  snapshot.events[0].arguments = { access_token: secrets[0] };
  snapshot.events[1].results = [{ text: `password=${secrets[1]}` }];
  snapshot.attachments = [{ text: `api_key=${secrets[2]}` }];
  const prepared = prepareSnapshot(snapshot);

  for (const secret of secrets) {
    assert.equal(JSON.stringify(prepared).includes(secret), false);
  }
  assert.deepEqual(prepared.redactions, [
    'events[0].arguments.access_token',
    'events[1].results[0].text',
    'attachments[0].text',
  ]);
});

test('redaction is stable when the CLI and service both prepare a snapshot', () => {
  const first = prepareSnapshot(makeSnapshot('password=SYNTHETIC_ONE; api_key="SYNTHETIC TWO"'));
  const second = prepareSnapshot(first.snapshot);
  assert.deepEqual(second.snapshot, first.snapshot);
});

for (const [label, secret] of [
  ['bearer token', 'Bearer SYNTHETIC_BEARER_ONLY'],
  ['private key', '-----BEGIN PRIVATE KEY-----\nSYNTHETIC_KEY_ONLY\n-----END PRIVATE KEY-----'],
]) {
  test(`blocks an embedded ${label} without echoing its value`, () => {
    assert.throws(() => prepareSnapshot(makeSnapshot(secret)), (error) => {
      assert.equal(error.name, 'SecretDetectionError');
      assert.match(error.message, /Publication blocked/);
      assert.equal(error.message.includes(secret), false);
      return true;
    });
  });
}

test('clone output is a context document, not a ready native session', () => {
  const snapshot = makeSnapshot('A historical result, not a local capability check.');
  snapshot.requiredCapabilities = ['unavailable-data-source'];
  const record = createSnapshotRecord(snapshot);
  const original = structuredClone(record);
  const clone = createCloneRecord(record, 'requested-host-label');

  assert.equal(clone.status, 'context_imported');
  assert.equal(clone.restoreMode, 'context_document');
  assert.equal(clone.executionReadiness, 'not_assessed');
  assert.equal(clone.safety.nativeSessionCreated, false);
  assert.equal(clone.safety.toolsReplayed, false);
  assert.equal(clone.safety.repositoryModified, false);
  assert.equal(clone.sourceSnapshotId, record.manifest.snapshotId);
  assert.deepEqual(clone.session, snapshot);
  assert.deepEqual(record, original);
});

test('refuses to create a context document from a tampered record', () => {
  const record = createSnapshotRecord(makeSnapshot('Original result.'));
  record.snapshot.events[1].content = 'Changed after hashing.';
  assert.throws(() => createCloneRecord(record), /integrity check failed/);
});
