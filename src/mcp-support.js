'use strict';

const { snapshotScopes } = require('./snapshot');

function summarizeSnapshot(snapshot, redactions = []) {
  return {
    sourceHost: snapshot.source.host,
    sourceSessionId: snapshot.source.sessionId,
    title: snapshot.task && snapshot.task.title ? snapshot.task.title : null,
    eventCount: snapshot.events.length,
    repository: snapshot.workspace.repository || null,
    branch: snapshot.workspace.branch || null,
    includedScopes: snapshotScopes(snapshot),
    redactionCount: redactions.length,
    files: (snapshot.files || []).map((file) => file.path),
    textAttachmentCount: snapshot.attachments?.length || 0,
    omissions: snapshot.omitted || [],
    restoreMode: 'context_document',
    readiness: 'needs_adaptation',
    executionReadiness: 'not_assessed',
  };
}

module.exports = {
  summarizeSnapshot,
};
