'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { HandoffWorkflow } = require('../src/workflow');
const { ReviewStore } = require('../src/reviews');
const { contentHash } = require('../src/snapshot');
const { graphFixture } = require('../fixtures/graph-service');
const fixture = require('../fixtures/sample-readiness-session.json');

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-context-native-review-'));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const workspace = path.join(root, 'recipient-project');
  await fs.mkdir(workspace);
  const fake = graphFixture();
  const calls = [];
  let fail = false;
  const importer = async (record, options) => {
    calls.push({ record, options });
    if (fail) throw new Error('Simulated ambiguous native import failure');
    return { status: 'native_session_created', restoreMode: 'native_session', simulated: true,
      localSessionId: `fixture-native-${calls.length}`, sourceSnapshotId: record.manifest.snapshotId,
      safety: { toolsReplayed: false, modelInvoked: false, nativeSessionCreated: true, repositoryModified: false } };
  };
  const flow = (user, stateDir = path.join(root, user)) => new HandoffWorkflow({ config: fake.config,
    stateDir, auth: fake.auth(user), graphOptions: fake, importers: { pi: importer, copilot: importer } });
  const publisher = flow('a');
  const draft = await publisher.preparePublish({ snapshot: structuredClone(fixture), recipients: ['b@example.test'] });
  const publication = await publisher.complete(draft.reviewId, 'publish', async () => true);
  return { root, workspace, fake, flow, publisher, publication, calls, fail: () => { fail = true; } };
}

test('native destination/workspace is in the review; consent precedes invocation and cached completion is idempotent', { timeout: 120000 }, async t => {
  const ctx = await setup(t);
  const recipient = ctx.flow('b');
  const inspected = await recipient.inspect({ link: ctx.publication.link, target: 'pi', workspaceRoot: ctx.workspace });
  assert.equal(inspected.plannedRestoreMode, 'native_session');
  assert.equal(inspected.importTarget.target, 'pi');
  assert.equal(inspected.importTarget.workspace.path, await fs.realpath(ctx.workspace));
  assert.ok(inspected.importTarget.directory.startsWith(path.join(ctx.root, 'b', 'imports')));
  assert.equal(ctx.calls.length, 0);
  await assert.rejects(fs.stat(inspected.importTarget.directory), { code: 'ENOENT' });
  const cancelled = await recipient.complete(inspected.reviewId, 'import', async () => false);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(ctx.calls.length, 0);
  await assert.rejects(fs.stat(inspected.importTarget.directory), { code: 'ENOENT' });

  const imported = await recipient.complete(inspected.reviewId, 'import', async review => {
    assert.equal(review.plan.importTarget.target, 'pi');
    assert.equal(review.plan.importTarget.workspace.path, await fs.realpath(ctx.workspace));
    assert.equal(ctx.calls.length, 0);
    return true;
  });
  assert.equal(imported.status, 'native_session_created');
  assert.equal(imported.simulated, true, 'test adapter is not evidence of a real native session');
  assert.equal(imported.executionReadiness, 'not_assessed');
  assert.equal(ctx.calls.length, 1);
  assert.equal(ctx.calls[0].options.workspace, await fs.realpath(ctx.workspace));
  assert.ok(ctx.calls[0].options.sessionDir.startsWith(inspected.importTarget.directory));
  assert.ok(ctx.calls[0].options.home.startsWith(inspected.importTarget.directory));
  assert.deepEqual(await fs.readdir(ctx.workspace), [], 'no source files go into the recipient project');
  const cached = await recipient.complete(inspected.reviewId, 'import', async () => { throw new Error('Must not reapprove'); });
  assert.equal(cached.localSessionId, imported.localSessionId);
  assert.equal(ctx.calls.length, 1);
});

test('editing the reviewed target on disk during confirmation prevents all native side effects', { timeout: 120000 }, async t => {
  const ctx = await setup(t);
  const recipient = ctx.flow('b');
  const inspected = await recipient.inspect({ link: ctx.publication.link, target: 'pi', workspaceRoot: ctx.workspace });
  await assert.rejects(recipient.complete(inspected.reviewId, 'import', async () => {
    const changed = JSON.parse(await fs.readFile(inspected.previewPath, 'utf8'));
    changed.plan.importTarget.target = 'copilot';
    const { digest, ...unsigned } = changed;
    changed.digest = contentHash(unsigned);
    await fs.writeFile(inspected.previewPath, JSON.stringify(changed));
    return true;
  }), /Review changed during confirmation/);
  assert.equal(ctx.calls.length, 0);
});

