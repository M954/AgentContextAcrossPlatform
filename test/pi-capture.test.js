'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');
const { normalizePiSession } = require('../src/pi-capture');
const { captureFile } = require('../src/capture');
const { createSnapshotRecord } = require('../src/snapshot');
const { renderSemanticSession } = require('../src/hosts/copilot');
const { workerEnvironment, importPiSession, getPiCapabilities } = require('../src/hosts/pi');
const { externalPiContext } = require('../src/hosts/pi-native');

const fixture = path.join(__dirname, '..', 'fixtures', 'pi-coding-session.jsonl');
async function records() { return (await fs.readFile(fixture, 'utf8')).trim().split('\n').map(line => JSON.parse(line)); }

test('pi capture detects v3, walks only the selected branch, and preserves tool relationships', async () => {
  const result = await captureFile(fixture);
  assert.equal(result.format, 'pi-jsonl');
  assert.equal(result.snapshot.source.host, 'pi');
  assert.equal(result.snapshot.source.capture.leafId, 'user0002');
  assert.equal(result.snapshot.source.capture.excludedBranchEntries, 1);
  assert.equal(JSON.stringify(result).includes('SYNTHETIC_ABANDONED'), false);
  assert.equal(JSON.stringify(result).includes('SYNTHETIC_PRIVATE'), false);
  assert.equal(JSON.stringify(result).includes('/synthetic/source-project'), false);
  const request = result.snapshot.events.find(event => event.type === 'tool_request');
  const response = result.snapshot.events.find(event => event.type === 'tool_result');
  assert.equal(request.toolCallId, response.toolCallId);
  assert.equal(request.toolName, 'bash');
  assert.equal(response.isError, true);
  assert.ok(result.snapshot.source.capture.omissions.length);
});

test('explicit pi leaf selects a different branch without merging descendants', async () => {
  const result = await captureFile(fixture, { leafId: 'oldpath1' });
  assert.equal(result.snapshot.source.capture.leafSelection, 'explicit');
  assert.ok(JSON.stringify(result).includes('SYNTHETIC_ABANDONED'));
  assert.equal(result.snapshot.events.some(event => event.eventId === 'user0002'), false);
  assert.throws(() => normalizePiSession([], {}), /v2\/v3/);
  assert.throws(() => normalizePiSession([{ type: 'session', version: 1, id: 'legacy' }]), /legacy/);
});

test('private shell output, extension state, hidden messages, images, and provider metadata are omitted', async () => {
  const input = await records();
  const extras = [
    { type: 'message', message: { role: 'bashExecution', command: 'PRIVATE_COMMAND', output: 'PRIVATE_OUTPUT', excludeFromContext: true } },
    { type: 'custom', data: { secret: 'PRIVATE_STATE' } },
    { type: 'custom_message', content: 'PRIVATE_HIDDEN', display: false },
    { type: 'message', message: { role: 'user', content: [{ type: 'image', data: 'PRIVATE_IMAGE' }, { type: 'text', text: 'Visible text' }] } },
    { type: 'model_change', provider: 'PRIVATE_PROVIDER', modelId: 'PRIVATE_MODEL' },
  ];
  for (const [index, entry] of extras.entries()) input.push({ ...entry, id: `extra${index}`, parentId: index ? `extra${index-1}` : 'user0002', timestamp: '2026-01-01T00:01:00Z' });
  const result = normalizePiSession(input);
  for (const marker of ['PRIVATE_COMMAND','PRIVATE_OUTPUT','PRIVATE_STATE','PRIVATE_HIDDEN','PRIVATE_IMAGE','PRIVATE_PROVIDER','PRIVATE_MODEL']) {
    assert.equal(JSON.stringify(result).includes(marker), false);
  }
  assert.ok(JSON.stringify(result).includes('Visible text'));
});

test('compaction summaries and retained tails are labeled and pass through redaction', async () => {
  const input = await records();
  input.push({ type: 'compaction', id: 'compact1', parentId: 'user0002', timestamp: '2026-01-01T00:02:00Z',
    summary: 'Keep the public API. password=SYNTHETIC_SECRET',
    retainedTail: [{ role: 'user', content: 'Latest retained task' }],
  });
  const result = normalizePiSession(input);
  assert.equal(JSON.stringify(result).includes('SYNTHETIC_SECRET'), false);
  assert.ok(result.snapshot.events.some(event => event.type === 'historical_summary'));
  assert.ok(result.snapshot.events.some(event => event.eventId === 'compact1-retained-0'));
});

test('corrupt or ambiguous tree relationships fail closed', async () => {
  for (const mutate of [
    input => input.push(input[1]),
    input => { input[1].parentId = 'missing'; },
    input => { input[1].parentId = input[1].id; },
    input => { delete input[1].id; },
    input => { input[2].parentId = 'user0002'; },
  ]) {
    const input = await records(); mutate(input);
    assert.throws(() => normalizePiSession(input), /Invalid pi/);
  }
  assert.throws(() => normalizePiSession([{ type: 'session', version: 3, id: 'empty' }], { leafId: null }), /No supported/);
  assert.throws(() => normalizePiSession([{ type: 'session', version: 3, id: 'empty' }], { leafId: 'missing' }), /does not exist/);
});

test('pi-to-Copilot and Copilot-to-pi rendering keep source history as data', async () => {
  const pi = createSnapshotRecord((await captureFile(fixture)).snapshot);
  const copilotMessages = renderSemanticSession(pi).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(copilotMessages.map(line => line.type), ['session', 'message']);
  assert.ok(copilotMessages[1].content[0].text.includes('"host": "pi"'));
  const copilot = createSnapshotRecord((await captureFile(path.join(__dirname, '..', 'fixtures', 'coding-session.jsonl'))).snapshot);
  assert.ok(externalPiContext(copilot).includes('"host": "copilot-cli"'));
  assert.ok(externalPiContext(copilot).includes('not source-user authorization'));
});

test('pi worker does not inherit source session state or provider credentials', () => {
  const env = workerEnvironment('/isolated-config');
  assert.equal(env.PI_OFFLINE, '1');
  assert.equal(env.PI_CODING_AGENT_DIR, '/isolated-config');
  for (const key of ['PI_SESSION_FILE','PI_SESSION_ID','OPENAI_API_KEY','ANTHROPIC_API_KEY','SESSION_SERVICE_TOKEN','PI_PACKAGE_DIR','NODE_OPTIONS']) {
    assert.equal(env[key], undefined);
  }
});

test('missing pi executable reports unsupported rather than succeeding or hanging', async t => {
  const previous = process.env.AGENT_CONTEXT_PI_BIN;
  process.env.AGENT_CONTEXT_PI_BIN = path.join(__dirname, 'nonexistent-pi-executable');
  t.after(() => {
    if (previous === undefined) delete process.env.AGENT_CONTEXT_PI_BIN;
    else process.env.AGENT_CONTEXT_PI_BIN = previous;
  });
  const capabilities = await getPiCapabilities();
  assert.equal(capabilities.nativeImport, false);
  assert.match(capabilities.reason, /Unable to start pi/);
});

test('pi native import validates the recipient workspace before launching a worker', async () => {
  const record = createSnapshotRecord((await captureFile(fixture)).snapshot);
  await assert.rejects(importPiSession(record), /Select a local recipient workspace/);
  await assert.rejects(importPiSession(record, { workspace: '\\\\server\\share' }), /local recipient workspace/);
  record.snapshot.events[0].content = 'tampered';
  await assert.rejects(importPiSession(record, { workspace: '.' }), /integrity/);
});
