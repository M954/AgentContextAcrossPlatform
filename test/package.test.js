'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const manifest = require('../package.json');
const plugin = require('../plugin.json');
const lock = require('../package-lock.json');

test('the packaged CLI/MCP commands have runnable Node entry points and aligned versions', async () => {
  assert.deepEqual(manifest.bin, { 'agent-context': 'src/cli.js', 'agent-context-mcp': 'src/mcp-server.js' });
  for (const entry of Object.values(manifest.bin)) {
    const text = await fs.readFile(path.join(__dirname, '..', entry), 'utf8');
    assert.ok(text.startsWith('#!/usr/bin/env node\n') || text.startsWith('#!/usr/bin/env node\r\n'));
  }
  assert.equal(plugin.version, manifest.version);
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages[''].version, manifest.version);
  assert.deepEqual(lock.packages[''].bin, manifest.bin);
});
