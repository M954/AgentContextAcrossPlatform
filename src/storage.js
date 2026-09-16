'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

function isSafeSnapshotId(snapshotId) {
  return /^snap_[a-z0-9]+_[a-f0-9]+$/.test(snapshotId);
}

class FileSnapshotStore {
  constructor(dataDir) {
    this.dataDir = path.resolve(dataDir);
    this.snapshotsDir = path.join(this.dataDir, 'snapshots');
  }

  async init() {
    await fs.mkdir(this.snapshotsDir, { recursive: true });
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
    try {
      await fs.access(destination);
      throw new Error(`Snapshot already exists: ${record.manifest.snapshotId}`);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }

    const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(record, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
    await fs.rename(temporary, destination);
    return record;
  }

  async get(snapshotId) {
    const file = this.filePath(snapshotId);
    try {
      return JSON.parse(await fs.readFile(file, 'utf8'));
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
    const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(record, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
    await fs.rename(temporary, destination);
    return record;
  }
}

module.exports = {
  FileSnapshotStore,
};
