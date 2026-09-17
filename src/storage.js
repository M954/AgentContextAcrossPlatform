'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { privateDirectory, readBoundedFile, writePrivateJson } = require('./local-files');
const { MAX_BUNDLE_BYTES } = require('./bundle');

function isSafeSnapshotId(snapshotId) {
  return /^snap_[a-z0-9]+_[a-f0-9]+$/.test(snapshotId);
}

class FileSnapshotStore {
  constructor(dataDir) {
    this.dataDir = path.resolve(dataDir);
    this.snapshotsDir = path.join(this.dataDir, 'snapshots');
  }

  async init() {
    await privateDirectory(this.snapshotsDir);
  }

  filePath(snapshotId) {
    if (!isSafeSnapshotId(snapshotId)) {
      throw new Error('Invalid snapshot ID');
    }
    return path.join(this.snapshotsDir, `${snapshotId}.json`);
  }

  async save(record) {
    await this.init();
    const destination = this.filePath(record.manifest.snapshotId);
    await writePrivateJson(destination, record);
    return record;
  }

  async get(snapshotId) {
    const file = this.filePath(snapshotId);
    try {
      return JSON.parse((await readBoundedFile(file, MAX_BUNDLE_BYTES * 2)).toString('utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  async revoke(snapshotId) {
    const record = await this.get(snapshotId);
    if (!record) {
      return null;
    }

    record.manifest.revokedAt = new Date().toISOString();
    const destination = this.filePath(snapshotId);
    await writePrivateJson(destination, record, { replace: true });
    return record;
  }
}

module.exports = {
  FileSnapshotStore,
};
