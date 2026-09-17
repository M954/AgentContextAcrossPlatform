'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

async function assertNoLinks(target) {
  const absolute = path.resolve(target);
  const root = path.parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) {
        throw new Error('Symbolic links and junctions are not allowed in local handoff paths');
      }
    } catch (error) {
      if (error.code === 'ENOENT') break;
      throw error;
    }
  }
  return absolute;
}

async function privateDirectory(directory) {
  const absolute = await assertNoLinks(directory);
  await fs.mkdir(absolute, { recursive: true, mode: 0o700 });
  await assertNoLinks(absolute);
  return absolute;
}

async function readBoundedFile(file, limit) {
  const absolute = await assertNoLinks(file);
  const stat = await fs.lstat(absolute);
  if (!stat.isFile() || stat.size > limit) {
    throw new Error('Expected a regular file within the handoff size limit');
  }
  const handle = await fs.open(absolute, 'r');
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > limit || opened.ino !== stat.ino) {
      throw new Error('File changed during handoff capture');
    }
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > limit) throw new Error('File exceeds the handoff size limit');
    return buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
}

async function writePrivateJson(file, value, { replace = false } = {}) {
  const absolute = await assertNoLinks(file);
  await privateDirectory(path.dirname(absolute));
  if (!replace) {
    await fs.writeFile(absolute, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    return;
  }
  const temporary = `${absolute}.${crypto.randomBytes(12).toString('hex')}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    await assertNoLinks(absolute);
    await fs.rename(temporary, absolute);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

function containedPath(root, relative) {
  if (typeof relative !== 'string' || !relative || relative.includes('\0') ||
      path.isAbsolute(relative) || path.win32.isAbsolute(relative) ||
      relative.includes(':') || relative.includes('\\')) {
    throw new Error('Bundle paths must be portable relative paths');
  }
  const parts = relative.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' ||
      /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part) ||
      /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))) {
    throw new Error('Unsafe bundle path');
  }
  const resolved = path.resolve(root, ...parts);
  if (!resolved.startsWith(`${path.resolve(root)}${path.sep}`)) {
    throw new Error('Bundle path escapes its directory');
  }
  return resolved;
}

module.exports = { assertNoLinks, containedPath, privateDirectory, readBoundedFile, writePrivateJson };
