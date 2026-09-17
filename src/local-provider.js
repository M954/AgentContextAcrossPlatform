'use strict';

const { localUrl, requestJson } = require('./client');
const { contentHash } = require('./snapshot');
const { verifyBundle } = require('./bundle');

class LocalProvider {
  constructor(baseUrl = 'http://127.0.0.1:8787') {
    const url = localUrl(baseUrl);
    if (url.pathname !== '/' || url.search) throw new Error('Local service URL must be an origin');
    this.baseUrl = url.origin;
  }

  async resolveDestination() { return { baseUrl: this.baseUrl }; }

  async publish(bundle) {
    verifyBundle(bundle);
    const result = await requestJson(`${this.baseUrl}/v1/snapshots`, {
      method: 'POST', body: JSON.stringify({ bundle }),
    });
    this.validateLink(result.link);
    return { ...result, provider: 'local', bundleDigest: contentHash(bundle) };
  }

  validateLink(link) {
    const url = localUrl(link, this.baseUrl);
    if (!/^\/v1\/snapshots\/snap_[a-z0-9]+_[a-f0-9]+$/.test(url.pathname) || url.search) {
      throw new Error('Invalid local snapshot link');
    }
    return url.href;
  }

  async inspect(link, expectedDigest) {
    const valid = this.validateLink(link);
    const record = await requestJson(valid);
    const bundle = verifyBundle({ format: 'agent-context-bundle', bundleVersion: 1, record });
    const digest = contentHash(bundle);
    if (expectedDigest && digest !== expectedDigest) throw new Error('The snapshot changed; review it again');
    return { provider: 'local', link: valid, bundle, bundleDigest: digest, version: digest };
  }

  async revoke(publication) {
    const link = this.validateLink(publication.link);
    return requestJson(`${link}/revoke`, { method: 'POST' });
  }
}

module.exports = { LocalProvider };
