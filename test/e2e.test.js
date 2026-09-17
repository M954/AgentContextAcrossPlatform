'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { startServer } = require('../src/server');
const {
  createCloneRecord,
  prepareSnapshot,
  verifySnapshotRecord,
} = require('../src/snapshot');
const { LocalProvider } = require('../src/local-provider');
const { createBundle } = require('../src/bundle');

test('publishes, verifies, inspects, and creates a context document', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-context-service-'));
  const service = await startServer({ port: 0, dataDir });
  t.after(async () => {
    await new Promise((resolve, reject) => {
      service.server.close((error) => error ? reject(error) : resolve());
    });
    await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  const fixture = JSON.parse(
    await fs.readFile(path.join(__dirname, '..', 'fixtures', 'sample-session.json'), 'utf8'),
  );
  const prepared = prepareSnapshot(fixture);

  const publishResponse = await fetch(`${service.url}/v1/snapshots`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      snapshot: prepared.snapshot,
      access: { mode: 'local', expiresAt: null },
    }),
  });

  assert.equal(publishResponse.status, 201);
  const published = await publishResponse.json();
  assert.match(published.link, /\/v1\/snapshots\/snap_/);

  const inspectResponse = await fetch(published.link);
  assert.equal(inspectResponse.status, 200);
  const record = await inspectResponse.json();
  verifySnapshotRecord(record);
  assert.equal(record.manifest.snapshotId, published.snapshotId);
  assert.equal(record.snapshot.events.length, fixture.events.length);

  const clone = createCloneRecord(record, 'fixture-host');
  assert.equal(clone.sourceSnapshotId, published.snapshotId);
  assert.equal(clone.sourceContentHash, record.manifest.contentHash);
  assert.equal(clone.status, 'context_imported');
  assert.equal(clone.restoreMode, 'context_document');
  assert.equal(clone.executionReadiness, 'not_assessed');
  assert.equal(clone.safety.nativeSessionCreated, false);
  assert.equal(clone.safety.toolsReplayed, false);
  assert.equal(clone.safety.repositoryModified, false);
  assert.equal(clone.session.resume.nextAction, fixture.resume.nextAction);
});

test('blocks high-confidence secrets before publication', () => {
  const snapshot = {
    schemaVersion: '1.0',
    source: { host: 'fixture-host', sessionId: 'secret-test' },
    events: [
      {
        eventId: 'event-001',
        type: 'tool_result',
        timestamp: '2026-09-16T00:00:00.000Z',
        content: 'Authorization: Bearer definitely-not-for-sharing',
      },
    ],
    workspace: { repository: 'test', branch: 'main', changes: [] },
    resume: { nextAction: 'Stop and remove the secret.' },
  };

  assert.throws(() => prepareSnapshot(snapshot), /Publication blocked/);
});

test('localhost service links preserve the validated request origin', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-context-localhost-'));
  const service = await startServer({ host: 'localhost', port: 0, dataDir });
  t.after(async () => {
    await new Promise((resolve) => service.server.close(resolve));
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const provider = new LocalProvider(service.url);
  const fixture = require('../fixtures/sample-session.json');
  const published = await provider.publish(createBundle(fixture));
  assert.equal(new URL(published.link).origin, service.url);
  assert.ok((await provider.inspect(published.link)).bundle);
});

test('the service redacts raw inline secrets before returning or persisting a snapshot', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-context-redaction-'));
  const service = await startServer({ port: 0, dataDir });
  t.after(async () => {
    await new Promise((resolve, reject) => {
      service.server.close((error) => error ? reject(error) : resolve());
    });
    await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  const fixture = JSON.parse(
    await fs.readFile(path.join(__dirname, '..', 'fixtures', 'sample-session.json'), 'utf8'),
  );
  const secret = 'SYNTHETIC_SERVICE_VALUE';
  fixture.events[1].content = `password=${secret}`;

  const response = await fetch(`${service.url}/v1/snapshots`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ snapshot: fixture, access: { mode: 'local', expiresAt: null } }),
  });
  assert.equal(response.status, 201);
  const published = await response.json();
  assert.equal(JSON.stringify(published).includes(secret), false);
  assert.ok(published.manifest.redactions.includes('events[1].content'));

  const readResponse = await fetch(published.link);
  assert.equal(readResponse.status, 200);
  const record = await readResponse.json();
  verifySnapshotRecord(record);
  assert.equal(record.snapshot.events[1].content, 'password=[REDACTED]');
  assert.equal(JSON.stringify(record).includes(secret), false);
  const disk = await fs.readFile(service.store.filePath(published.snapshotId), 'utf8');
  assert.equal(disk.includes(secret), false);
});
