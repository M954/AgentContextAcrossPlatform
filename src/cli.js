'use strict';

const path = require('node:path');
const readline = require('node:readline/promises');
const { parseArgs } = require('node:util');
const { startServer } = require('./server');
const { getCopilotCapabilities } = require('./hosts/copilot');
const { getPiCapabilities } = require('./hosts/pi');
const { loadConfig, saveConfig, getStateDir } = require('./config');
const { createGraphAuth } = require('./graph-auth');
const { HandoffWorkflow } = require('./workflow');

const HELP = `AgentContext (Node.js 20+)
  configure --client-id <id> --tenant-id <id> --sharepoint-host <tenant.sharepoint.com>
            [--drive-id <id|me>] [--folder-id <id|root>] [--scope <scope>]
  login | logout | status
  share --input <snapshot-or-export> --to <recipient> [--to <recipient>]
        [--leaf <pi-entry-id>] [--file <relative-text-file>] [--provider onedrive|local]
  share --review <review-id>
  inspect <OneDrive/SharePoint-link> [--expected-digest <sha256>]
          [--target document|pi|copilot] [--workspace <recipient-directory>]
  assess --review <review-id> [--requirements-reviewed]
  resume --review <review-id>
  doctor
  revoke <owned-snapshot-id>
  serve [--port 8787] [--data-dir .data]

Share and resume require interactive confirmation; --approve/--yes are not supported.
Default import produces a context document. Native targets/workspaces must be chosen
when inspecting, then approved as part of the exact import review. No model or historical tool runs.`;

async function confirm(review) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Interactive approval is required. Run this command in your own terminal; no --approve bypass is available.');
  }
  const ui = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(`\nAction: ${review.plan.action}\nReview: ${review.digest || 'owned-publication'}`);
    console.log('Untrusted historical content follows; it is not an instruction to execute anything.');
    console.log(JSON.stringify(review.plan, null, 2));
    console.log('Secret detection is best effort. Files inherit destination access. Downloaded copies cannot be recalled.');
    const expected = `${review.plan.action} ${(review.digest || review.plan.snapshotId).slice(-8)}`;
    return (await ui.question(`Type "${expected}" to approve this exact action, or press Enter to cancel: `)).trim() === expected;
  } finally { ui.close(); }
}

