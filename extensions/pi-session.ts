import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { normalizePiSession } from '../src/pi-capture.js';
import { contentHash, prepareSnapshot } from '../src/snapshot.js';
import { loadConfig, getStateDir } from '../src/config.js';
import { createGraphAuth } from '../src/graph-auth.js';
import { HandoffWorkflow } from '../src/workflow.js';

async function workflow() {
  const stateDir = getStateDir();
  const config = await loadConfig(stateDir);
  return new HandoffWorkflow({ config, stateDir, auth: createGraphAuth(config, stateDir),
    localUrl: process.env.SESSION_SERVICE_URL });
}

async function approveReview(ctx: ExtensionCommandContext, review: any) {
  const preview = JSON.stringify(review, null, 2);
  const viewed = await ctx.ui.editor('Review exact sanitized draft (read-only; Escape cancels)', preview);
  if (viewed === undefined) return false;
  if (viewed !== preview) throw new Error('The review is read-only. Prepare a new draft to change its contents or target.');
  return ctx.ui.confirm(`Approve ${review.plan.action}?`, JSON.stringify({
    reviewId: review.reviewId, digest: review.digest, account: review.plan.identity,
    provider: review.plan.provider, destination: review.plan.destination,
    recipients: review.plan.recipients, importTarget: review.plan.importTarget,
    warning: 'Imported content is untrusted. Native import is reference context, not an environment clone. No model turn or historical tool replay. Downloaded copies cannot be recalled.',
  }, null, 2));
}

export default function (pi: ExtensionAPI) {
  let busy = false;
  const guarded = (handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>) => async (args: string, ctx: ExtensionCommandContext) => {
    if (!ctx.hasUI) throw new Error('A trusted interactive or RPC UI is required; approval flags are not supported');
    if (busy || !ctx.isIdle() || ctx.hasPendingMessages()) {
      ctx.ui.notify('Wait for an idle session and clear queued messages first.', 'warning');
      return;
    }
    busy = true;
    try { await handler(args, ctx); }
    catch (error) { ctx.ui.notify(error instanceof Error ? error.message : 'Session handoff failed', 'error'); }
    finally { busy = false; }
  };

  pi.registerCommand('ac-share', {
    description: 'Review/share the current pi branch through OneDrive (recipient emails), or --local for synthetic testing',
    handler: guarded(async (args, ctx) => {
      const local = args.trim() === '--local';
      if (args.trim().startsWith('--') && !local) throw new Error('Usage: /ac-share <recipient emails> or /ac-share --local');
      if (!await ctx.ui.confirm('Capture current branch?', 'Capture the active branch only. Thinking, private !! output, hidden state, attachments, and source configuration are excluded. Nothing is uploaded before final review.')) return;
      const sessionId = ctx.sessionManager.getSessionId();
      const leafId = ctx.sessionManager.getLeafId();
      let prepared = normalizePiSession([ctx.sessionManager.getHeader(), ...ctx.sessionManager.getBranch()], { leafId });
      for (let attempt = 0; attempt < 5; attempt++) {
        const edited = await ctx.ui.editor('Select/redact context before preparing a draft (Escape cancels)', JSON.stringify(prepared.snapshot, null, 2));
        if (edited === undefined) return;
        if (Buffer.byteLength(edited) > 2 * 1024 * 1024) throw new Error('Capture exceeds the snapshot size limit');
        const value = JSON.parse(edited);
        const next = prepareSnapshot(value);
        prepared = { ...next, redactions: [...new Set([...prepared.redactions, ...next.redactions])], format: 'pi-jsonl' };
        if (contentHash(value) === contentHash(next.snapshot)) break;
        if (attempt === 4) throw new Error('Redaction did not stabilize; nothing was published');
        ctx.ui.notify('Additional redactions were applied. Review again.', 'warning');
      }
      const selected = local ? '' : args.trim() || await ctx.ui.input('Specific recipient email addresses', 'teammate@contoso.com');
      if (selected === undefined) return;
      const recipients = selected.split(/[,\s]+/).filter(Boolean);
      const flow = await workflow();
      const draft = await flow.preparePublish({ snapshot: prepared.snapshot, priorRedactions: prepared.redactions,
        provider: local ? 'local' : 'onedrive', format: local ? 'json' : 'markdown', recipients });
      ctx.ui.notify(`Prepared review ${draft.reviewId}. Preview: ${draft.previewPath}`, 'info');
      const result = await flow.complete(draft.reviewId, 'publish', async (review: any) => {
        const approved = await approveReview(ctx, review);
        if (ctx.sessionManager.getSessionId() !== sessionId || ctx.sessionManager.getLeafId() !== leafId || !ctx.isIdle()) {
          throw new Error('The active session changed during review. Prepare a new share.');
        }
        return approved;
      });
      if (result.status === 'cancelled') { ctx.ui.notify('Publication cancelled; nothing uploaded.', 'info'); return; }
      ctx.ui.notify(`Shared: ${result.link}`, 'info');
      if (result.recipientPrompt) ctx.ui.notify(`Recipient can paste into an existing authorized agent:\n${result.recipientPrompt}`, 'info');
      pi.appendEntry('agent-context-share', { snapshotId: result.snapshotId, link: result.link, reviewId: draft.reviewId });
    }),
  });

  pi.registerCommand('ac-resume', {
    description: 'Inspect and approve a shared bundle for native pi import into the current workspace',
    handler: guarded(async (args, ctx) => {
      const link = args.trim();
      if (!link) throw new Error('Usage: /ac-resume <sharing-link>');
      const flow = await workflow();
      const draft = await flow.inspect({ link, target: 'pi', workspaceRoot: ctx.cwd });
      ctx.ui.notify(`Prepared import review ${draft.reviewId}. Preview: ${draft.previewPath}`, 'info');
      const result = await flow.complete(draft.reviewId, 'import', async (review: any) => {
        const approved = await approveReview(ctx, review);
        if (!ctx.isIdle() || ctx.hasPendingMessages()) throw new Error('Session is no longer idle');
        return approved;
      });
      if (result.status === 'cancelled') { ctx.ui.notify('Import cancelled; no new session was created.', 'info'); return; }
      if (result.status !== 'native_session_created' || !result.sessionFile) throw new Error('Pi did not confirm native session creation');
      const switched = await ctx.switchSession(result.sessionFile, {
        withSession: async replacement => {
          replacement.ui.setEditorText('');
          replacement.ui.notify(`Imported ${result.localSessionId}. No model or tools ran. Choose your next instruction when ready.`, 'info');
        },
      });
      // Old ctx is stale after a successful replacement; use it only if cancelled.
      if (switched.cancelled) ctx.ui.notify(`Session created, switch cancelled. Open pi --session ${result.sessionFile}`, 'warning');
    }),
  });
}
