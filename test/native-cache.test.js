'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { stateFiles } = require('../src/config');

test('Windows native persistence encrypts a synthetic value without using an account or network',
  { skip: process.platform !== 'win32' }, async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-context-native-cache-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const directory = await stateFiles.privateDirectory(path.join(root, 'private'));
    const file = path.join(directory, 'synthetic-cache.bin');
    const { FilePersistenceWithDataProtection, DataProtectionScope } = require('@azure/msal-node-extensions');
    const persistence = await FilePersistenceWithDataProtection.create(
      file, DataProtectionScope.CurrentUser, 'agent-context-synthetic-cache-test',
      { loggerCallback() {}, piiLoggingEnabled: false, logLevel: 0 });
    const sentinel = 'synthetic-value-not-a-user-credential';
    await persistence.save(sentinel);
    assert.equal((await fs.readFile(file)).includes(Buffer.from(sentinel)), false);
    assert.equal(await persistence.load(), sentinel);
    await persistence.delete();
  });
