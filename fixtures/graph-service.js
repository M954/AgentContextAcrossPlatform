'use strict';

// In-memory Graph contract fixture. It never makes network requests or uses real credentials.
const assert = require('node:assert/strict');
const { sharingToken } = require('../src/graph-provider');

function graphFixture() {
  const config = { clientId: null, tenantId: null, scopes: ['Files.ReadWrite'],
    sharepointHosts: ['tenant.sharepoint.com', 'tenant-my.sharepoint.com'], downloadHosts: [],
    driveId: 'me', folderId: 'root' };
  const files = new Map();
  const uploads = new Map();
  const calls = [];
  const faults = {};
  let sequence = 0;
  const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), {
    status, headers: { 'Content-Type': 'application/json', ...headers },
  });
  const noContent = () => new Response(null, { status: 204 });
  const denied = () => json({ error: { code: 'accessDenied' } }, 403);
  const metadata = (file) => ({ id: file.id, name: file.name, size: file.bytes.length, file: {},
    parentReference: { driveId: 'drive-a' }, eTag: file.version });
  const permission = (file, updated = false) => ({ id: `perm-${file.id}`, roles: ['read'],
    link: { type: 'view', scope: 'users', preventsDownload: false,
      webUrl: updated ? file.link : `https://onedrive.cloud.microsoft/:u:/test/${file.id}` } });
  const canRead = (file, user) => file && !file.revoked &&
    (file.owner === user || file.recipients.includes(`${user}@example.test`));
  const auth = (user) => ({
    getIdentity: async () => `synthetic-identity-${user}`,
    getAccessToken: async () => `synthetic-token-${user}`,
  });

  const fetchImpl = async (input, options = {}) => {
    const url = new URL(input);
    const method = options.method || 'GET';
    calls.push({ url: url.href, method, headers: options.headers, body: options.body });
    assert.equal(options.redirect, 'manual');
    if (url.hostname !== 'graph.microsoft.com') {
      assert.equal(options.headers?.Authorization, undefined, 'Graph credentials must not reach transfer URLs');
      if (url.hostname === 'synthetic.up.1drv.com') {
        const upload = uploads.get(url.pathname.slice(1));
        assert.ok(upload);
        if (method === 'DELETE') { uploads.delete(url.pathname.slice(1)); return noContent(); }
        assert.equal(method, 'PUT');
        const bytes = Buffer.from(options.body);
        assert.equal(options.headers['Content-Range'], `bytes 0-${bytes.length - 1}/${bytes.length}`);
        const file = { id: `file-${++sequence}`, name: upload.name, bytes, owner: upload.owner,
          recipients: [], version: '"v1"', revoked: false };
        file.link = `https://tenant.sharepoint.com/:u:/t/snapshots/${file.id}`;
        files.set(file.id, file);
        return json(metadata(file), 201);
      }
      assert.equal(url.hostname, 'tenant-my.sharepoint.com');
      const file = files.get(url.pathname.split('/').pop());
      if (faults.downloadRedirect) return new Response(null, { status: 302, headers: { location: 'https://evil.invalid/data' } });
      if (faults.oversized) return new Response('x', { status: 200, headers: { 'Content-Length': '99999999' } });
      return new Response(file.bytes, { status: 200 });
    }
    const user = options.headers?.Authorization?.replace('Bearer synthetic-token-', '');
    if (!['a', 'b', 'c'].includes(user)) return denied();
    const route = url.pathname.slice('/v1.0'.length);
    if (route === '/me/drive') return json({ id: 'drive-a', driveType: faults.personal ? 'personal' : 'business' });
    if (route === '/drives/drive-a/root') return json({ id: 'folder-a', name: 'Synthetic private folder',
      folder: {}, webUrl: 'https://tenant-my.sharepoint.com/personal/a/documents' });
    if (route.endsWith('/createUploadSession')) {
      assert.equal(method, 'POST');
      const body = JSON.parse(options.body);
      assert.equal(body.item['@microsoft.graph.conflictBehavior'], 'fail');
      assert.equal(files.size, 0);
      const uploadId = `upload-${++sequence}`;
      uploads.set(uploadId, { name: body.item.name, owner: user });
      return json({ uploadUrl: `https://synthetic.up.1drv.com/${uploadId}` });
    }
    if (route.startsWith('/shares/')) {
      const encoded = route.split('/')[2];
      const file = [...files.values()].find((item) => [item.link, permission(item).link.webUrl].some((link) => sharingToken(link) === encoded));
      if (route.endsWith('/permission/grant')) {
        if (file?.owner !== user) return denied();
        const grant = JSON.parse(options.body);
        assert.deepEqual(grant.roles, ['read']);
        assert.equal(grant.recipients.length, 1);
        assert.deepEqual(grant.recipients, [{ email: 'b@example.test' }]);
        if (faults.grantDenied) return denied();
        if (faults.partialGrant) return json({ value: [{ error: { code: 'accessDenied' } }] }, 207);
        file.recipients = grant.recipients.map((recipient) => recipient.email);
        return json({ value: [permission(file, true)] });
      }
      if (!canRead(file, user)) return denied();
      return json(metadata(file));
    }
    const [, , , , fileId, action] = route.split('/');
    const file = files.get(fileId);
    if (method === 'DELETE') {
      if (file?.owner !== user) return denied();
      if (faults.cleanupDenied) return denied();
      if (action === 'permissions') file.revoked = true;
      else files.delete(fileId);
      return noContent();
    }
    if (action === 'createLink') {
      if (file?.owner !== user) return denied();
      const body = JSON.parse(options.body);
      assert.deepEqual(body, { type: 'view', scope: 'users', retainInheritedPermissions: true });
      if (faults.broadLink) {
        const broad = permission(file);
        broad.link.scope = 'anonymous';
        return json(broad, 201);
      }
      return json(permission(file), 201);
    }
    if (action === 'content') {
      if (!canRead(file, user)) return denied();
      return new Response(null, { status: 302, headers: { location: faults.untrustedRedirect
        ? 'https://evil.invalid/data' : `https://tenant-my.sharepoint.com/download/${file.id}?cap=synthetic` } });
    }
    throw new Error(`Unhandled synthetic Graph route: ${method} ${route}`);
  };
  return { config, files, uploads, calls, faults, auth, fetchImpl };
}

module.exports = { graphFixture };
