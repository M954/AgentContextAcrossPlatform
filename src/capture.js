'use strict';

const path = require('node:path');
const { readBoundedFile } = require('./local-files');
const { timestampFields, definedFields } = require('./capture-common');
const { contentHash, prepareSnapshot, validateSessionSnapshot, MAX_SNAPSHOT_BYTES } = require('./snapshot');
const { normalizePiSession } = require('./pi-capture');

const MAX_CAPTURE_BYTES = MAX_SNAPSHOT_BYTES;

async function readCaptureFile(filePath) {
  if (typeof filePath !== 'string' || !filePath) throw new Error('Select one conversation file to capture');
  const parts = filePath.split(/[\\/]/);
  if (/^[\\/]{2}/.test(filePath) || parts.some(part => /^(?:\.env.*|\.ssh|\.aws|\.azure|credentials(?:\..*)?|auth\.json)$/i.test(part)) ||
      /\.(?:pem|key|pfx|p12)$/i.test(filePath)) {
    throw new Error('Refusing to capture a sensitive or network file path');
  }
  const bytes = await readBoundedFile(path.resolve(filePath), MAX_CAPTURE_BYTES);
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function textContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter(block => block && block.type === 'text' && typeof block.text === 'string')
      .map(block => block.text).join('\n');
  }
  return '';
}

function normalizeCapture(text, options = {}) {
  if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > MAX_CAPTURE_BYTES) {
    throw new Error('Conversation input must be non-empty UTF-8 text of at most 2 MiB');
  }
  let document;
  try { document = JSON.parse(text); } catch { /* JSONL or explicit plain-text export. */ }
  if (document?.schemaVersion && document?.source) {
    return { ...prepareSnapshot(document), format: 'normalized-snapshot' };
  }

  let host;
  let sessionId = 'exported-session';
  let records;
  let format;
  const omissions = [];
  const events = [];
  const add = (id, type, timestamp, data) => {
    events.push({ eventId: `${events.length}-${id || 'record'}`, type, ...timestampFields(timestamp), ...definedFields(data) });
  };

  if (Array.isArray(document?.messages)) {
    host = 'chat-export';
    format = 'chat-json';
    records = document.messages;
    for (const [index, message] of records.entries()) {
      if (!message || typeof message.role !== 'string') throw new Error('Invalid chat message');
      const content = textContent(message.content);
      if (content) add(String(index), 'historical_message', message.timestamp, { role: message.role, content });
      if (Array.isArray(message.content) && message.content.some(block => block?.type !== 'text')) {
        omissions.push({ record: index, reason: 'Non-text content was not captured' });
      }
    }
  } else if (/\.(?:md|txt)$/i.test(options.fileName || '')) {
    host = 'text-export';
    format = 'text';
    add('text', 'historical_text', undefined, { content: text });
  } else {
    try {
      records = text.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));
    } catch {
      throw new Error('Unsupported conversation format or incomplete JSONL; export again or use a .md/.txt export');
    }
    const start = records[0];
    if (records.slice(1).some(record => record?.type === 'session.start' || record?.type === 'session')) {
      throw new Error('Capture one session at a time; multiple session headers were found');
    }
    if (start?.type === 'session' && typeof start.id === 'string' && !start.externalId) {
      return normalizePiSession(records, options);
    }
    if (start?.type === 'session.start' && typeof start.data?.sessionId === 'string') {
      host = 'copilot-cli';
      format = 'copilot-events';
      sessionId = start.data.sessionId;
      for (const record of records.slice(1)) {
        const data = record?.data;
        if (['user.message', 'assistant.message'].includes(record?.type) && typeof data?.content === 'string') {
          add(record.id, 'historical_message', record.timestamp, { role: record.type.split('.')[0], content: data.content });
        } else if (['tool.execution_start', 'tool.execution_complete'].includes(record?.type) && data) {
          const selected = {};
          for (const key of ['toolName', 'toolCallId', 'arguments', 'result', 'error', 'success']) {
            if (data[key] !== undefined) selected[key] = data[key];
          }
          add(record.id, record.type === 'tool.execution_start' ? 'tool_request' : 'tool_result', record.timestamp, selected);
        } else {
          omissions.push({ record: record?.id || null, type: record?.type || null, reason: 'Unsupported or non-conversation event omitted' });
        }
      }
    } else if (start?.type === 'session' && start.version === 1 && typeof start.externalId === 'string') {
      host = 'copilot-interchange';
      format = 'copilot-semantic-jsonl';
      sessionId = start.externalId;
      for (const record of records.slice(1)) {
        if (record?.type === 'message' && typeof record.role === 'string' && textContent(record.content)) {
          add(record.id, 'historical_message', record.timestamp, { role: record.role, content: textContent(record.content) });
          if (Array.isArray(record.content) && record.content.some(block => block?.type !== 'text')) {
            omissions.push({ record: record.id || null, reason: 'Non-text message blocks omitted' });
          }
        } else {
          omissions.push({ record: record?.id || null, type: record?.type || null, reason: 'Unsupported interchange record omitted' });
        }
      }
    } else {
      throw new Error('Unsupported session format; use a normalized snapshot, chat JSON, pi/Copilot JSONL, or a Markdown export');
    }
  }
  if (!events.length) throw new Error('No supported conversation content was captured');
  const snapshot = {
    schemaVersion: '1.0',
    source: { host, sessionId, capture: { format, omissions, excluded: ['credentials', 'live connections', 'workspace files', 'non-text attachments'] } },
    task: { title: options.title || 'Shared coding-agent session', summary: 'Captured history; review the source records before continuing.' },
    events,
    workspace: {},
    resume: { nextAction: options.nextAction || 'Review the imported context and confirm the next local action with the recipient.' },
    omitted: omissions.map(item => `${item.record ?? 'record'}: ${item.reason}`),
  };
  const prepared = prepareSnapshot(snapshot);
  const digest = contentHash(prepared.snapshot.events);
  prepared.snapshot.source.capture.sourceDigest = `sha256:${digest}`;
  if (host === 'chat-export' || host === 'text-export') prepared.snapshot.source.sessionId = `capture-${digest.slice(0,24)}`;
  validateSessionSnapshot(prepared.snapshot);
  return { ...prepared, format };
}

async function captureFile(filePath, options = {}) {
  return normalizeCapture(await readCaptureFile(filePath), { ...options, fileName: filePath });
}

module.exports = { captureFile, normalizeCapture, readCaptureFile, MAX_CAPTURE_BYTES };
