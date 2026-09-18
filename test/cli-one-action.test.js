'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const readline = require('node:readline/promises');
const { startServer } = require('../src/server');
const { main } = require('../src/cli');
const fixture = require('../fixtures/sample-session.json');

test('interactive CLI share and resume each finish in one invocation after synthetic human confirmation', { timeout: 120000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-context-cli-quick-'));
  const service = await startServer({ port: 0, dataDir: path.join(root, 'service') });
  const oldArgs = process.argv;
  const oldHome = process.env.AGENT_CONTEXT_HOME;
  const oldUrl = process.env.SESSION_SERVICE_URL;
  const stdinTty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  const stdoutTty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  t.after(async () => {
    t.mock.restoreAll();
    process.argv = oldArgs;
    if (oldHome === undefined) delete process.env.AGENT_CONTEXT_HOME;
    else process.env.AGENT_CONTEXT_HOME = oldHome;
    if (oldUrl === undefined) delete process.env.SESSION_SERVICE_URL;
    else process.env.SESSION_SERVICE_URL = oldUrl;
    if (stdinTty) Object.defineProperty(process.stdin, 'isTTY', stdinTty);
    else delete process.stdin.isTTY;
    if (stdoutTty) Object.defineProperty(process.stdout, 'isTTY', stdoutTty);
    else delete process.stdout.isTTY;
    await new Promise((resolve, reject) => service.server.close((error) => error ? reject(error) : resolve()));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  process.env.AGENT_CONTEXT_HOME = path.join(root, 'private-client');
  process.env.SESSION_SERVICE_URL = service.url;
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
  const output = [];
  let accept = true;
  let confirmations = 0;
  t.mock.method(console, 'log', (message) => output.push(message));
  t.mock.method(readline, 'createInterface', () => ({
    question: async (prompt) => {
      confirmations++;
      const phrase = prompt.match(/^Type "([^"]+)" to approve this exact action/);
      assert.ok(phrase);
      return accept ? phrase[1] : '';
    },
    close() {},
  }));
  const file = path.join(root, 'source.json');
  await fs.writeFile(file, JSON.stringify(fixture));
  process.argv = [process.execPath, 'cli.js', 'share', '--provider', 'local', '--input', file];
  await main();
  const publication = JSON.parse(output.at(-1));
  assert.equal(publication.status, 'published');
  assert.equal(confirmations, 1);
  process.argv = [process.execPath, 'cli.js', 'resume', publication.link];
  await main();
  const imported = JSON.parse(output.at(-1));
  assert.equal(imported.status, 'context_imported');
  assert.equal(imported.safety.toolsReplayed, false);
  assert.equal(confirmations, 2);
  await fs.access(imported.contextPath);
  accept = false;
  const before = await fs.readdir(service.store.snapshotsDir);
  process.argv = [process.execPath, 'cli.js', 'share', '--provider', 'local', '--input', file];
  await main();
  assert.equal(JSON.parse(output.at(-1)).status, 'cancelled');
  assert.deepEqual(await fs.readdir(service.store.snapshotsDir), before);
});
