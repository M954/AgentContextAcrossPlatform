'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { workerEnvironment, importPiSession } = require('../src/hosts/pi');
const { captureFile } = require('../src/capture');
const { createSnapshotRecord } = require('../src/snapshot');
const { startServer } = require('../src/server');

const options = { skip: process.env.AGENT_CONTEXT_TEST_PI !== '1', timeout: 180000 };

async function temp(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-integration-'));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  return root;
}

function rpc(root, sessionFile, environment) {
  const child = spawn(process.env.AGENT_CONTEXT_PI_BIN || 'pi', [
    '--mode','rpc','--offline','--no-extensions','--no-tools','--no-skills','--no-themes',
    '--no-prompt-templates','--no-context-files','--no-approve','--session',sessionFile,
    '-e',path.resolve(__dirname,'..','extensions','pi-session.ts'),
  ], { cwd: root, env: workerEnvironment(path.join(root,'config'), environment), stdio: ['pipe','pipe','pipe'] });
  const events = [];
  const pending = new Map();
  let sequence = 0;
  let buffer = '';
  let approve = true;
  let error;
  let stderr = '';
  function rejectAll(reason) {
    error = reason;
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(reason); }
    pending.clear();
  }
  child.on('error', rejectAll);
  child.on('close', () => rejectAll(new Error(`Pi process closed: ${stderr}`)));
  child.stdin.on('error', rejectAll);
  child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-2000); });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0,newline).replace(/\r$/, '');
      buffer = buffer.slice(newline+1);
      if (!line) continue;
      let event;
      try { event = JSON.parse(line); } catch { rejectAll(new Error('Invalid RPC output')); return; }
      events.push(event);
      if (event.type === 'response' && pending.has(event.id)) {
        const waiter = pending.get(event.id);
        clearTimeout(waiter.timer);
        pending.delete(event.id);
        event.success ? waiter.resolve(event) : waiter.reject(new Error('RPC command failed'));
      }
      if (event.type === 'extension_ui_request') {
        const reply = { type: 'extension_ui_response', id: event.id };
        if (event.method === 'confirm') child.stdin.write(JSON.stringify({ ...reply, confirmed: approve })+'\n');
        if (event.method === 'editor') child.stdin.write(JSON.stringify({ ...reply, value: event.prefill })+'\n');
        if (event.method === 'input') child.stdin.write(JSON.stringify({ ...reply, value: 'bob' })+'\n');
      }
    }
  });
  return {
    events,
    approve(value) { approve = value; },
    send(type, parameters = {}) {
      if (error) return Promise.reject(error);
      const id = `request-${++sequence}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('Pi RPC timeout')); }, 120000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(JSON.stringify({ id, type, ...parameters })+'\n');
      });
    },
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise(resolve => { child.once('close', resolve); child.kill(); });
    },
  };
}

test('real pi worker persists Copilot context without a model or fabricated assistant turn', options, async t => {
  const root = await temp(t);
  const record = createSnapshotRecord((await captureFile(path.resolve(__dirname,'..','fixtures','coding-session.jsonl'))).snapshot);
  const result = await importPiSession(record, { workspace: root, sessionDir: path.join(root,'sessions'), approval: true });
  assert.equal(result.status, 'native_session_created');
  assert.equal(result.safety.modelInvoked, false);
  assert.equal(result.safety.toolsReplayed, false);
  const entries = (await fs.readFile(result.sessionFile,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(entries.some(entry=>entry.type==='message' && entry.message.role==='assistant'), false);
  assert.equal(entries.filter(entry=>entry.type==='custom_message').length, 1);
  assert.equal(entries[0].cwd, await fs.realpath(root));
});

test('real pi extension cancels safely, shares active context, and switches to an imported session', options, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-extension-test-'));
  const source = path.join(root,'source.jsonl');
  const sourceEntries = (await fs.readFile(path.resolve(__dirname,'..','fixtures','pi-coding-session.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  sourceEntries[0].cwd = root;
  await fs.writeFile(source, sourceEntries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
  const service = await startServer({ port:0, dataDir:path.join(root,'store') });
  const stateDir = path.join(root, 'private-client');
  const client = rpc(root,source,{SESSION_SERVICE_URL:service.url,AGENT_CONTEXT_HOME:stateDir});
  t.after(async()=>{
    await client.close();
    service.server.closeAllConnections();
    await new Promise(resolve=>service.server.close(resolve));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  const commands = await client.send('get_commands');
  assert.ok(commands.data.commands.some(command=>command.name==='ac-share'));
  assert.ok(commands.data.commands.some(command=>command.name==='ac-resume'));
  client.approve(false);
  await client.send('prompt',{message:'/ac-share --local'});
  assert.deepEqual(await fs.readdir(service.store.snapshotsDir),[]);
  client.approve(true);
  await client.send('prompt',{message:'/ac-share --local'});
  const shared = client.events.find(event=>event.type==='extension_ui_request' && event.method==='notify' && event.message.startsWith('Shared: '));
  assert.ok(shared, JSON.stringify(client.events.filter(event=>event.method==='notify')));
  const link=shared.message.slice('Shared: '.length);
  const response=await fetch(link);
  assert.equal(response.status,200);
  const record=await response.json();
  assert.equal(record.snapshot.source.host,'pi');
  assert.equal(record.snapshot.source.capture.leafSelection,'explicit');
  assert.equal(JSON.stringify(record).includes('SYNTHETIC_ABANDONED'),false);
  assert.equal(JSON.stringify(record).includes('SYNTHETIC_PRIVATE'),false);

  const before=await client.send('get_state');
  client.approve(false);
  await client.send('prompt',{message:`/ac-resume ${link}`});
  assert.equal((await client.send('get_state')).data.sessionId,before.data.sessionId);
  client.approve(true);
  await client.send('prompt',{message:`/ac-resume ${link}`});
  const after=await client.send('get_state');
  assert.notEqual(after.data.sessionId,before.data.sessionId);
  assert.equal(after.data.isStreaming,false);
  assert.equal(after.data.pendingMessageCount,0);
  assert.ok((await fs.stat(after.data.sessionFile)).isFile());
  const messages=await client.send('get_messages');
  assert.equal(messages.data.messages.length,1);
  assert.equal(messages.data.messages[0].role,'custom');
  assert.equal(messages.data.messages[0].customType,'agent-context-import');
  assert.equal(client.events.some(event=>['agent_start','tool_execution_start','extension_error'].includes(event.type)),false);
  await client.send('prompt',{message:'/ac-share --local'});
  assert.equal((await fs.readdir(service.store.snapshotsDir)).length,2,'extension remains usable after runtime replacement');
  const reviews = await fs.readdir(path.join(stateDir, 'reviews'));
  assert.ok(reviews.some(name => name.endsWith('.result')), 'live commands use the same reviewed workflow and receipts');
});
