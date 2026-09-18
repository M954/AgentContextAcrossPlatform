'use strict';

const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const test = require('node:test');
const fixture = require('../fixtures/sample-session.json');
const { startServer } = require('../src/server');
const { createSnapshotRecord } = require('../src/snapshot');
const { HandoffWorkflow } = require('../src/workflow');
const { validateConfig } = require('../src/config');
const execFileAsync = promisify(execFile);
const cliPath = path.resolve(__dirname, '..', 'src', 'cli.js');

async function runCli(context, args) {
  try {
    const result = await execFileAsync(process.execPath, [cliPath, ...args], {
      cwd: context.directory, timeout: 60000, maxBuffer: 1024 * 1024,
      env: { ...process.env, AGENT_CONTEXT_HOME: context.stateDir, SESSION_SERVICE_URL: context.service.url },
    });
    return { code: 0, ...result };
  } catch (error) {
    if (typeof error.code !== 'number') throw error;
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

async function setup(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-context-cli-'));
  const stateDir = path.join(directory, 'private-client');
  const service = await startServer({ port: 0, dataDir: path.join(directory, 'store') });
  t.after(async () => {
    await new Promise((resolve, reject) => service.server.close((error) => error ? reject(error) : resolve()));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  const snapshot = structuredClone(fixture);
  const sentinel = path.join(directory, 'must-not-be-created.txt');
  snapshot.events.push({
    eventId: 'external-command', type: 'tool_request', timestamp: '2026-09-17T00:00:00.000Z',
    arguments: { command: `${process.execPath} -e ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'unsafe')`)}` },
  });
  const record = createSnapshotRecord(snapshot);
  await service.store.save(record);
  const flow = new HandoffWorkflow({ config: validateConfig(), stateDir, auth: {}, localUrl: service.url });
  return { directory, stateDir, service, record, flow, sentinel,
    link: `${service.url}/v1/snapshots/${record.manifest.snapshotId}` };
}

async function assertMissing(file) { await assert.rejects(fs.lstat(file), { code: 'ENOENT' }); }

for (const command of ['resume', 'clone']) {
  test(`${command} previews without creating an import or replaying commands`, async (t) => {
    const context = await setup(t);
    const result = await runCli(context, [command, context.link]);
    assert.equal(result.code, 0, result.stderr);
    const preview = JSON.parse(result.stdout);
    assert.equal(preview.status, 'inspectable');
    assert.equal(preview.snapshotId, context.record.manifest.snapshotId);
    assert.equal(preview.restoreMode, 'context_document');
    assert.equal(preview.executionReadiness, 'not_assessed');
    await assertMissing(path.join(context.stateDir, 'imports'));
    await assertMissing(context.sentinel);
  });

  test(`${command} cannot write in a noninteractive process even with a valid review`, async (t) => {
    const context = await setup(t);
    const preview = JSON.parse((await runCli(context, [command, context.link])).stdout);
    const result = await runCli(context, [command, '--review', preview.reviewId]);
    assert.equal(result.code, 1);
    assert.match(JSON.parse(result.stderr).error, /Interactive approval/);
    await assertMissing(path.join(context.stateDir, 'imports'));
    await assertMissing(context.sentinel);
  });
}

for (const args of [['--approve'], ['--approve', 'false'], ['--approve', 'true'], ['--yes']]) {
  test(`old approval syntax ${args.join(' ')} cannot authorize writes`, async (t) => {
    const context = await setup(t);
    const result = await runCli(context, ['resume', context.link, ...args]);
    assert.equal(result.code, 1);
    await assertMissing(path.join(context.stateDir, 'imports'));
    await assertMissing(context.sentinel);
  });
}

test('arbitrary output overrides cannot overwrite existing files', async (t) => {
  const context = await setup(t);
  const output = path.join(context.directory, 'existing.json');
  await fs.writeFile(output, 'Original user data');
  const result = await runCli(context, ['resume', context.link, '--output', output]);
  assert.equal(result.code, 1);
  assert.equal(await fs.readFile(output, 'utf8'), 'Original user data');
});

test('reviewed context import retains no-overwrite and unassessed execution metadata', async (t) => {
  const context = await setup(t);
  const preview = JSON.parse((await runCli(context, ['resume', context.link])).stdout);
  const imported = await context.flow.complete(preview.reviewId, 'import', async () => true);
  assert.equal(imported.status, 'context_imported');
  assert.equal(imported.executionReadiness, 'not_assessed');
  assert.equal(imported.safety.nativeSessionCreated, false);
  assert.equal(imported.sourceContentHash, context.record.manifest.contentHash);
  const before = await fs.readFile(imported.bundlePath, 'utf8');
  const replay = await context.flow.complete(preview.reviewId, 'import', async () => true);
  assert.equal(replay.cloneId, imported.cloneId);
  assert.equal(await fs.readFile(imported.bundlePath, 'utf8'), before);
  await assertMissing(context.sentinel);
});

test('tampered content is rejected before creating an import', async (t) => {
  const context = await setup(t);
  context.record.snapshot.events[0].content = 'Changed after publication';
  await fs.writeFile(context.service.store.filePath(context.record.manifest.snapshotId), JSON.stringify(context.record));
  const result = await runCli(context, ['resume', context.link]);
  assert.equal(result.code, 1);
  await assertMissing(path.join(context.stateDir, 'imports'));
});

test('CLI preparation removes secrets and only publishes after trusted review approval', async (t) => {
  const context = await setup(t);
  const snapshot = structuredClone(fixture);
  const secret = 'SYNTHETIC_CLI_VALUE';
  snapshot.events[1].content = `password="${secret} with spaces"`;
  const input = path.join(context.directory, 'input.json');
  await fs.writeFile(input, JSON.stringify(snapshot));
  const before = await fs.readdir(context.service.store.snapshotsDir);
  const result = await runCli(context, ['share', '--provider', 'local', '--input', input]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.includes(secret), false);
  assert.equal(result.stderr.includes(secret), false);
  const review = JSON.parse(result.stdout);
  assert.equal(review.status, 'review-required');
  assert.deepEqual(await fs.readdir(context.service.store.snapshotsDir), before);
  const previewBytes = await fs.readFile(review.previewPath, 'utf8');
  assert.equal(previewBytes.includes(secret), false);
  const publication = await context.flow.complete(review.reviewId, 'publish', async () => true);
  const disk = await fs.readFile(context.service.store.filePath(publication.snapshotId), 'utf8');
  assert.equal(disk.includes(secret), false);
});

test('native import target is selected during inspection and cannot be replaced at completion', { timeout: 120000 }, async t => {
  const context = await setup(t);
  const result = await runCli(context, ['inspect', context.link, '--target', 'pi', '--workspace', context.directory]);
  assert.equal(result.code, 0, result.stderr);
  const draft = JSON.parse(result.stdout);
  assert.equal(draft.plannedRestoreMode, 'native_session');
  assert.equal(draft.importTarget.target, 'pi');
  assert.equal(draft.importTarget.workspace.path, await fs.realpath(context.directory));
  await assertMissing(draft.importTarget.directory);
  const changed = await runCli(context, ['resume', '--review', draft.reviewId, '--target', 'copilot', '--workspace', context.directory]);
  assert.equal(changed.code, 1);
  assert.match(changed.stderr, /Cannot change a reviewed import/);
  const noninteractive = await runCli(context, ['resume', '--review', draft.reviewId]);
  assert.equal(noninteractive.code, 1);
  assert.match(noninteractive.stderr, /Interactive approval/);
  await assertMissing(draft.importTarget.directory);
});

test('CLI auto-detects pi capture without weakening snapshot validation or publication approval', { timeout: 120000 }, async t => {
  const context = await setup(t);
  const input = path.resolve(__dirname, '..', 'fixtures', 'pi-coding-session.jsonl');
  const prepared = await runCli(context, ['share', '--provider', 'local', '--input', input]);
  assert.equal(prepared.code, 0, prepared.stderr);
  const draft = JSON.parse(prepared.stdout);
  const review = JSON.parse(await fs.readFile(draft.previewPath, 'utf8'));
  assert.equal(review.plan.bundle.record.snapshot.source.host, 'pi');
  assert.equal(review.plan.bundle.record.snapshot.capture, undefined);
  assert.equal(review.plan.bundle.record.snapshot.source.capture.leafId, 'user0002');
  assert.equal(JSON.stringify(review).includes('SYNTHETIC_ABANDONED'), false);
  assert.equal(JSON.stringify(review).includes('SYNTHETIC_PRIVATE'), false);
  const blocked = await runCli(context, ['share', '--review', draft.reviewId, '--approve']);
  assert.equal(blocked.code, 1);
});

test('share --approve false cannot publish, and review parameters cannot be replaced', async (t) => {
  const context = await setup(t);
  const input = path.join(context.directory, 'input.json');
  await fs.writeFile(input, JSON.stringify(fixture));
  const before = await fs.readdir(context.service.store.snapshotsDir);
  const blocked = await runCli(context, ['share', '--provider', 'local', '--input', input, '--approve', 'false']);
  assert.equal(blocked.code, 1);
  assert.deepEqual(await fs.readdir(context.service.store.snapshotsDir), before);
  const draft = JSON.parse((await runCli(context, ['share', '--provider', 'local', '--input', input])).stdout);
  const changed = await runCli(context, ['share', '--review', draft.reviewId, '--to', 'other@example.test']);
  assert.equal(changed.code, 1);
  assert.match(changed.stderr, /Cannot change/);
  assert.deepEqual(await fs.readdir(context.service.store.snapshotsDir), before);
});
