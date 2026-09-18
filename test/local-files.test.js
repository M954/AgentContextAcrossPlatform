'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { captureFiles } = require('../src/bundle');
const { readBoundedFile, writePrivateJson } = require('../src/local-files');
const { localUrl } = require('../src/client');
const fixture = require('../fixtures/sample-session.json');

test('explicit selected files remain inside workspace and bounded text-only capture', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-context-files-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'query.sql'), 'select 1;');
  const captured = await captureFiles(fixture, root, ['query.sql']);
  assert.equal(captured.files[0].content, 'select 1;');
  for (const selection of ['../query.sql', '.env', 'data.pfx', '.pi/agent/auth.json', '.pi/extensions/unsafe.ts']) {
    await assert.rejects(captureFiles(fixture, root, [selection]));
  }
  await fs.writeFile(path.join(root, 'binary.txt'), Buffer.from([0, 255]));
  await assert.rejects(captureFiles(fixture, root, ['binary.txt']));
  await fs.writeFile(path.join(root, 'large.txt'), Buffer.alloc(129 * 1024));
  await assert.rejects(captureFiles(fixture, root, ['large.txt']), /size limit/);
});

test('new private artifacts never overwrite existing files', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-context-exclusive-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'existing.json');
  await writePrivateJson(file, { original: true });
  await assert.rejects(writePrivateJson(file, { original: false }), { code: 'EEXIST' });
  assert.equal(JSON.parse((await readBoundedFile(file, 100)).toString()).original, true);
});

test('junctions and symlinks cannot bypass the workspace boundary', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-context-links-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const real = path.join(root, 'real');
  await fs.mkdir(real);
  await fs.writeFile(path.join(real, 'query.sql'), 'select 1;');
  await fs.symlink(real, path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(captureFiles(fixture, root, ['link/query.sql']), /links|junctions/);
  await assert.rejects(writePrivateJson(path.join(root, 'link', 'artifact.json'), {}), /links|junctions/);
});

test('loopback transport never accepts external or credential-bearing links', () => {
  assert.equal(localUrl('http://127.0.0.1:8787').origin, 'http://127.0.0.1:8787');
  assert.throws(() => localUrl('https://example.test'));
  assert.throws(() => localUrl('http://user:password@127.0.0.1:8787'));
  assert.throws(() => localUrl('http://127.0.0.1:8788', 'http://127.0.0.1:8787'));
});
