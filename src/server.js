'use strict';

const http = require('node:http');
const path = require('node:path');

const {
  SecretDetectionError,
  createSnapshotRecord,
  isSnapshotAccessible,
  prepareSnapshot,
  verifySnapshotRecord,
} = require('./snapshot');
const { FileSnapshotStore } = require('./storage');
const { MAX_BUNDLE_BYTES, verifyBundle } = require('./bundle');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8787;
const MAX_BODY_BYTES = MAX_BUNDLE_BYTES;

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
  }
}

function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body, 'utf8'),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(body);
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    const declaredLength = Number(request.headers['content-length'] || 0);
    if (declaredLength > MAX_BODY_BYTES) {
      reject(new HttpError(413, `Request body exceeds ${MAX_BODY_BYTES} bytes`));
      request.resume();
      return;
    }

    const chunks = [];
    let total = 0;
    request.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        request.destroy();
        reject(new HttpError(413, `Request body exceeds ${MAX_BODY_BYTES} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new HttpError(400, 'Request body must be valid JSON'));
      }
    });
    request.on('error', (error) => reject(error));
  });
}

function assertLoopback(host) {
  if (host !== '127.0.0.1' && host !== '::1' && host !== 'localhost') {
    throw new Error(
      'The local prototype only binds to loopback. Production network access requires an authenticated service.',
    );
  }
}

function getLinkBase(request) {
  const address = request.socket.localAddress;
  return `http://${address.includes(':') ? `[${address}]` : address}:${request.socket.localPort}`;
}

function getSnapshotRoute(pathname) {
  const match = pathname.match(/^\/v1\/snapshots\/([^/]+)(\/download|\/revoke)?$/);
  if (!match) {
    return null;
  }
  return { snapshotId: match[1], action: match[2] || '' };
}

function createServer(options = {}) {
  const dataDir = options.dataDir || path.join(process.cwd(), '.data');
  const store = new FileSnapshotStore(dataDir);

  const server = http.createServer(async (request, response) => {
    try {
      const listenerOrigin = getLinkBase(request);
      const host = request.headers.host;
      if (![new URL(listenerOrigin).host, `localhost:${request.socket.localPort}`].includes(host)) {
        throw new HttpError(403, 'Host is not allowed');
      }
      const origin = `http://${host}`;
      if (request.headers.origin && request.headers.origin !== origin) {
        throw new HttpError(403, 'Browser origin is not allowed');
      }
      const requestUrl = new URL(request.url, origin);

      if (request.method === 'GET' && requestUrl.pathname === '/healthz') {
        sendJson(response, 200, { status: 'ok', service: 'agent-context-session-service' });
        return;
      }

      if (request.method === 'POST' && requestUrl.pathname === '/v1/snapshots') {
        if (!request.headers['content-type']?.startsWith('application/json')) {
          throw new HttpError(415, 'Expected application/json');
        }
        const body = await readJson(request);
        if (body.bundle) {
          const bundle = verifyBundle(body.bundle);
          await store.save(bundle.record);
          sendJson(response, 201, { snapshotId: bundle.record.manifest.snapshotId,
            link: `${origin}/v1/snapshots/${bundle.record.manifest.snapshotId}`,
            manifest: bundle.record.manifest });
          return;
        }
        const rawSnapshot = body.snapshot || body;
        const prepared = prepareSnapshot(rawSnapshot);
        const access = body.access || { mode: 'local', expiresAt: null };

        if (access.mode !== 'local') {
          throw new HttpError(
            400,
            'The local prototype only accepts local access mode; configure production authentication before sharing remotely.',
          );
        }

        const record = createSnapshotRecord(prepared.snapshot, {
          access,
          redactions: prepared.redactions,
          parentSnapshotId: body.parentSnapshotId || null,
        });
        await store.save(record);

        sendJson(response, 201, {
          snapshotId: record.manifest.snapshotId,
          link: `${origin}/v1/snapshots/${record.manifest.snapshotId}`,
          manifest: record.manifest,
        });
        return;
      }

      const route = getSnapshotRoute(requestUrl.pathname);
      if (route) {
        const record = await store.get(route.snapshotId);
        if (!record) {
          throw new HttpError(404, 'Snapshot not found');
        }

        verifySnapshotRecord(record);

        if (request.method === 'POST' && route.action === '/revoke') {
          const revoked = await store.revoke(route.snapshotId);
          sendJson(response, 200, { snapshotId: route.snapshotId, revokedAt: revoked.manifest.revokedAt });
          return;
        }

        if (request.method !== 'GET') {
          throw new HttpError(405, 'Method not allowed');
        }

        if (!isSnapshotAccessible(record)) {
          throw new HttpError(410, 'Snapshot is expired or revoked');
        }

        sendJson(response, 200, record);
        return;
      }

      throw new HttpError(404, 'Route not found');
    } catch (error) {
      const statusCode =
        error instanceof HttpError
          ? error.statusCode
          : error instanceof SecretDetectionError
            ? 422
            : 500;
      sendJson(response, statusCode, {
        error: statusCode === 500 ? 'Local snapshot request failed' : error.message,
        type: error.name || 'Error',
      });
    }
  });

  return { server, store, dataDir };
}

async function startServer(options = {}) {
  const host = options.host || DEFAULT_HOST;
  const port = options.port === undefined ? DEFAULT_PORT : options.port;
  assertLoopback(host);

  const app = createServer(options);
  await app.store.init();
  await new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(port, host, resolve);
  });

  const address = app.server.address();
  const url = `http://${host.includes(':') ? `[${host}]` : host}:${address.port}`;
  return { ...app, host, port: address.port, url };
}

module.exports = {
  DEFAULT_HOST,
  DEFAULT_PORT,
  MAX_BODY_BYTES,
  createServer,
  startServer,
};
