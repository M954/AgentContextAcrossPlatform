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

test('serves the publish, inspect, and clone workflow through MCP STDIO', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-context-mcp-service-'));
  const cloneDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-context-mcp-clones-'));
  const service = await startServer({ port: 0, dataDir });
  const client = startMcpClient(service.url, cloneDir);

  t.after(async () => {
    service.server.close();
    if (!client.child.killed) {
      client.child.kill();
    }
  });

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
  assert.equal(cloned.status, 'cloned');
  assert.equal(cloned.safety.toolsReplayed, false);
  assert.equal(cloned.safety.repositoryModified, false);
  await fs.access(path.join(cloneDir, 'mcp-clone.json'));
  assert.equal(client.getStderr(), '');
});
