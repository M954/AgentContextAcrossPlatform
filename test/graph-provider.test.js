'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { GraphProvider, sharingToken } = require('../src/graph-provider');
const { createBundle } = require('../src/bundle');
const { contentHash } = require('../src/snapshot');
const { graphFixture } = require('../fixtures/graph-service');
const fixture = require('../fixtures/sample-session.json');

async function publishedCase(fault) {
  const fake = graphFixture();
  if (fault) fake.faults[fault] = true;
  const publisher = new GraphProvider(fake.config, fake.auth('a'), fake);
  const bundle = createBundle(fixture);
  const destination = await publisher.resolveDestination();
  const publication = await publisher.publish(bundle, destination, ['b@example.test']);
  return { fake, publisher, bundle, publication };
}

test('OneDrive upload -> specific people link -> SharePoint download as B -> deny C -> revoke', async () => {
  const { fake, publisher, bundle, publication } = await publishedCase();
  assert.match(publication.link, /^https:\/\/tenant\.sharepoint\.com\//);
  const recipient = new GraphProvider(fake.config, fake.auth('b'), fake);
  const read = await recipient.inspect(publication.link);
  assert.equal(contentHash(read.bundle), contentHash(bundle));
  assert.equal(read.bundle.record.snapshot.task.title, fixture.task.title);
  const outsider = new GraphProvider(fake.config, fake.auth('c'), fake);
  await assert.rejects(outsider.inspect(publication.link), /403/);
  await assert.rejects(outsider.revoke(publication), /403/);
  await publisher.revoke(publication);
  await assert.rejects(recipient.inspect(publication.link), /403/);
});

test('accepts modern onedrive.cloud.microsoft links through Graph without fetching the webpage', async () => {
  const { fake, publication } = await publishedCase();
  const link = `https://onedrive.cloud.microsoft/:u:/test/${publication.itemId}`;
  const recipient = new GraphProvider(fake.config, fake.auth('b'), fake);
  await recipient.inspect(link);
  assert.ok(fake.calls.some((call) => call.url.includes(`/shares/${sharingToken(link)}/driveItem`)));
  assert.ok(fake.calls.every((call) => !call.url.startsWith('https://onedrive.cloud.microsoft')));
});

test('rejects arbitrary links, credentials, fragments and HTTP before network access', async () => {
  const fake = graphFixture();
  const provider = new GraphProvider(fake.config, fake.auth('b'), fake);
  for (const link of ['http://tenant.sharepoint.com/x', 'https://tenant.sharepoint.com.evil.test/x',
    'https://u:p@tenant.sharepoint.com/x', 'https://127.0.0.1/x', 'https://tenant.sharepoint.com/x#fragment']) {
    await assert.rejects(provider.inspect(link));
  }
  assert.equal(fake.calls.length, 0);
});

test('rejects wrong Graph download targets, extra redirects, and oversized responses', async () => {
  for (const fault of ['untrustedRedirect', 'downloadRedirect', 'oversized']) {
    const { fake, publication } = await publishedCase();
    fake.faults[fault] = true;
    const recipient = new GraphProvider(fake.config, fake.auth('b'), fake);
    await assert.rejects(recipient.inspect(publication.link));
    assert.ok(fake.calls.every((call) => !call.url.includes('evil.invalid')));
  }
});

test('changed payload or expected digest fails closed', async () => {
  const { fake, publication } = await publishedCase();
  const recipient = new GraphProvider(fake.config, fake.auth('b'), fake);
  await assert.rejects(recipient.inspect(publication.link, '0'.repeat(64)), /digest|changed/);
  const file = fake.files.get(publication.itemId);
  const altered = JSON.parse(file.bytes.toString());
  altered.record.snapshot.task.title = 'Tampered';
  file.bytes = Buffer.from(JSON.stringify(altered));
  await assert.rejects(recipient.inspect(publication.link), /integrity/);
});

test('failed or broadened sharing is rolled back without returning a usable link', async () => {
  for (const fault of ['grantDenied', 'partialGrant', 'broadLink']) {
    const fake = graphFixture();
    fake.faults[fault] = true;
    const publisher = new GraphProvider(fake.config, fake.auth('a'), fake);
    const destination = await publisher.resolveDestination();
    await assert.rejects(publisher.publish(createBundle(fixture), destination, ['b@example.test']), /removed/);
    assert.equal(fake.files.size, 0);
  }
});

test('reports failed cleanup explicitly, never as published', async () => {
  const fake = graphFixture();
  fake.faults.grantDenied = true;
  fake.faults.cleanupDenied = true;
  const publisher = new GraphProvider(fake.config, fake.auth('a'), fake);
  await assert.rejects(publisher.publish(createBundle(fixture), await publisher.resolveDestination(), ['b@example.test']),
    (error) => Boolean(/cleanup/.test(error.message) && error.recovery?.itemId));
});

test('consumer OneDrive is rejected before any upload', async () => {
  const fake = graphFixture();
  fake.faults.personal = true;
  await assert.rejects(new GraphProvider(fake.config, fake.auth('a'), fake).resolveDestination(), /consumer/);
  assert.equal(fake.files.size, 0);
});
