'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { prepareSnapshot, contentHash, validateSessionSnapshot } = require('../src/snapshot');
const { createBundle, verifyBundle } = require('../src/bundle');
const fixture = require('../fixtures/sample-session.json');

test('redaction removes inline secrets instead of appending a marker to the original match', () => {
  for (const content of [
    'password=SYNTHETIC_VALUE', 'api_key: SYNTHETIC_VALUE', 'password="SYNTHETIC_VALUE with spaces"',
    "client_secret='SYNTHETIC_VALUE with spaces'", 'https://example.test?q=x&sig=SYNTHETIC_VALUE&rest=1',
    'https://user:SYNTHETIC_VALUE@example.test/', 'Cookie: auth=SYNTHETIC_VALUE; other=1',
  ]) {
    const input = structuredClone(fixture);
    input.events[0].content = content;
    const prepared = prepareSnapshot(input);
    assert.ok(!JSON.stringify(prepared.snapshot).includes('SYNTHETIC_VALUE'));
    assert.ok(prepared.redactions.length);
    const again = prepareSnapshot(prepared.snapshot);
    assert.equal(again.redactions.length, 0);
    assert.equal(contentHash(again.snapshot), contentHash(prepared.snapshot));
  }
});

test('secret object fields are redacted and standalone bearer or private keys block', () => {
  const input = structuredClone(fixture);
  input.events[0].arguments = { access_token: 'SYNTHETIC_VALUE' };
  const prepared = prepareSnapshot(input);
  assert.ok(!JSON.stringify(prepared.snapshot).includes('SYNTHETIC_VALUE'));
  for (const content of ['Bearer SYNTHETIC_VALUE', '-----BEGIN PRIVATE KEY-----']) {
    input.events[0].content = content;
    assert.throws(() => prepareSnapshot(input), /Publication blocked/);
  }
});

test('prefixed and camelCase credential fields keep the original redaction coverage', () => {
  for (const key of ['DATABASE_PASSWORD', 'AZURE_CLIENT_SECRET', 'dbPassword', 'my_api_key', 'clientSecret', 'storageAccountKey']) {
    const input = structuredClone(fixture);
    input.events[0].arguments = { [key]: 'SYNTHETIC_VALUE' };
    const prepared = prepareSnapshot(input);
    assert.equal(prepared.redactions.length, 1, key);
    assert.ok(!JSON.stringify(createBundle(input)).includes('SYNTHETIC_VALUE'), key);
  }
});

test('bounded structure, unsafe properties and duplicate records are rejected', () => {
  const input = structuredClone(fixture);
  input.events.push(input.events[0]);
  assert.throws(() => validateSessionSnapshot(input), /duplicate/);
  assert.throws(() => prepareSnapshot(JSON.parse('{"__proto__":{}}')), /unsafe/);
  assert.throws(() => prepareSnapshot({ ...fixture, attachments: [{ bytes: 'opaque' }] }), /unsupported/);
  input.events[0].content = 'x'.repeat(128 * 1024 + 1);
  assert.throws(() => prepareSnapshot(input), /size limit/);
});

test('bundle holds selected text files and refuses sensitive or nonportable paths', () => {
  const input = structuredClone(fixture);
  input.files = [{ path: 'queries/example.sql', encoding: 'utf8', content: 'select 1;' }];
  const bundle = createBundle(input);
  assert.equal(verifyBundle(bundle).record.snapshot.files.length, 1);
  for (const unsafe of ['../outside.sql', '.env.json', '.ssh/key.txt', 'file.json:stream',
    'C:/file.json', 'con.txt', 'path\\file.txt', 'data.exe']) {
    input.files[0].path = unsafe;
    assert.throws(() => createBundle(input));
  }
});

test('import refuses secret-like fields even when an attacker recomputes the snapshot hash', () => {
  const bundle = createBundle(fixture);
  bundle.record.snapshot.events[0].content = 'password=SYNTHETIC_VALUE';
  const { canonicalJson } = require('../src/snapshot');
  bundle.record.manifest.contentHash = `sha256:${contentHash(bundle.record.snapshot)}`;
  bundle.record.manifest.contentLength = Buffer.byteLength(canonicalJson(bundle.record.snapshot));
  assert.throws(() => verifyBundle(bundle), /secret-like/);
});
