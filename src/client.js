'use strict';

const { boundedBody } = require('./graph-provider');
const { MAX_BUNDLE_BYTES } = require('./bundle');

function localUrl(value, base) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.username || url.password || url.hash || (base && url.origin !== new URL(base).origin)) {
    throw new Error('Local transport accepts only the configured loopback service');
  }
  return url;
}

async function requestJson(url, options = {}) {
  localUrl(url);
  const response = await fetch(url, {
    ...options,
    redirect: 'error',
    signal: AbortSignal.timeout(30000),
    headers: {
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  let body;
  try {
    body = JSON.parse((await boundedBody(response, MAX_BUNDLE_BYTES)).toString('utf8'));
  } catch {
    throw new Error('Local service returned an invalid or oversized response');
  }
  if (!response.ok) {
    throw new Error(`${response.status} ${body.error || 'Request failed'}`);
  }
  return body;
}

module.exports = {
  localUrl,
  requestJson,
};
