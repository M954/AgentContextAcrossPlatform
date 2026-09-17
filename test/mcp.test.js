'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { ElicitRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const { startServer } = require('../src/server');
const fixture = require('../fixtures/sample-session.json');

function value(result) {
  assert.ok(!result.isError, JSON.stringify(result));
  return JSON.parse(result.content[0].text);
}

async function start(t, elicitation = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-context-mcp-'));
  const service = await startServer({ port: 0, dataDir: path.join(root, 'service') });
  const client = new Client({ name: 'synthetic-test-client', version: '1' },
    { capabilities: elicitation ? { elicitation: { form: {} } } : {} });
  let allow = false;
  let prompts = 0;
  if (elicitation) {
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      prompts++;
      assert.ok(request.params.message.includes('exact reviewed'));
      return { action: allow ? 'accept' : 'decline', ...(allow ? { content: { approve: true } } : {}) };
    });
  }
  const transport = new StdioClientTransport({
    command: process.execPath, args: [path.join(__dirname, '..', 'src', 'mcp-server.js')],
    env: { ...process.env, SESSION_SERVICE_URL: service.url, AGENT_CONTEXT_HOME: path.join(root, 'client') },
    stderr: 'pipe',
  });
  t.after(async () => {
    await client.close();
    await new Promise((resolve, reject) => service.server.close((error) => error ? reject(error) : resolve()));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  await client.connect(transport);
  return { client, service, root, allow: () => { allow = true; }, prompts: () => prompts };
}

test('official MCP client exercises prepare -> human approval -> publish -> inspect -> context import', { timeout: 120000 }, async (t) => {
  const { client, service, allow, prompts } = await start(t);
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name),
    ['session_prepare_publish', 'session_publish', 'session_inspect', 'session_clone', 'session_revoke', 'session_status']);
  const prepared = value(await client.callTool({
    name: 'session_prepare_publish', arguments: { snapshot: fixture, provider: 'local' },
  }));
  assert.equal(prepared.status, 'review-required');
  assert.deepEqual(await fs.readdir(service.store.snapshotsDir), []);
  const bypass = await client.callTool({ name: 'session_publish', arguments: { snapshot: fixture, approval: true } });
  assert.equal(bypass.isError, true);
  assert.equal(prompts(), 0);
  const cancelled = value(await client.callTool({ name: 'session_publish', arguments: { reviewId: prepared.reviewId } }));
  assert.equal(cancelled.status, 'cancelled');
  assert.deepEqual(await fs.readdir(service.store.snapshotsDir), []);
  allow();
  const published = value(await client.callTool({ name: 'session_publish', arguments: { reviewId: prepared.reviewId } }));
  assert.equal(published.status, 'published');
  const inspected = value(await client.callTool({ name: 'session_inspect', arguments: { link: published.link } }));
  assert.equal(inspected.status, 'inspectable');
  assert.equal(inspected.executionReadiness, 'not_assessed');
  const imported = value(await client.callTool({ name: 'session_clone', arguments: { reviewId: inspected.reviewId } }));
  assert.equal(imported.status, 'context_imported');
  assert.equal(imported.restoreMode, 'context_document');
  assert.equal(imported.executionReadiness, 'not_assessed');
  assert.equal(imported.safety.nativeSessionCreated, false);
  assert.equal(imported.safety.toolsReplayed, false);
  const original = await fs.readFile(imported.bundlePath, 'utf8');
  const replay = value(await client.callTool({ name: 'session_clone', arguments: { reviewId: inspected.reviewId } }));
  assert.equal(replay.cloneId, imported.cloneId);
  assert.equal(await fs.readFile(imported.bundlePath, 'utf8'), original);
  assert.equal(prompts(), 3, 'a repeated import must not overwrite output or repeat the side effect');
});

test('MCP hosts without human elicitation cannot publish through a boolean or a review ID', { timeout: 120000 }, async (t) => {
  const { client, service } = await start(t, false);
  const review = value(await client.callTool({ name: 'session_publish', arguments: { snapshot: fixture, provider: 'local', approval: false } }));
  const blocked = await client.callTool({ name: 'session_publish', arguments: { reviewId: review.reviewId } });
  assert.equal(blocked.isError, true);
  assert.match(blocked.content[0].text, /trusted approval form/);
  assert.deepEqual(await fs.readdir(service.store.snapshotsDir), []);
});

test('MCP clone rejects old approval flags and arbitrary output paths without creating output', { timeout: 120000 }, async (t) => {
  const { client, root } = await start(t);
  for (const approval of [undefined, false, true, 'false', 'true']) {
    const rejected = await client.callTool({ name: 'session_clone', arguments: {
      link: 'http://127.0.0.1:8787/v1/snapshots/not-real', approval, outputPath: '../outside.json',
    } });
    assert.equal(rejected.isError, true);
  }
  await assert.rejects(fs.stat(path.join(root, 'outside.json')), { code: 'ENOENT' });
});

test('concurrent MCP imports never clobber a destination', { timeout: 120000 }, async (t) => {
  const { client, allow } = await start(t);
  allow();
  const prepared = value(await client.callTool({ name: 'session_prepare_publish', arguments: { snapshot: fixture, provider: 'local' } }));
  const publication = value(await client.callTool({ name: 'session_publish', arguments: { reviewId: prepared.reviewId } }));
  const inspected = value(await client.callTool({ name: 'session_inspect', arguments: { link: publication.link } }));
  const results = await Promise.all([
    client.callTool({ name: 'session_clone', arguments: { reviewId: inspected.reviewId } }),
    client.callTool({ name: 'session_clone', arguments: { reviewId: inspected.reviewId } }),
  ]);
  const successes = results.filter((result) => !result.isError).map(value);
  assert.ok(successes.length >= 1);
  assert.ok(successes.every((result) => result.cloneId === successes[0].cloneId));
  assert.ok((await fs.readFile(successes[0].contextPath, 'utf8')).includes('not local instructions'));
});
