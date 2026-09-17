'use strict';

function summarizeSnapshot(snapshot, redactions = []) {
  return {
    sourceHost: snapshot.source.host,
    sourceSessionId: snapshot.source.sessionId,
    title: snapshot.task && snapshot.task.title ? snapshot.task.title : null,
    eventCount: snapshot.events.length,
    repository: snapshot.workspace.repository || null,
    branch: snapshot.workspace.branch || null,
    includedScopes: ['conversation', 'tool-history', 'task-summary', 'workspace-metadata'],
    redactionCount: redactions.length,
  };
}

module.exports = {
  summarizeSnapshot,
};
