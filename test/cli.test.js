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

const execFileAsync = promisify(execFile);
const cliPath = path.resolve(__dirname, '..', 'src', 'cli.js');

async function runCli(cwd, args) {
  try {
    const result = await execFileAsync(process.execPath, [cliPath, ...args], {
      cwd,
      timeout: 10000,
      maxBuffer: 1024 * 1024,
    });
    return { code: 0, ...result };
  } catch (error) {
    if (typeof error.code !== 'number') {
      throw error;
    }
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

async function setup(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-context-cli-'));
  let service;
  t.after(async () => {
    if (service) {
      await new Promise((resolve, reject) => {
        service.server.close((error) => error ? reject(error) : resolve());
      });
    }
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  service = await startServer({ port: 0, dataDir: path.join(directory, 'store') });

  const snapshot = structuredClone(fixture);
  const sentinel = path.join(directory, 'must-not-be-created.txt');
  snapshot.events.push({
    eventId: 'external-command',
    type: 'tool_request',
    timestamp: '2026-09-17T00:00:00.000Z',
    arguments: {
      command: `${process.execPath} -e ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'unsafe')`)}`,
    },
  });
  const record = createSnapshotRecord(snapshot);
  await service.store.save(record);
  return {
    directory,
    record,
    sentinel,
    service,
    link: `${service.url}/v1/snapshots/${record.manifest.snapshotId}`,
    output: path.join(directory, 'new-directory', 'context.json'),
  };
}

async function assertMissing(filePath) {
  await assert.rejects(fs.lstat(filePath), { code: 'ENOENT' });
}

for (const command of ['resume', 'clone']) {
  test(`${command} previews by default without creating files or directories`, async (t) => {
    const context = await setup(t);
    const result = await runCli(context.directory, [command, context.link, '--output', context.output]);

    assert.equal(result.code, 2, result.stderr);
    const preview = JSON.parse(result.stdout);
    assert.equal(preview.status, 'review-required');
    assert.equal(preview.sourceSnapshotId, context.record.manifest.snapshotId);
    assert.equal(preview.sourceContentHash, context.record.manifest.contentHash);
    assert.equal(preview.restoreMode, 'context_document');
    assert.equal(preview.executionReadiness, 'not_assessed');
    assert.equal(preview.outputPath, context.output);
    assert.match(preview.message, /--approve/);
    await assertMissing(path.dirname(context.output));
    await assertMissing(context.sentinel);
  });

  test(`${command} writes only a context document after approval`, async (t) => {
    const context = await setup(t);
    const result = await runCli(context.directory, [
      command, context.link, '--output', context.output, '--approve',
    ]);

    assert.equal(result.code, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    const stored = JSON.parse(await fs.readFile(context.output, 'utf8'));
    assert.equal(output.status, 'context_imported');
    assert.equal(output.restoreMode, 'context_document');
    assert.equal(output.executionReadiness, 'not_assessed');
    assert.equal(output.safety.nativeSessionCreated, false);
    assert.equal(output.cloneId, stored.cloneId);
    assert.equal(stored.status, output.status);
    assert.equal(stored.restoreMode, output.restoreMode);
    assert.equal(stored.executionReadiness, output.executionReadiness);
    assert.equal(stored.safety.toolsReplayed, false);
    assert.equal(stored.safety.repositoryModified, false);
    assert.deepEqual(stored.session, context.record.snapshot);
    await assertMissing(context.sentinel);
  });
}

for (const value of ['false', 'true']) {
  test(`--approve ${value} is not an explicit boolean approval flag`, async (t) => {
    const context = await setup(t);
    const result = await runCli(context.directory, [
      'resume', context.link, '--output', context.output, '--approve', value,
    ]);

    assert.equal(result.code, 2, result.stderr);
    assert.equal(JSON.parse(result.stdout).status, 'review-required');
    await assertMissing(path.dirname(context.output));
  });
}

test('default preview does not create the default .data directory', async (t) => {
  const context = await setup(t);
  const result = await runCli(context.directory, ['resume', context.link]);
  assert.equal(result.code, 2, result.stderr);
  await assertMissing(path.join(context.directory, '.data'));
});

test('an approved import refuses to overwrite an existing file', async (t) => {
  const context = await setup(t);
  await fs.mkdir(path.dirname(context.output));
  const original = 'Existing user content must remain unchanged.\n';
  await fs.writeFile(context.output, original);

  const preview = await runCli(context.directory, ['resume', context.link, '--output', context.output]);
  assert.equal(preview.code, 2, preview.stderr);
  assert.equal(await fs.readFile(context.output, 'utf8'), original);

  const result = await runCli(context.directory, [
    'resume', context.link, '--output', context.output, '--approve',
  ]);
  assert.equal(result.code, 1, result.stdout);
  assert.match(JSON.parse(result.stderr).error, /Refusing to overwrite/);
  assert.equal(await fs.readFile(context.output, 'utf8'), original);
});

test('concurrent approved imports cannot clobber the same destination', async (t) => {
  const context = await setup(t);
  const args = ['resume', context.link, '--output', context.output, '--approve'];
  const results = await Promise.all([
    runCli(context.directory, args),
    runCli(context.directory, args),
  ]);

  assert.deepEqual(results.map(result => result.code).sort(), [0, 1]);
  const winner = JSON.parse(results.find(result => result.code === 0).stdout);
  const stored = JSON.parse(await fs.readFile(context.output, 'utf8'));
  assert.equal(stored.cloneId, winner.cloneId);
  assert.deepEqual(stored.session, context.record.snapshot);
  const loser = results.find(result => result.code === 1);
  assert.match(JSON.parse(loser.stderr).error, /Refusing to overwrite/);
});

test('an approved import rejects tampered content without creating an output', async (t) => {
  const context = await setup(t);
  context.record.snapshot.events[0].content = 'Changed after publication.';
  await fs.writeFile(context.service.store.filePath(context.record.manifest.snapshotId), JSON.stringify(context.record));
  const result = await runCli(context.directory, [
    'resume', context.link, '--output', context.output, '--approve',
  ]);
  assert.equal(result.code, 1);
  assert.match(JSON.parse(result.stderr).error, /integrity check failed/);
  await assertMissing(path.dirname(context.output));
});

test('approved sharing removes inline secrets before returning and storing the snapshot', async (t) => {
  const context = await setup(t);
  const snapshot = structuredClone(fixture);
  const secret = 'SYNTHETIC_CLI_VALUE';
  snapshot.events[1].content = `password=${secret}`;
  const input = path.join(context.directory, 'input.json');
  await fs.writeFile(input, JSON.stringify(snapshot));
  const result = await runCli(context.directory, [
    'share', '--input', input, '--base-url', context.service.url, '--approve',
  ]);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.includes(secret), false);
  assert.equal(result.stderr.includes(secret), false);
  const published = JSON.parse(result.stdout);
  const response = await fetch(published.link);
  assert.equal(response.status, 200);
  const record = await response.json();
  assert.equal(JSON.stringify(record).includes(secret), false);
  assert.equal(record.snapshot.events[1].content, 'password=[REDACTED]');
  const disk = await fs.readFile(context.service.store.filePath(published.snapshotId), 'utf8');
  assert.equal(disk.includes(secret), false);
});

test('share does not interpret --approve false as publication approval', async (t) => {
  const context = await setup(t);
  const input = path.join(context.directory, 'input.json');
  await fs.writeFile(input, JSON.stringify(fixture));
  const before = await fs.readdir(context.service.store.snapshotsDir);
  const result = await runCli(context.directory, [
    'share', '--input', input, '--base-url', context.service.url, '--approve', 'false',
  ]);

  assert.equal(result.code, 2, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, 'review-required');
  assert.deepEqual(await fs.readdir(context.service.store.snapshotsDir), before);
});
