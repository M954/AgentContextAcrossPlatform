'use strict';

// Synthetic Graph transport + explicit test approval callbacks. This script never
// signs in, uses a live tenant, or automates the production CLI approval phrase.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { HandoffWorkflow } = require('../src/workflow');
const { graphFixture } = require('../fixtures/graph-service');

async function main() {
  const { values } = parseArgs({ options: { source: { type: 'string', default: 'pi' }, target: { type: 'string', default: 'document' } } });
  if (!['pi', 'copilot'].includes(values.source) || !['document', 'pi', 'copilot'].includes(values.target)) {
    throw new Error('Use --source pi|copilot --target document|pi|copilot');
  }
  await fs.mkdir(path.resolve('.data'), { recursive: true });
  const root = await fs.mkdtemp(path.resolve('.data/reviewed-demo-'));
  const workspace = path.join(root, 'recipient-project');
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, 'average.js'), 'module.exports = values => values.reduce((sum, value) => sum + value, 0) / values.length;\n');
  await fs.writeFile(path.join(workspace, 'average.test.js'), "const test = require('node:test');\nconst assert = require('node:assert/strict');\nconst average = require('./average');\ntest('empty input', () => assert.equal(average([]), 0));\n");
  await fs.writeFile(path.join(workspace, 'package.json'), JSON.stringify({ private: true, scripts: { test: 'node --test' } }));
  const fake = graphFixture();
  const flow = user => new HandoffWorkflow({ config: fake.config, stateDir: path.join(root, user),
    auth: fake.auth(user), graphOptions: fake });
  const sender = flow('a');
  const receiver = flow('b');
  const publishReview = await sender.preparePublish({
    sourceFile: path.resolve('fixtures', values.source === 'pi' ? 'pi-coding-session.jsonl' : 'coding-session.jsonl'),
    recipients: ['b@example.test'],
  });
  const publication = await sender.complete(publishReview.reviewId, 'publish', async review => {
    assert.equal(review.plan.action, 'publish');
    assert.equal(JSON.stringify(review).includes('SYNTHETIC_PRIVATE_THINKING'), false);
    assert.equal(JSON.stringify(review).includes('SYNTHETIC_ABANDONED_BRANCH'), false);
    return true; // Synthetic fixture only, not a production approval path.
  });
  await assert.rejects(flow('c').inspect({ link: publication.link }), /403/);
  const importReview = await receiver.inspect({ link: publication.link, target: values.target, workspaceRoot: workspace });
  const imported = await receiver.complete(importReview.reviewId, 'import', async review => {
    assert.equal(review.plan.importTarget.target, values.target);
    assert.equal(review.plan.importTarget.workspace.path, await fs.realpath(workspace));
    return true; // Explicitly simulated human confirmation in this demo harness.
  });
  const nextReview = await receiver.inspect({ link: publication.link, target: values.target, workspaceRoot: workspace });
  await sender.revoke(publication.snapshotId, async () => true);
  await assert.rejects(receiver.complete(nextReview.reviewId, 'import', async () => true), /403/);
  const report = {
    result: 'passed', transport: 'synthetic Microsoft Graph contract fixture',
    liveTenantValidated: false, approvalUI: 'explicit synthetic test callbacks',
    source: values.source, target: values.target, root, workspace,
    publishReviewId: publishReview.reviewId, importReviewId: importReview.reviewId,
    unauthorizedRecipientDenied: true, revokedAccessBlockedBeforeImport: true,
    status: imported.status, restoreMode: imported.restoreMode,
    localSessionId: imported.localSessionId || null, sessionFile: imported.sessionFile || null,
    resumeCommand: imported.resumeCommand || null, contextPath: imported.contextPath,
    modelInvoked: false, importedToolsExecuted: false,
    note: 'Native targets use the real installed host. Fixture history and Graph transport are synthetic. No agent fixed the sample bug; continuation is a separate user action.',
  };
  await fs.writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
