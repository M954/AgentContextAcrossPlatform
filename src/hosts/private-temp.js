'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { stateFiles } = require('../config');

// mkdtemp's POSIX mode alone does not provide a private Windows ACL. Keep all
// plaintext staging data under a newly protected child, then remove our parent.
async function privateTemporary(prefix, parent) {
  if (parent) await stateFiles.privateDirectory(parent);
  const root = await fs.mkdtemp(path.join(parent || os.tmpdir(), prefix));
  try {
    const directory = await stateFiles.privateDirectory(path.join(root, 'private'));
    return {
      directory,
      async dispose() { await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); },
    };
  } catch (error) {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    throw error;
  }
}

module.exports = { privateTemporary };
