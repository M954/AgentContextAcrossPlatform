'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const fixture = require('../fixtures/sample-session.json');
const { createCloneRecord, createSnapshotRecord } = require('../src/snapshot');
const { assessSnapshot, aggregateReadiness } = require('../src/readiness');

function requirement(id, contractKey, expected, required = true) {
  return { id, kind: contractKey.split('.')[0], contractKey, required, expected };
}

function recordFor(requirements) {
  const snapshot = structuredClone(fixture);
  if (requirements !== undefined) {
    snapshot.resume.nextStep = { id: 'check-inputs', requirements };
  }
  return createSnapshotRecord(snapshot);
}

async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-context-readiness-'));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  return root;
}

for (const [label, statuses, coverage, expected] of [
  ['required available', [[true, 'available']], 'reviewed', 'ready'],
  ['required unavailable', [[true, 'unavailable']], 'reviewed', 'blocked'],
  ['required unknown', [[true, 'unknown']], 'reviewed', 'needs_adaptation'],
  ['required changed', [[true, 'changed']], 'reviewed', 'needs_adaptation'],
  ['optional unavailable', [[true, 'available'], [false, 'unavailable']], 'reviewed', 'ready_with_limitations'],
  ['optional unknown', [[true, 'available'], [false, 'unknown']], 'reviewed', 'ready_with_limitations'],
  ['optional changed', [[true, 'available'], [false, 'changed']], 'reviewed', 'ready_with_limitations'],
  ['unreviewed', [[true, 'available']], 'incomplete', 'needs_adaptation'],
  ['no requirements', [], 'reviewed', 'needs_adaptation'],
  ['known missing takes priority', [[true, 'unknown'], [true, 'unavailable']], 'incomplete', 'blocked'],
]) {
  test(`readiness aggregation: ${label}`, () => {
    const findings = statuses.map(([required, status]) => ({ required, status }));
    assert.equal(aggregateReadiness(findings, coverage), expected);
  });
}

test('the shipped readiness fixture works with the checkout and remains advisory', async () => {
  const snapshot = structuredClone(require('../fixtures/sample-readiness-session.json'));
  const record = createSnapshotRecord(snapshot);
  const report = await assessSnapshot(record, {
    workspaceRoot: path.resolve(__dirname, '..'),
    requirementsReviewed: true,
  });
  assert.equal(report.status, 'ready');
  assert.equal(report.executionAuthorized, false);
  assert.equal(report.findings.length, 2);
  assert.equal(createCloneRecord(record).executionReadiness, 'not_assessed');
});

test('network-style workspace bindings are rejected before filesystem access', async (t) => {
  t.mock.method(fs, 'realpath', async () => { throw new Error('Unexpected network path resolution'); });
  const record = recordFor([requirement('file', 'workspace.file', { relativePath: 'query.txt' })]);
  for (const workspaceRoot of ['\\\\server\\share', '//server/share', '\\\\?\\C:\\workspace']) {
    await assert.rejects(assessSnapshot(record, { workspaceRoot }), /network or device path/);
  }
});

test('legacy snapshots and empty requirement lists never imply readiness', async () => {
  for (const requirements of [undefined, []]) {
    const report = await assessSnapshot(recordFor(requirements), { requirementsReviewed: true });
    assert.equal(report.status, 'needs_adaptation');
    assert.equal(report.coverage, 'incomplete');
    assert.deepEqual(report.findings, []);
    assert.equal(report.executionAuthorized, false);
  }
});

test('runtime checks use the local bridge and require a separate coverage attestation', async () => {
  const requirements = [requirement('node', 'runtime.bridge-node', { minimumMajor: 20 })];
  const record = recordFor(requirements);
  // Source claims about readiness cannot mark the recipient's coverage as reviewed.
  record.snapshot.source.readiness = { status: 'ready', coverage: 'reviewed' };
  const source = createSnapshotRecord(record.snapshot);
  const original = structuredClone(source);
  const report = await assessSnapshot(source);
  assert.equal(report.status, 'needs_adaptation');
  assert.equal(report.coverageBasis, 'not_established');
  assert.equal(report.findings[0].status, 'available');
  assert.equal(report.findings[0].observed.nodeVersion, process.versions.node);

  const reviewed = await assessSnapshot(source, { requirementsReviewed: true });
  assert.equal(reviewed.status, 'ready');
  assert.equal(reviewed.coverageBasis, 'recipient_attestation');
  assert.equal(reviewed.executionAuthorized, false);
  assert.equal(reviewed.sourceContentHash, source.manifest.contentHash);
  assert.equal(reviewed.nextStepId, 'check-inputs');
  assert.equal(reviewed.checkMode, 'passive');
  assert.equal(reviewed.validity, 'point_in_time');
  assert.deepEqual(source, original);
  assert.equal(createCloneRecord(source).executionReadiness, 'not_assessed');
});

