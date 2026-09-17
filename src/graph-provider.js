'use strict';

const { MAX_BUNDLE_BYTES, parseBundle, verifyBundle } = require('./bundle');
const { canonicalJson, contentHash } = require('./snapshot');

const GRAPH = 'https://graph.microsoft.com/v1.0';
const TIMEOUT_MS = 30000;
const MAX_METADATA_BYTES = 256 * 1024;

class GraphError extends Error {
  constructor(status, code = 'GRAPH_REQUEST_FAILED') {
    super(`Microsoft Graph request failed (${status}, ${code}). Check sign-in, consent, sharing policy and file access.`);
    this.name = 'GraphError';
    this.status = status;
    this.code = code;
  }
}

async function boundedBody(response, limit) {
  const declared = response.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
    await response.body?.cancel();
    throw new Error('Response exceeds the handoff size limit');
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) throw new Error('Response exceeds the handoff size limit');
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks);
}

function httpsUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid Microsoft sharing URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash ||
      value.length > 8192 || /[\x00-\x20\\]/.test(value)) {
    throw new Error('Only HTTPS Microsoft sharing URLs without credentials or fragments are accepted');
  }
  return url;
}

function sharingUrl(value, config) {
  const url = httpsUrl(value);
  if (!['onedrive.cloud.microsoft', '1drv.ms', ...config.sharepointHosts].includes(url.hostname)) {
    throw new Error('Sharing host is not configured. Add the exact trusted SharePoint hostname locally.');
  }
  return url.href;
}

function transferUrl(value, config) {
  const url = httpsUrl(value);
  if (!config.sharepointHosts.includes(url.hostname) &&
      !config.downloadHosts.includes(url.hostname) &&
      !url.hostname.endsWith('.1drv.com')) {
    throw new Error('Graph returned an untrusted transfer host; no data or token was sent to it');
  }
  return url.href;
}

function sharingToken(link) {
  return `u!${Buffer.from(link, 'utf8').toString('base64url')}`;
}

function id(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9!_.-]{1,256}$/.test(value)) {
    throw new Error('Invalid Microsoft Graph resource identifier');
  }
  return encodeURIComponent(value);
}

function readLink(permission, config) {
  if (!permission || permission.link?.scope !== 'users' || permission.link?.type !== 'view' ||
      permission.link.preventsDownload === true || !Array.isArray(permission.roles) ||
      permission.roles.length !== 1 || permission.roles[0] !== 'read') {
    throw new Error('Graph did not return a downloadable, specific-people, read-only link');
  }
  return sharingUrl(permission.link.webUrl, config);
}

class GraphProvider {
  constructor(config, auth, { fetchImpl = fetch } = {}) {
    this.config = config;
    this.auth = auth;
    this.fetch = fetchImpl;
  }

