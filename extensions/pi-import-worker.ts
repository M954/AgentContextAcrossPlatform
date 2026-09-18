// Internal offline RPC worker. Deliberately excluded from the pi package manifest.
import { SessionManager, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { readFile, stat } from 'node:fs/promises';
import { createPiSession } from '../src/hosts/pi-native.js';

export default function (pi: ExtensionAPI) {
  // A missing command must never fall through to a model request.
  pi.on('input', () => ({ action: 'handled' }));
  pi.on('tool_call', () => ({ block: true, reason: 'Offline import worker does not execute tools', terminate: true }));
  pi.on('before_provider_request', () => { throw new Error('Model requests are disabled in the import worker'); });
  pi.registerCommand('ac-internal-import', {
    description: 'Internal offline session import worker',
    handler: async (_args, ctx) => {
      const input = process.env.AGENT_CONTEXT_PI_IMPORT_FILE;
      if (ctx.mode !== 'rpc' || !input || process.env.PI_OFFLINE !== '1') throw new Error('Internal worker requires its offline adapter');
      if ((await stat(input)).size > 4 * 1024 * 1024) throw new Error('Import record exceeds 4 MiB');
      const record = JSON.parse(await readFile(input, 'utf8'));
      const result = await createPiSession(record, ctx.cwd, process.env.AGENT_CONTEXT_PI_SESSION_DIR, SessionManager, process.env.AGENT_CONTEXT_PI_TEMP_ROOT);
      ctx.ui.notify(JSON.stringify({ marker: 'agent-context-pi-import-result', result }), 'info');
    },
  });
}