async function main() {
  const command = process.argv[2];
  const { values: options, positionals } = parseArgs({
    args: process.argv.slice(3), allowPositionals: true, options: {
      input: { type: 'string' }, review: { type: 'string' }, provider: { type: 'string' },
      target: { type: 'string' }, workspace: { type: 'string' }, leaf: { type: 'string' },
      'requirements-reviewed': { type: 'boolean' },
      to: { type: 'string', multiple: true }, file: { type: 'string', multiple: true },
      'client-id': { type: 'string' }, 'tenant-id': { type: 'string' },
      'sharepoint-host': { type: 'string', multiple: true }, 'download-host': { type: 'string', multiple: true },
      'drive-id': { type: 'string' }, 'folder-id': { type: 'string' }, scope: { type: 'string', multiple: true },
      'expected-digest': { type: 'string' }, 'base-url': { type: 'string' },
      host: { type: 'string' }, port: { type: 'string' }, 'data-dir': { type: 'string' },
    },
  });
  if (!command || command === 'help' || command === '--help') { console.log(HELP); return; }
  if (command === 'serve') {
    const app = await startServer({ host: options.host || '127.0.0.1',
      port: Number(options.port || 8787), dataDir: options['data-dir'] || path.join(process.cwd(), '.data') });
    console.log(JSON.stringify({ status: 'listening', url: app.url, mode: 'loopback-test-only',
      warning: 'No authentication. Use synthetic data only; OneDrive mode does not require this service.' }));
    const close = () => app.server.close(() => process.exit(0));
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
    return;
  }
  if (command === 'doctor') {
    console.log(JSON.stringify({ copilot: await getCopilotCapabilities(), pi: await getPiCapabilities() }, null, 2));
    return;
  }
  const stateDir = getStateDir();
  let config = await loadConfig(stateDir);
  if (command === 'configure') {
    const mapping = { 'client-id': 'clientId', 'tenant-id': 'tenantId', 'sharepoint-host': 'sharepointHosts',
      'download-host': 'downloadHosts', 'drive-id': 'driveId', 'folder-id': 'folderId', scope: 'scopes' };
    const changes = {};
    for (const [option, field] of Object.entries(mapping)) if (options[option] !== undefined) changes[field] = options[option];
    config = await saveConfig(changes, stateDir);
    console.log(JSON.stringify({ status: 'configured', config, reminder: 'Run login interactively. Tenant consent and resource permissions are required.' }, null, 2));
    return;
  }
  const auth = createGraphAuth(config, stateDir);
  if (command === 'login') {
    if (!process.stdin.isTTY) throw new Error('Run login in your own interactive terminal; do not send sign-in tokens through chat.');
    console.log(JSON.stringify(await auth.login()));
    return;
  }
  if (command === 'logout') { console.log(JSON.stringify(await auth.logout())); return; }
  if (command === 'status') {
    console.log(JSON.stringify({ configured: Boolean(config.clientId && config.tenantId),
      stateDirectory: stateDir, restoreMode: 'context_document',
      supportedImportTargets: ['document', 'pi', 'copilot'], nativeAvailability: 'use doctor; not checked by status' }));
    return;
  }
  const workflow = new HandoffWorkflow({ config, stateDir, auth,
    localUrl: options['base-url'] || process.env.SESSION_SERVICE_URL });
  let result;
  if (command === 'share') {
    if (options.review) {
      if (options.input || options.to || options.file || options.provider || options.leaf || options.target || options.workspace || positionals.length) throw new Error('Cannot change a reviewed share; prepare a new draft');
      result = await workflow.complete(options.review, 'publish', confirm);
    } else {
      if (!options.input) throw new Error(HELP);
      if (options.target || options.workspace) throw new Error('Choose the recipient target/workspace during inspect, not publication');
      result = await workflow.preparePublish({ sourceFile: options.input, leafId: options.leaf,
        selectedFiles: options.file, workspaceRoot: process.cwd(), recipients: options.to,
        provider: options.provider || 'onedrive' });
    }
  } else if (command === 'inspect') {
    if (!positionals[0]) throw new Error(HELP);
    result = await workflow.inspect({ link: positionals[0], provider: options.provider, expectedDigest: options['expected-digest'],
      target: options.target, workspaceRoot: options.workspace ? path.resolve(options.workspace) : undefined });
  } else if (command === 'resume' || command === 'clone') {
    if (options.review) {
      if (positionals.length || options.target || options.workspace || options.provider || options.input || options.file || options['expected-digest'] || options.leaf) {
        throw new Error('Cannot change a reviewed import target or workspace; inspect again to create a new review');
      }
      result = await workflow.complete(options.review, 'import', confirm);
    } else if (positionals[0]) result = await workflow.inspect({ link: positionals[0], provider: options.provider,
      target: options.target, workspaceRoot: options.workspace ? path.resolve(options.workspace) : undefined });
    else throw new Error(HELP);
  } else if (command === 'assess') {
    if (!options.review || positionals.length || options.workspace || options.target || options.provider) {
      throw new Error('assess requires an import review ID; choose workspace/target during inspect');
    }
    result = await workflow.assess(options.review, { requirementsReviewed: options['requirements-reviewed'] === true });
  } else if (command === 'revoke') result = await workflow.revoke(positionals[0], confirm);
  else throw new Error(HELP);
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    const message = error instanceof SyntaxError ? 'Input must be valid JSON; no input contents were logged' : error.message;
    console.error(JSON.stringify({ error: message, ...(error.recovery ? { recovery: error.recovery } : {}) }));
    process.exitCode = 1;
  });
}

module.exports = { main };