  async fetchResponse(url, options = {}) {
    try {
      return await this.fetch(url, { ...options, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      throw new Error('Microsoft file transfer failed or timed out; no credentials or response contents were logged');
    }
  }

  async jsonResponse(response, expected = [200]) {
    const bytes = await boundedBody(response, MAX_METADATA_BYTES);
    let body = {};
    if (bytes.length) {
      try { body = JSON.parse(bytes.toString('utf8')); } catch {
        throw new Error('Microsoft Graph returned an invalid response');
      }
    }
    if (!expected.includes(response.status)) {
      const code = body.error?.code;
      throw new GraphError(response.status, typeof code === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(code) ? code : undefined);
    }
    return body;
  }

  async request(apiPath, { method = 'GET', body, headers = {}, expected = [200] } = {}) {
    if (!apiPath.startsWith('/') || apiPath.includes('://')) throw new Error('Invalid Graph API path');
    const token = await this.auth.getAccessToken();
    const response = await this.fetchResponse(`${GRAPH}${apiPath}`, {
      method,
      headers: { Accept: 'application/json', ...headers, Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return this.jsonResponse(response, expected);
  }

  async resolveDestination() {
    const drivePath = this.config.driveId === 'me' ? '/me/drive' : `/drives/${id(this.config.driveId)}`;
    const drive = await this.request(`${drivePath}?$select=id,driveType`);
    if (!['business', 'documentLibrary'].includes(drive.driveType)) {
      throw new Error('This release supports OneDrive work/school and SharePoint, not consumer OneDrive');
    }
    const folderPath = this.config.folderId === 'root' ? 'root' : `items/${id(this.config.folderId)}`;
    const folder = await this.request(`/drives/${id(drive.id)}/${folderPath}?$select=id,name,folder,webUrl`);
    if (!folder.folder) throw new Error('The configured upload destination must be a folder');
    return { driveId: drive.id, folderId: folder.id, name: folder.name,
      webUrl: sharingUrl(folder.webUrl, this.config) };
  }

  async publish(bundle, destination, recipients) {
    verifyBundle(bundle);
    if (!Array.isArray(recipients) || !recipients.length || recipients.length > 20 ||
        recipients.some((recipient) => typeof recipient !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient))) {
      throw new Error('Choose between 1 and 20 explicit recipient email addresses');
    }
    const fileName = `${bundle.record.manifest.snapshotId}.${contentHash(bundle)}.agent-session.json`;
    const itemRoot = `/drives/${id(destination.driveId)}/items`;
    const upload = await this.request(`${itemRoot}/${id(destination.folderId)}:/${fileName}:/createUploadSession`, {
      method: 'POST', body: { item: { name: fileName, '@microsoft.graph.conflictBehavior': 'fail' } },
    });
    const uploadUrl = transferUrl(upload.uploadUrl, this.config);
    const bytes = Buffer.from(canonicalJson(bundle));
    let item;
    try {
      const uploaded = await this.fetchResponse(uploadUrl, {
        method: 'PUT', headers: { 'Content-Type': 'application/octet-stream',
          'Content-Length': String(bytes.length), 'Content-Range': `bytes 0-${bytes.length - 1}/${bytes.length}` },
        body: bytes,
      });
      item = await this.jsonResponse(uploaded, [200, 201]);
      id(item.id);
      if (!item.file || item.name !== fileName || item.size !== bytes.length) {
        throw new Error('Uploaded file metadata does not match the reviewed bundle');
      }
      const created = await this.request(`${itemRoot}/${id(item.id)}/createLink`, {
        method: 'POST', expected: [200, 201],
        body: { type: 'view', scope: 'users', retainInheritedPermissions: true },
      });
      const firstLink = readLink(created, this.config);
      const granted = await this.request(`/shares/${sharingToken(firstLink)}/permission/grant`, {
        method: 'POST', body: { recipients: recipients.map((email) => ({ email })), roles: ['read'] },
      });
      if (!Array.isArray(granted.value) || granted.value.some((entry) => entry.error)) {
        throw new Error('Graph did not confirm all requested sharing grants');
      }
      const updated = granted.value.find((permission) => permission.link?.scope === 'users');
      const link = readLink(updated, this.config);
      id(updated.id);
      return {
        provider: 'onedrive', link, snapshotId: bundle.record.manifest.snapshotId,
        bundleDigest: contentHash(bundle), driveId: destination.driveId, itemId: item.id,
        permissionId: updated.id, recipients, fileName, eTag: item.eTag || null,
        warning: 'Specific-people sharing does not remove inherited destination access. Downloaded copies cannot be revoked.',
      };
    } catch (cause) {
      try {
        if (item?.id) {
          await this.request(`${itemRoot}/${id(item.id)}`, { method: 'DELETE', expected: [204] });
        } else {
          const cancelled = await this.fetchResponse(uploadUrl, { method: 'DELETE' });
          await this.jsonResponse(cancelled, [204]);
        }
      } catch {
        const failure = new Error('Publishing failed and remote cleanup could not be confirmed. Inspect the configured OneDrive folder before retrying.');
        failure.recovery = { driveId: destination.driveId, itemId: item?.id || null, fileName };
        throw failure;
      }
      throw new Error(`Publishing failed; the created item or upload session was removed. ${cause instanceof GraphError ? cause.message : 'No sharing link was returned.'}`);
    }
  }

  async inspect(link, expectedDigest) {
    const validLink = sharingUrl(link, this.config);
    const item = await this.request(`/shares/${sharingToken(validLink)}/driveItem?$select=id,name,size,file,folder,parentReference,eTag`);
    if (!item.file || item.folder || !Number.isSafeInteger(item.size) || item.size > MAX_BUNDLE_BYTES) {
      throw new Error('The shared item must be a bounded session-bundle file, not a folder');
    }
    const match = /^snap_[a-z0-9]+_[a-f0-9]+\.([a-f0-9]{64})\.agent-session\.json$/.exec(item.name || '');
    if (!match) throw new Error('The link is not an exported AgentContext session bundle');
    const token = await this.auth.getAccessToken();
    const response = await this.fetchResponse(`${GRAPH}/drives/${id(item.parentReference?.driveId)}/items/${id(item.id)}/content`, {
      headers: { Authorization: `Bearer ${token}`, ...(item.eTag ? { 'If-Match': item.eTag } : {}) },
    });
    let content = response;
    if (response.status === 302) {
      const location = transferUrl(response.headers.get('location'), this.config);
      await response.body?.cancel();
      // Preauthenticated URLs must never receive the Microsoft Graph token.
      content = await this.fetchResponse(location);
    }
    if (content.status !== 200) await this.jsonResponse(content);
    const bundle = parseBundle(await boundedBody(content, MAX_BUNDLE_BYTES));
    const digest = contentHash(bundle);
    if (digest !== match[1] || (expectedDigest && expectedDigest !== digest)) {
      throw new Error('The shared bundle changed or its digest does not match; review a new publication');
    }
    return { provider: 'onedrive', link: validLink, bundle, bundleDigest: digest,
      version: item.eTag || null, itemId: item.id, driveId: item.parentReference.driveId };
  }

  async revoke(publication) {
    await this.request(`/drives/${id(publication.driveId)}/items/${id(publication.itemId)}/permissions/${id(publication.permissionId)}`,
      { method: 'DELETE', expected: [204] });
    return { status: 'link-revoked', warning: 'Existing direct/inherited access and downloaded copies are not revoked.' };
  }
}

module.exports = { GraphError, GraphProvider, boundedBody, sharingToken, sharingUrl, transferUrl };
