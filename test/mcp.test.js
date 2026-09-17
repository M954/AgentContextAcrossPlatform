'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { startServer } = require('../src/server');

function startMcpClient(serviceUrl, cloneDir) {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'mcp-server.js')], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      SESSION_SERVICE_URL: serviceUrl,
      AGENT_CONTEXT_CLONE_DIR: cloneDir,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let nextId = 1;
  let buffer = '';
  const pending = new Map();
  let stderr = '';

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line) {
        const message = JSON.parse(line);
        const resolver = pending.get(message.id);
        if (resolver) {
          pending.delete(message.id);
          resolver.resolve(message);
        }
      }
      newlineIndex = buffer.indexOf('\n');
    }
  });

  child.on('error', (error) => {
    for (const resolver of pending.values()) {
      resolver.reject(error);
    }
    pending.clear();
  });

  return {
    child,
    getStderr: () => stderr,
    send(method, params) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    },
  };
}

function toolValue(response) {
  assert.ok(response.result, JSON.stringify(response));
  assert.ok(Array.isArray(response.result.content), JSON.stringify(response));
  return JSON.parse(response.result.content[0].text);
}

async function setupMcp(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-context-mcp-service-'));
  const cloneDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-context-mcp-clones-'));
  const service = await startServer({ port: 0, dataDir });
  const client = startMcpClient(service.url, cloneDir);

  t.after(async () => {
    if (client.child.exitCode === null && client.child.signalCode === null) {
      await new Promise((resolve) => {
        client.child.once('exit', resolve);
        client.child.kill();
      });
    }
    await new Promise((resolve, reject) => {
      service.server.close((error) => error ? reject(error) : resolve());
    });
    await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    await fs.rm(cloneDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  return { client, cloneDir };
}

test('serves the publish, inspect, and context-document workflow through MCP STDIO', { timeout: 15000 }, async (t) => {
  const { client, cloneDir } = await setupMcp(t);

  const fixture = JSON.parse(
    await fs.readFile(path.join(__dirname, '..', 'fixtures', 'sample-session.json'), 'utf8'),
  );

  const initialized = await client.send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '0.1.0' },
  });
  assert.equal(initialized.result.serverInfo.name, 'agent-context-across-platform');

  const tools = await client.send('tools/list', {});
  assert.deepEqual(
    tools.result.tools.map((tool) => tool.name),
    ['session_publish', 'session_inspect', 'session_clone', 'session_revoke', 'session_status'],
  );

  const review = toolValue(
    await client.send('tools/call', {
      name: 'session_publish',
      arguments: { snapshot: fixture },
    }),
  );
  assert.equal(review.status, 'review-required');

  const published = toolValue(
    await client.send('tools/call', {
      name: 'session_publish',
      arguments: { snapshot: fixture, approval: true },
    }),
  );
  assert.match(published.link, /\/v1\/snapshots\/snap_/);

  const inspected = toolValue(
    await client.send('tools/call', {
      name: 'session_inspect',
      arguments: { link: published.link },
    }),
  );
  assert.equal(inspected.status, 'inspectable');
  assert.equal(inspected.summary.title, 'Implement remote session cloning');

  const confirmation = toolValue(
    await client.send('tools/call', {
      name: 'session_clone',
      arguments: { link: published.link },
    }),
  );
  assert.equal(confirmation.status, 'confirmation-required');
  assert.equal(confirmation.restoreMode, 'context_document');
  assert.equal(confirmation.executionReadiness, 'not_assessed');
  assert.deepEqual(await fs.readdir(cloneDir), []);

  const cloned = toolValue(
    await client.send('tools/call', {
      name: 'session_clone',
      arguments: {
        link: published.link,
        approval: true,
        targetHost: 'copilot-cli',
        outputPath: 'mcp-clone.json',
      },
    }),
  );
  assert.equal(cloned.status, 'context_imported');
  assert.equal(cloned.restoreMode, 'context_document');
  assert.equal(cloned.executionReadiness, 'not_assessed');
  assert.equal(cloned.safety.nativeSessionCreated, false);
  assert.equal(cloned.safety.toolsReplayed, false);
  assert.equal(cloned.safety.repositoryModified, false);
  await fs.access(path.join(cloneDir, 'mcp-clone.json'));
  assert.equal(client.getStderr(), '');
});

test('MCP clone requires boolean approval and refuses to overwrite existing output', { timeout: 15000 }, async (t) => {
  const { client, cloneDir } = await setupMcp(t);
  const fixture = JSON.parse(
    await fs.readFile(path.join(__dirname, '..', 'fixtures', 'sample-session.json'), 'utf8'),
  );
  const published = toolValue(await client.send('tools/call', {
    name: 'session_publish',
    arguments: { snapshot: fixture, approval: true },
  }));
  const outputPath = 'nested/context.json';
  for (const approval of [undefined, false, 'false', 'true']) {
    const preview = toolValue(await client.send('tools/call', {
      name: 'session_clone',
      arguments: { link: published.link, outputPath, approval },
    }));
    assert.equal(preview.status, 'confirmation-required');
    assert.equal(preview.executionReadiness, 'not_assessed');
    await assert.rejects(fs.lstat(path.join(cloneDir, 'nested')), { code: 'ENOENT' });
  }

  const args = { link: published.link, outputPath, approval: true };
  const created = toolValue(await client.send('tools/call', { name: 'session_clone', arguments: args }));
  assert.equal(created.status, 'context_imported');
  const original = await fs.readFile(path.join(cloneDir, outputPath), 'utf8');
  const stored = JSON.parse(original);
  assert.equal(stored.restoreMode, created.restoreMode);
  assert.equal(stored.executionReadiness, 'not_assessed');
  assert.equal(stored.safety.nativeSessionCreated, false);

  const duplicate = await client.send('tools/call', { name: 'session_clone', arguments: args });
  assert.equal(duplicate.result.isError, true);
  assert.match(toolValue(duplicate).error, /Refusing to overwrite/);
  assert.equal(await fs.readFile(path.join(cloneDir, outputPath), 'utf8'), original);
});

test('concurrent MCP clone requests cannot clobber the same destination', { timeout: 15000 }, async (t) => {
  const { client, cloneDir } = await setupMcp(t);
  const fixture = JSON.parse(
    await fs.readFile(path.join(__dirname, '..', 'fixtures', 'sample-session.json'), 'utf8'),
  );
  const published = toolValue(await client.send('tools/call', {
    name: 'session_publish',
    arguments: { snapshot: fixture, approval: true },
  }));
  const params = {
    name: 'session_clone',
    arguments: { link: published.link, outputPath: 'concurrent.json', approval: true },
  };
  const results = await Promise.all([
    client.send('tools/call', params),
    client.send('tools/call', params),
  ]);
  assert.equal(results.filter(result => result.result.isError).length, 1);
  const winner = toolValue(results.find(result => !result.result.isError));
  const loser = toolValue(results.find(result => result.result.isError));
  assert.equal(winner.status, 'context_imported');
  assert.match(loser.error, /Refusing to overwrite/);
  const stored = JSON.parse(await fs.readFile(path.join(cloneDir, 'concurrent.json'), 'utf8'));
  assert.equal(stored.cloneId, winner.cloneId);
  assert.equal(stored.executionReadiness, 'not_assessed');
});
