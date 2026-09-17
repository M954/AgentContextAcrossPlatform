'use strict';

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`${response.status} ${body.error || 'Request failed'}`);
  }
  return body;
}

module.exports = {
  requestJson,
};