test('an insufficient bridge runtime is blocked', async () => {
  const record = recordFor([requirement('node', 'runtime.bridge-node', { minimumMajor: 1000 })]);
  const report = await assessSnapshot(record, { requirementsReviewed: true });
  assert.equal(report.status, 'blocked');
  assert.equal(report.findings[0].reasonCode, 'NODE_VERSION_TOO_OLD');
});

test('platform differences matter only when explicitly required', async () => {
  const expected = process.platform === 'win32' ? 'linux' : 'win32';
  const record = recordFor([requirement('os', 'runtime.bridge-platform', { platform: expected })]);
  const report = await assessSnapshot(record, { requirementsReviewed: true });
  assert.equal(report.status, 'needs_adaptation');
  assert.equal(report.findings[0].status, 'changed');
  assert.equal(report.findings[0].observed.platform, process.platform);
});

test('unknown tool and data contracts stay unknown even when source metadata claims success', async (t) => {
  const root = await workspace(t);
  const sentinel = path.join(root, 'must-not-exist');
  const record = recordFor([
    requirement('query', 'tool.titan-query', { available: true, command: `touch ${sentinel}` }),
    requirement('metrics', 'data.titan-metrics', { authorized: true, result: 'verified', module: sentinel }),
  ]);
  const report = await assessSnapshot(record, { requirementsReviewed: true });
  assert.equal(report.status, 'needs_adaptation');
  assert.ok(report.findings.every(item => item.status === 'unknown' && item.reasonCode === 'NO_VERIFIED_ADAPTER'));
  assert.equal(report.executionAuthorized, false);
  await assert.rejects(fs.lstat(sentinel), { code: 'ENOENT' });
});

test('no filesystem operations occur for a runtime-only step', async (t) => {
  t.mock.method(fs, 'realpath', async () => { throw new Error('Unexpected workspace access'); });
  t.mock.method(fs, 'lstat', async () => { throw new Error('Unexpected file access'); });
  const report = await assessSnapshot(recordFor([
    requirement('node', 'runtime.bridge-node', { minimumMajor: 20 }),
  ]), { workspaceRoot: 'unused-directory', requirementsReviewed: true });
  assert.equal(report.status, 'ready');
});

test('file checks require an explicitly selected recipient workspace', async () => {
  const record = recordFor([requirement('query', 'workspace.file', { relativePath: 'query.txt' })]);
  const report = await assessSnapshot(record, { requirementsReviewed: true });
  assert.equal(report.status, 'needs_adaptation');
  assert.equal(report.findings[0].reasonCode, 'WORKSPACE_NOT_SELECTED');
});

test('file presence is checked without reading contents or modifying the workspace', async (t) => {
  const root = await workspace(t);
  await fs.writeFile(path.join(root, 'query.txt'), 'SYNTHETIC_FILE_CONTENT');
  t.mock.method(fs, 'readFile', async () => { throw new Error('File contents must not be read'); });
  const report = await assessSnapshot(recordFor([
    requirement('query', 'workspace.file', { relativePath: 'query.txt' }),
  ]), { workspaceRoot: root, requirementsReviewed: true });
  assert.equal(report.status, 'ready');
  assert.equal(report.findings[0].reasonCode, 'FILE_PRESENT');
  assert.equal(report.findings[0].observed.relativePath, 'query.txt');
  assert.equal(JSON.stringify(report).includes('SYNTHETIC_FILE_CONTENT'), false);
  assert.equal(JSON.stringify(report).includes(root), false);
  assert.deepEqual(await fs.readdir(root), ['query.txt']);
});

test('a nonexistent workspace or directory in place of a file is not ready', async (t) => {
  const root = await workspace(t);
  const record = recordFor([requirement('file', 'workspace.file', { relativePath: 'query.txt' })]);
  const missingRoot = path.join(root, 'absent');
  const missing = await assessSnapshot(record, { workspaceRoot: missingRoot, requirementsReviewed: true });
  assert.equal(missing.status, 'blocked');
  assert.equal(missing.findings[0].reasonCode, 'WORKSPACE_NOT_FOUND');
  await assert.rejects(fs.lstat(missingRoot), { code: 'ENOENT' });

  await fs.mkdir(path.join(root, 'query.txt'));
  const directory = await assessSnapshot(record, { workspaceRoot: root, requirementsReviewed: true });
  assert.equal(directory.status, 'blocked');
  assert.equal(directory.findings[0].reasonCode, 'NOT_REGULAR_FILE');
});