test('workspace replacement and changed executable settings require fresh native review', { timeout: 120000 }, async t => {
  const ctx = await setup(t);
  const recipient = ctx.flow('b');
  const first = await recipient.inspect({ link: ctx.publication.link, target: 'pi', workspaceRoot: ctx.workspace });
  await assert.rejects(recipient.complete(first.reviewId, 'import', async () => {
    await fs.rename(ctx.workspace, `${ctx.workspace}-old`);
    await fs.mkdir(ctx.workspace);
    return true;
  }), /workspace changed/);
  assert.equal(ctx.calls.length, 0);

  const second = await recipient.inspect({ link: ctx.publication.link, target: 'pi', workspaceRoot: ctx.workspace });
  const previous = process.env.AGENT_CONTEXT_PI_BIN;
  try {
    await assert.rejects(recipient.complete(second.reviewId, 'import', async () => {
      process.env.AGENT_CONTEXT_PI_BIN = path.join(ctx.root, 'different-pi');
      return true;
    }), /host configuration changed/);
  } finally {
    if (previous === undefined) delete process.env.AGENT_CONTEXT_PI_BIN;
    else process.env.AGENT_CONTEXT_PI_BIN = previous;
  }
  assert.equal(ctx.calls.length, 0);
});

test('revocation, version changes and account changes stop native import before the host is invoked', { timeout: 120000 }, async t => {
  const ctx = await setup(t);
  const recipient = ctx.flow('b');
  const first = await recipient.inspect({ link: ctx.publication.link, target: 'copilot', workspaceRoot: ctx.workspace });
  await assert.rejects(ctx.flow('c', path.join(ctx.root, 'b')).complete(first.reviewId, 'import', async () => true), /Account/);
  ctx.fake.files.get(ctx.publication.itemId).version = '"v2"';
  await assert.rejects(recipient.complete(first.reviewId, 'import', async () => true), /version changed/);
  const second = await recipient.inspect({ link: ctx.publication.link, target: 'pi', workspaceRoot: ctx.workspace });
  await assert.rejects(recipient.complete(second.reviewId, 'import', async () => {
    await ctx.publisher.revoke(ctx.publication.snapshotId, async () => true);
    return true;
  }), /403/);
  assert.equal(ctx.calls.length, 0);
});

test('ambiguous native failures keep the claim and provide recovery paths instead of retrying', { timeout: 120000 }, async t => {
  const ctx = await setup(t);
  const recipient = ctx.flow('b');
  const draft = await recipient.inspect({ link: ctx.publication.link, target: 'pi', workspaceRoot: ctx.workspace });
  ctx.fail();
  await assert.rejects(recipient.complete(draft.reviewId, 'import', async () => true), error => {
    assert.equal(error.recovery.nativeStateMayExist, true);
    assert.ok(error.recovery.contextPath.startsWith(draft.importTarget.directory));
    return true;
  });
  await assert.rejects(recipient.complete(draft.reviewId, 'import', async () => true), /incomplete attempt/);
  assert.equal(ctx.calls.length, 1);
});

test('passive assessment uses only the reviewed workspace and never authorizes or invokes a native host', { timeout: 120000 }, async t => {
  const ctx = await setup(t);
  const recipient = ctx.flow('b');
  const draft = await recipient.inspect({ link: ctx.publication.link, target: 'pi', workspaceRoot: ctx.workspace });
  const report = await recipient.assess(draft.reviewId, { requirementsReviewed: true });
  assert.equal(report.status, 'blocked');
  assert.equal(report.executionAuthorized, false);
  assert.equal(report.reviewDigest, draft.reviewDigest);
  assert.equal(ctx.calls.length, 0);
  await assert.rejects(fs.stat(draft.importTarget.directory), { code: 'ENOENT' });
  ctx.fake.files.get(ctx.publication.itemId).version = '"v2"';
  await assert.rejects(recipient.assess(draft.reviewId), /version changed/);
});

test('confirmation callbacks cannot change the executable plan by mutating their UI copy', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-copy-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ReviewStore(root);
  const review = await store.create({ identity: 'b', configuration: 'config', action: 'import', target: 'document' });
  const result = await store.execute(review.reviewId, { identity: 'b', fingerprint: 'config',
    confirm: async display => { display.plan.target = 'pi'; display.digest = 'forged'; return true; },
    perform: async plan => ({ target: plan.target }) });
  assert.equal(result.target, 'document');
});
