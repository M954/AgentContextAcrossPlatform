'use strict';

const { prepareSnapshot, contentHash, validateSessionSnapshot } = require('./snapshot');
const { timestampFields, definedFields } = require('./capture-common');
const MAX_PI_ENTRIES = 10000;

function normalizePiSession(records, options = {}) {
  const header = records[0];
  if (header?.type !== 'session' || ![2, 3].includes(header.version) || typeof header.id !== 'string' || !header.id) {
    throw new Error('Supported pi input requires a v2/v3 session header; export legacy sessions with a current pi version');
  }
  if (records.length > MAX_PI_ENTRIES + 1) throw new Error('Pi capture exceeds 10000 entries');
  const entries = new Map();
  for (const entry of records.slice(1)) {
    if (!entry || typeof entry.id !== 'string' || !entry.id || entries.has(entry.id) ||
        (entry.parentId !== null && typeof entry.parentId !== 'string')) {
      throw new Error('Invalid pi session tree: missing/duplicate ID or invalid parent');
    }
    // Pi is append-only: parents must precede their children. Fail on orphan/cycle.
    if (entry.parentId !== null && !entries.has(entry.parentId)) throw new Error('Invalid pi session tree: parent missing or out of order');
    entries.set(entry.id, entry);
  }
  const leafId = options.leafId !== undefined ? options.leafId : records.at(-1)?.id;
  if (leafId !== null && !entries.has(leafId)) throw new Error('Selected pi leaf does not exist');
  const branch = [];
  for (let entry = entries.get(leafId); entry; entry = entries.get(entry.parentId)) branch.push(entry);
  branch.reverse();

  const events = [];
  const omissions = [];
  const omit = (id, reason) => omissions.push({ record: id, reason });
  const add = (entry, type, data, suffix = '') => events.push({
    eventId: `${entry.id}${suffix}`,
    type,
    ...timestampFields(entry.timestamp),
    ...definedFields(data),
  });
  function message(entry, value, suffix = '') {
    if (!value || typeof value.role !== 'string') throw new Error('Invalid pi message entry');
    if (value.role === 'bashExecution' && value.excludeFromContext === true) {
      omit(entry.id, 'Private !! execution excluded');
      return;
    }
    if (['user', 'assistant', 'toolResult', 'custom', 'hookMessage'].includes(value.role)) {
      if (['custom', 'hookMessage'].includes(value.role) && value.display !== true) {
        omit(entry.id, 'Hidden extension message excluded');
        return;
      }
      const blocks = typeof value.content === 'string' ? [{ type: 'text', text: value.content }] : value.content;
      if (!Array.isArray(blocks)) throw new Error('Invalid pi content blocks');
      const text = blocks.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n');
      if (value.role === 'toolResult') {
        add(entry, 'tool_result', { toolCallId: value.toolCallId, toolName: value.toolName, isError: value.isError, content: text }, suffix);
      } else if (text) add(entry, 'historical_message', { role: value.role, content: text }, suffix);
      for (const [index, block] of blocks.entries()) {
        if (block?.type === 'toolCall' && value.role === 'assistant' && typeof block.id === 'string' && typeof block.name === 'string') {
          add(entry, 'tool_request', { toolCallId: block.id, toolName: block.name, arguments: block.arguments }, `${suffix}-tool-${index}`);
        } else if (block?.type !== 'text') {
          omit(entry.id, 'Thinking, image, or unsupported content block excluded');
        }
      }
    } else if (value.role === 'bashExecution') {
      add(entry, 'historical_shell_execution', { command: value.command, output: value.output, exitCode: value.exitCode,
        cancelled: value.cancelled, truncated: value.truncated }, suffix);
      if (value.fullOutputPath) omit(entry.id, 'External shell-output file not followed');
    } else {
      omit(entry.id, 'Unsupported message role excluded');
    }
  }

  for (const entry of branch) {
    switch (entry.type) {
      case 'message': message(entry, entry.message); break;
      case 'custom_message':
        message(entry, { role: 'custom', content: entry.content, display: entry.display });
        break;
      case 'compaction':
      case 'branch_summary':
        if (typeof entry.summary !== 'string') throw new Error('Invalid pi summary');
        add(entry, 'historical_summary', { summaryType: entry.type, content: entry.summary });
        // Materialized tails may contain context absent from earlier entries. Keep
        // them explicitly labeled as historical retained context, not new actions.
        if (entry.retainedTail !== undefined) {
          if (!Array.isArray(entry.retainedTail)) throw new Error('Invalid pi retained tail');
          entry.retainedTail.forEach((value, index) => message(entry, value, `-retained-${index}`));
        }
        break;
      default:
        omit(entry.id, 'Non-conversation metadata or extension state excluded');
    }
  }
  if (!events.length) throw new Error('No supported conversation content on the selected pi branch');
  const capture = {
    format: 'pi-jsonl', leafId, leafSelection: options.leafId !== undefined ? 'explicit' : 'last-appended-entry',
    excludedBranchEntries: entries.size - branch.length, omissions,
    excluded: ['thinking blocks', 'private shell executions', 'hidden extension messages', 'extension state', 'workspace files', 'source model configuration'],
  };
  const prepared = prepareSnapshot({
    schemaVersion: '1.0',
    source: { host: 'pi', sessionId: header.id, capture },
    task: { title: options.title || 'Shared pi session', summary: 'Selected pi branch; historical summaries may overlap retained history.' },
    events,
    workspace: {},
    resume: { nextAction: options.nextAction || 'Review the shared context and confirm the next action in the recipient workspace.' },
    omitted: [
      `${capture.excludedBranchEntries} entries outside the selected branch excluded`,
      ...omissions.map(item => `${item.record}: ${item.reason}`),
    ],
  });
  prepared.snapshot.source.capture.sourceDigest = `sha256:${contentHash(prepared.snapshot.events)}`;
  validateSessionSnapshot(prepared.snapshot);
  return { ...prepared, format: 'pi-jsonl' };
}

module.exports = { normalizePiSession };
