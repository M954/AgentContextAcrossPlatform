'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  prepareSnapshot, contentHash, canonicalJson, validateSessionSnapshot, createCloneRecord, createSnapshotRecord,
} = require('../src/snapshot');
const { createBundle, verifyBundle } = require('../src/bundle');
const fixture = require('../fixtures/sample-session.json');

function makeSnapshot(content) {
  const snapshot = structuredClone(fixture);
  snapshot.events[1].content = content;
  return snapshot;
}

for (const key of ['password', 'API_KEY', 'api-key', 'access_token', 'refresh-token', 'client_secret', 'private_key']) {
  test(`removes the entire inline ${key} value without mutating the source`, () => {
    const secret = 'SYNTHETIC_VALUE_ONLY';
    const snapshot = makeSnapshot(`before ${key}=${secret}; after`);
    const original = structuredClone(snapshot);
    const prepared = prepareSnapshot(snapshot);
    assert.equal(prepared.snapshot.events[1].content, `before ${key}=[REDACTED]; after`);
    assert.equal(JSON.stringify(prepared).includes(secret), false);
    assert.deepEqual(prepared.redactions, ['events[1].content']);
    assert.deepEqual(snapshot, original);
  });
}

test('redacts multiple inline values while preserving unrelated text', () => {
  const secrets = ['SYNTHETIC_FIRST', 'SYNTHETIC_SECOND', 'SYNTHETIC_THIRD'];
  const prepared = prepareSnapshot(makeSnapshot(
    `password: ${secrets[0]}, api_key=${secrets[1]};\naccess_token = ${secrets[2]} done`));
  assert.equal(prepared.snapshot.events[1].content,
    'password: [REDACTED], api_key=[REDACTED];\naccess_token = [REDACTED] done');
  for (const secret of secrets) assert.equal(JSON.stringify(prepared).includes(secret), false);
});

for (const [name, text, expected] of [
  ['quoted spaces', 'password="SYNTHETIC_PREFIX SYNTHETIC_SUFFIX"; keep', 'password="[REDACTED]"; keep'],
  ['quoted separators', "client_secret='SYNTHETIC_PREFIX, SYNTHETIC_SUFFIX'; keep", "client_secret='[REDACTED]'; keep"],
  ['escaped JSON quotes', JSON.stringify({ password: 'SYNTHETIC_PREFIX "SYNTHETIC_SUFFIX"', count: 3 }),
    JSON.stringify({ password: '[REDACTED]', count: 3 })],
]) {
  test(`redacts ${name}`, () => {
    const prepared = prepareSnapshot(makeSnapshot(text));
    assert.equal(prepared.snapshot.events[1].content, expected);
    assert.equal(JSON.stringify(prepared).includes('SYNTHETIC_'), false);
  });
}

for (const [index, text] of [
  'password="SYNTHETIC_PREFIX SYNTHETIC_SUFFIX',
  "password='SYNTHETIC_PREFIX SYNTHETIC_SUFFIX",
  'password="SYNTHETIC_PREFIX \\"SYNTHETIC_SUFFIX\\"',
].entries()) {
  test(`blocks incomplete quoted credential case ${index + 1}`, () => {
    assert.throws(() => prepareSnapshot(makeSnapshot(text)), (error) =>
      error.name === 'SecretDetectionError' && !error.message.includes('SYNTHETIC_'));
  });
}

test('redacts nested arguments, results, arrays and explicitly supplied text attachments', () => {
  const input = makeSnapshot('Unrelated result');
  input.events[0].arguments = { access_token: 'SYNTHETIC_KEY' };
  input.events[1].results = [{ text: 'password=SYNTHETIC_LOG' }];
  input.attachments = [{ text: 'api_key=SYNTHETIC_ATTACHMENT' }];
  const prepared = prepareSnapshot(input);
  assert.equal(JSON.stringify(prepared).includes('SYNTHETIC_'), false);
  assert.deepEqual(prepared.redactions, ['events[0].arguments.access_token',
    'events[1].results[0].text', 'attachments[0].text']);
});

