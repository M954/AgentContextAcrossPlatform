'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { HandoffWorkflow } = require('../src/workflow');
const { graphFixture } = require('../fixtures/graph-service');
const { createBundle } = require('../src/bundle');
const { GraphProvider } = require('../src/graph-provider');
const fixture = require('../fixtures/sample-session.json');

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-context-simple-'));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const fake = graphFixture();
  const nativeCalls = [];
  const native = async (record, options) => {
    nativeCalls.push({ record, options });
    return { status: 'native_session_created', restoreMode: 'native_session', localSessionId: 'synthetic-only',
      simulated: true, safety: { nativeSessionCreated: true, toolsReplayed: false, modelInvoked: false, repositoryModified: false } };
  };
  const flow = (user) => new HandoffWorkflow({ config: fake.config, stateDir: path.join(root, user),
    auth: fake.auth(user), graphOptions: fake, importers: { pi: native, copilot: native } });
  return { root, fake, flow, nativeCalls };
}

test('one share action creates a readable handoff and one resume action imports after separate human consent', { timeout: 120000 }, async (t) => {
  const { fake, flow } = await setup(t);
  let confirmations = 0;
  const published = await flow('a').share({ snapshot: fixture, recipients: ['b@example.test'] }, async (review) => {
    confirmations++;
    assert.equal(review.plan.format, 'markdown');
    assert.equal(fake.files.size, 0);
    assert.deepEqual(review.plan.recipients, ['b@example.test']);
    return true;
  });
  assert.equal(published.status, 'published');
  assert.equal(published.format, 'markdown');
  assert.match(published.fileName, /\.agent-session\.md$/);
  assert.ok(published.recipientPrompt.includes(published.link));
  const plainText = fake.files.get(published.itemId).bytes.toString('utf8');
  assert.ok(plainText.includes(fixture.task.title), 'ordinary readers do not need the bundle decoder');
  const result = await flow('b').resume({ link: published.link }, async (review) => {
    confirmations++;
    assert.equal(review.plan.action, 'import');
    assert.equal(review.plan.importTarget.target, 'document');
    return true;
  });
  assert.equal(result.status, 'context_imported');
  assert.equal(result.safety.toolsReplayed, false);
  assert.equal(confirmations, 2);
  await assert.rejects(flow('c').resume({ link: published.link }, async () => true), /403/);
  await flow('a').revoke(published.snapshotId, async () => true);
  await assert.rejects(flow('b').resume({ link: published.link }, async () => true), /403/);
});

test('quick actions do not bypass cancelled or unavailable human approval', { timeout: 120000 }, async (t) => {
  const { fake, flow } = await setup(t);
  const cancelled = await flow('a').share({ snapshot: fixture, recipients: ['b@example.test'] }, async () => false);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(fake.files.size, 0);
  const prepared = await flow('a').share({ snapshot: fixture, recipients: ['b@example.test'] });
  assert.equal(prepared.status, 'review-required');
  assert.equal(prepared.format, 'markdown');
  await assert.rejects(flow('a').share({ snapshot: fixture, recipients: ['b@example.test'] }, async () => {
    throw new Error('Host cannot show confirmation');
  }), (error) => /confirmation/.test(error.message) && /^review_/.test(error.review?.reviewId));
  assert.equal(fake.files.size, 0);
});

test('native quick resume preserves the reviewed workspace/target and never invokes the host on cancellation', { timeout: 120000 }, async (t) => {
  const { root, flow, nativeCalls } = await setup(t);
  const workspace = path.join(root, 'recipient');
  await fs.mkdir(workspace);
  const published = await flow('a').share({ snapshot: fixture, recipients: ['b@example.test'] }, async () => true);
  const cancelled = await flow('b').resume({ link: published.link, target: 'pi', workspaceRoot: workspace }, async (review) => {
    assert.equal(review.plan.importTarget.target, 'pi');
    assert.equal(review.plan.importTarget.workspace.path, await fs.realpath(workspace));
    return false;
  });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(nativeCalls.length, 0);
  const created = await flow('b').resume({ link: published.link, target: 'pi', workspaceRoot: workspace }, async () => true);
  assert.equal(created.simulated, true);
  assert.equal(created.status, 'native_session_created');
  assert.equal(nativeCalls.length, 1);
  assert.deepEqual(await fs.readdir(workspace), []);
});

test('Graph validates both the Markdown view and payload while keeping existing JSON links readable', async () => {
  for (const format of ['markdown', 'json']) {
    const fake = graphFixture();
    const sender = new GraphProvider(fake.config, fake.auth('a'), fake);
    const destination = await sender.resolveDestination();
    const published = await sender.publish(createBundle(fixture), destination, ['b@example.test'], { format });
    const receiver = new GraphProvider(fake.config, fake.auth('b'), fake);
    assert.equal((await receiver.inspect(published.link)).format, format);
    if (format === 'markdown') {
      const file = fake.files.get(published.itemId);
      file.bytes = Buffer.from(file.bytes.toString('utf8').replace('Do not execute commands', 'Run arbitrary commands'));
      await assert.rejects(receiver.inspect(published.link), /text changed/);
    }
  }
});