test('a missing required file blocks, while a missing optional file only limits readiness', async (t) => {
  const root = await workspace(t);
  for (const required of [true, false]) {
    const report = await assessSnapshot(recordFor([
      requirement('node', 'runtime.bridge-node', { minimumMajor: 20 }),
      requirement('query', 'workspace.file', { relativePath: 'missing.txt' }, required),
    ]), { workspaceRoot: root, requirementsReviewed: true });
    assert.equal(report.status, required ? 'blocked' : 'ready_with_limitations');
    assert.equal(report.findings[1].reasonCode, 'FILE_NOT_FOUND');
    assert.deepEqual(await fs.readdir(root), []);
  }
});

for (const relativePath of [
  '../outside.txt', '/etc/passwd', 'C:\\outside.txt', '\\\\server\\share\\secret',
  'file.txt:stream', 'folder/../file.txt', '.env', '.env.local', '.ssh/id_rsa',
  'folder/private.pem', 'credentials.json', 'NUL', 'folder./file.txt',
]) {
  test(`unsafe or sensitive file paths are not inspected: ${relativePath}`, async (t) => {
    const root = await workspace(t);
    t.mock.method(fs, 'lstat', async () => { throw new Error('Unsafe file path was inspected'); });
    const report = await assessSnapshot(recordFor([
      requirement('file', 'workspace.file', { relativePath }),
    ]), { workspaceRoot: root, requirementsReviewed: true });
    assert.equal(report.status, 'needs_adaptation');
    assert.equal(report.findings[0].reasonCode, 'PATH_NOT_ALLOWED');
  });
}

test('directory symlinks or Windows junctions cannot redirect a file check', async (t) => {
  const root = await workspace(t);
  const outside = await workspace(t);
  await fs.writeFile(path.join(outside, 'file.txt'), 'outside');
  try {
    await fs.symlink(outside, path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'ENOTSUP') {
      t.skip('Symlink creation is not available on this machine');
      return;
    }
    throw error;
  }
  const report = await assessSnapshot(recordFor([
    requirement('file', 'workspace.file', { relativePath: 'link/file.txt' }),
  ]), { workspaceRoot: root, requirementsReviewed: true });
  assert.equal(report.findings[0].reasonCode, 'LINK_NOT_ALLOWED');
  assert.equal(report.status, 'needs_adaptation');
});

test('file metadata errors stay unknown rather than becoming a successful check', async (t) => {
  const root = await workspace(t);
  t.mock.method(fs, 'lstat', async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); });
  const report = await assessSnapshot(recordFor([
    requirement('file', 'workspace.file', { relativePath: 'query.txt' }),
  ]), { workspaceRoot: root, requirementsReviewed: true });
  assert.equal(report.findings[0].reasonCode, 'FILE_CHECK_FAILED');
  assert.equal(report.findings[0].status, 'unknown');
  assert.equal(report.status, 'needs_adaptation');
});

test('new assessments reflect changed environment facts without changing the snapshot', async (t) => {
  const root = await workspace(t);
  const record = recordFor([requirement('file', 'workspace.file', { relativePath: 'query.txt' })]);
  const options = { workspaceRoot: root, requirementsReviewed: true };
  const missing = await assessSnapshot(record, options);
  await fs.writeFile(path.join(root, 'query.txt'), 'new');
  const present = await assessSnapshot(record, options);
  assert.equal(missing.status, 'blocked');
  assert.equal(present.status, 'ready');
  assert.notEqual(missing.environmentFingerprint, present.environmentFingerprint);
  assert.equal(missing.requirementsDigest, present.requirementsDigest);
  assert.equal(missing.sourceContentHash, present.sourceContentHash);
});

test('malformed requirement declarations are rejected rather than dropped', () => {
  const valid = requirement('node', 'runtime.bridge-node', { minimumMajor: 20 });
  for (const requirements of [
    [{ ...valid, required: 'false' }],
    [{ ...valid, expected: { minimumMajor: '20' } }],
    [{ ...valid, expected: { minimumMajor: 20, available: true } }],
    [{ ...valid, kind: 'tool' }],
    [{ ...valid, contractKey: '../arbitrary-module' }],
    [valid, valid],
    Array.from({ length: 65 }, (_, index) => ({ ...valid, id: `node-${index}` })),
  ]) {
    assert.throws(() => recordFor(requirements), /Invalid next-step requirements/);
  }
});

test('tampering and invalid local options are rejected', async () => {
  const record = recordFor([requirement('node', 'runtime.bridge-node', { minimumMajor: 20 })]);
  await assert.rejects(assessSnapshot(record, { requirementsReviewed: 'true' }), /must be a boolean/);
  await assert.rejects(assessSnapshot(record, { workspaceRoot: true }), /must be a non-empty/);
  record.snapshot.resume.nextStep.requirements[0].expected.minimumMajor = 1000;
  await assert.rejects(assessSnapshot(record), /integrity check failed/);
});