test('inline, URL and cookie redaction is idempotent through client and service', () => {
  for (const content of ['password=SYNTHETIC_VALUE', 'api_key: SYNTHETIC_VALUE',
    'password="SYNTHETIC_VALUE with spaces"', "client_secret='SYNTHETIC_VALUE with spaces'",
    'https://example.test?q=x&sig=SYNTHETIC_VALUE&rest=1',
    'https://user:SYNTHETIC_VALUE@example.test/', 'Cookie: auth=SYNTHETIC_VALUE; other=1']) {
    const prepared = prepareSnapshot(makeSnapshot(content));
    assert.ok(!JSON.stringify(prepared.snapshot).includes('SYNTHETIC_VALUE'));
    assert.ok(prepared.redactions.length);
    const again = prepareSnapshot(prepared.snapshot);
    assert.equal(again.redactions.length, 0);
    assert.equal(contentHash(again.snapshot), contentHash(prepared.snapshot));
  }
});

test('prefixed and camelCase credential fields keep the original redaction coverage', () => {
  for (const key of ['DATABASE_PASSWORD', 'AZURE_CLIENT_SECRET', 'dbPassword', 'my_api_key', 'clientSecret', 'storageAccountKey']) {
    const input = structuredClone(fixture);
    input.events[0].arguments = { [key]: 'SYNTHETIC_VALUE' };
    assert.equal(prepareSnapshot(input).redactions.length, 1, key);
    assert.ok(!JSON.stringify(createBundle(input)).includes('SYNTHETIC_VALUE'), key);
  }
});

for (const [name, content] of [
  ['bearer', 'Bearer SYNTHETIC_TOKEN_ONLY'], ['basic', 'Basic SYNTHETIC_VALUE'],
  ['private key', '-----BEGIN PRIVATE KEY-----\nSYNTHETIC_KEY_ONLY\n-----END PRIVATE KEY-----'],
]) {
  test(`blocks embedded ${name} credentials without echoing the value`, () => {
    assert.throws(() => prepareSnapshot(makeSnapshot(content)), (error) =>
      error.name === 'SecretDetectionError' && /Publication blocked/.test(error.message) &&
      !error.message.includes('SYNTHETIC_'));
  });
}

test('bounded structure, unsafe properties, unsupported attachments and duplicate events are rejected', () => {
  const input = structuredClone(fixture);
  input.events.push(input.events[0]);
  assert.throws(() => validateSessionSnapshot(input), /duplicate/);
  assert.throws(() => prepareSnapshot(JSON.parse('{"__proto__":{}}')), /unsafe/);
  assert.throws(() => prepareSnapshot({ ...fixture, attachments: [{ bytes: 'opaque' }] }), /attachment text/);
  input.events[0].content = 'x'.repeat(128 * 1024 + 1);
  assert.throws(() => prepareSnapshot(input), /size limit/);
});

test('bundle holds selected text files and refuses sensitive or nonportable paths', () => {
  const input = structuredClone(fixture);
  input.files = [{ path: 'queries/example.sql', encoding: 'utf8', content: 'select 1;' }];
  assert.equal(verifyBundle(createBundle(input)).record.snapshot.files.length, 1);
  for (const unsafe of ['../outside.sql', '.env.json', '.ssh/key.txt', 'file.json:stream',
    'C:/file.json', 'con.txt', 'path\\file.txt', 'data.exe']) {
    input.files[0].path = unsafe;
    assert.throws(() => createBundle(input));
  }
});

test('import refuses secrets even when a sender recomputes the snapshot hash', () => {
  const bundle = createBundle(fixture);
  bundle.record.snapshot.events[0].content = 'password=SYNTHETIC_VALUE';
  bundle.record.manifest.contentHash = `sha256:${contentHash(bundle.record.snapshot)}`;
  bundle.record.manifest.contentLength = Buffer.byteLength(canonicalJson(bundle.record.snapshot));
  assert.throws(() => verifyBundle(bundle), /secret-like/);
});

test('clone output is a context document, never a ready native session', () => {
  const snapshot = makeSnapshot('Historical result, not a local capability check');
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
  assert.equal(clone.sourceContentHash, record.manifest.contentHash);
  assert.deepEqual(clone.session, snapshot);
  assert.deepEqual(record, original);
});

test('refuses a tampered context record', () => {
  const record = createSnapshotRecord(makeSnapshot('Original result'));
  record.snapshot.events[1].content = 'Changed after hashing';
  assert.throws(() => createCloneRecord(record), /integrity check failed/);
});
