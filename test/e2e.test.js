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

test('publishes, verifies, inspects, and clones a session snapshot', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-context-service-'));
  const service = await startServer({ port: 0, dataDir });
  t.after(() => service.server.close());

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
