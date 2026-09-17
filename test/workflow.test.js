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
const fixture = require('../fixtures/sample-session.json');

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-context-workflow-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const fake = graphFixture();
  const flow = (user, stateDir = path.join(root, user)) => new HandoffWorkflow({
    config: fake.config, stateDir, auth: fake.auth(user), graphOptions: fake,
  });
  return { root, fake, flow };
}

test('complete A -> reviewed bundle -> OneDrive -> B -> isolated files/context, with no execution', async (t) => {
  const { root, fake, flow } = await setup(t);
  const publisher = flow('a');
  const input = structuredClone(fixture);
  input.files = [{ path: 'queries/next.sql', encoding: 'utf8', content: 'select 1;' }];
  input.events[0].content = 'password=SYNTHETIC_NOT_A_CREDENTIAL';
  const review = await publisher.preparePublish({ snapshot: input, recipients: ['b@example.test'] });
  assert.equal(review.status, 'review-required');
  assert.equal(review.summary.redactionCount, 1);
  assert.ok(fake.calls.every((call) => call.method === 'GET'), 'preparing must not upload or grant access');
  const cancelled = await publisher.complete(review.reviewId, 'publish', async () => false);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(fake.files.size, 0);
  let confirmations = 0;
  const published = await publisher.complete(review.reviewId, 'publish', async (draft) => {
    confirmations++;
    assert.ok(!JSON.stringify(draft).includes('SYNTHETIC_NOT_A_CREDENTIAL'));
    assert.deepEqual(draft.plan.recipients, ['b@example.test']);
    return true;
  });
  const replay = await publisher.complete(review.reviewId, 'publish', async () => { throw new Error('Must not reapprove completed work'); });
  assert.equal(replay.link, published.link);
  assert.equal(confirmations, 1);
  assert.equal(fake.files.size, 1);
  const recipient = flow('b');
  const inspected = await recipient.inspect({ link: published.link });
  assert.equal(inspected.restoreMode, 'context_document');
  assert.equal(inspected.readiness, 'needs_adaptation');
  const imported = await recipient.complete(inspected.reviewId, 'import', async () => true);
  assert.equal(imported.status, 'context_imported');
  assert.equal(imported.safety.toolsReplayed, false);
  assert.equal(imported.safety.repositoryModified, false);
  assert.equal(await fs.readFile(path.join(path.dirname(imported.contextPath), 'files', 'queries', 'next.sql'), 'utf8'), 'select 1;');
  assert.ok((await fs.readFile(imported.contextPath, 'utf8')).includes('untrusted historical data'));
  assert.ok(imported.contextPath.startsWith(path.join(root, 'b', 'imports')));
  await assert.rejects(flow('c').inspect({ link: published.link }), /403/);
  await assert.rejects(flow('b', path.join(root, 'a')).complete(review.reviewId, 'publish', async () => true), /Account/);
});

test('reviews expire, reject tampering, and cannot be used for another action', async (t) => {
  const { flow } = await setup(t);
  const publisher = flow('a');
  const review = await publisher.preparePublish({ snapshot: fixture, recipients: ['b@example.test'] });
  await assert.rejects(publisher.complete(review.reviewId, 'import', async () => true), /different action/);
  const draft = JSON.parse(await fs.readFile(review.previewPath, 'utf8'));
  draft.plan.recipients.push('c@example.test');
  await fs.writeFile(review.previewPath, JSON.stringify(draft));
  await assert.rejects(publisher.complete(review.reviewId, 'publish', async () => true), /Review changed/);
  const fresh = await publisher.preparePublish({ snapshot: fixture, recipients: ['b@example.test'] });
  const expired = JSON.parse(await fs.readFile(fresh.previewPath, 'utf8'));
  expired.expiresAt = '2000-01-01T00:00:00.000Z';
  const { digest, ...unsigned } = expired;
  expired.digest = contentHash(unsigned);
  await fs.writeFile(fresh.previewPath, JSON.stringify(expired));
  await assert.rejects(publisher.complete(fresh.reviewId, 'publish', async () => true), /expired/);
});

test('revocation and changed remote versions block cached imports', async (t) => {
  const { flow, fake } = await setup(t);
  const publisher = flow('a');
  const review = await publisher.preparePublish({ snapshot: fixture, recipients: ['b@example.test'] });
  const published = await publisher.complete(review.reviewId, 'publish', async () => true);
  const recipient = flow('b');
  const inspected = await recipient.inspect({ link: published.link });
  fake.files.get(published.itemId).version = '"v2"';
  await assert.rejects(recipient.complete(inspected.reviewId, 'import', async () => true), /version changed/);
  const next = await recipient.inspect({ link: published.link });
  await publisher.revoke(published.snapshotId, async () => true);
  await assert.rejects(recipient.complete(next.reviewId, 'import', async () => true), /403/);
});

test('concurrent approvals do not duplicate side effects', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-context-review-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const reviews = new ReviewStore(root);
  const review = await reviews.create({ identity: 'a', configuration: 'fixed', action: 'test' });
  let count = 0;
  const options = { identity: 'a', fingerprint: 'fixed', confirm: async () => true,
    perform: async () => { count++; await new Promise((resolve) => setTimeout(resolve, 20)); return { status: 'done' }; } };
  const results = await Promise.allSettled([reviews.execute(review.reviewId, options), reviews.execute(review.reviewId, options)]);
  assert.equal(count, 1);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
});
