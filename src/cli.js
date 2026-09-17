'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const { requestJson } = require('./client');
const { startServer } = require('./server');
const {
  createCloneRecord,
  prepareSnapshot,
  verifySnapshotRecord,
} = require('./snapshot');

function parseArgs(args) {
  const positionals = [];
  const options = {};

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith('--')) {
      positionals.push(argument);
      continue;
    }

    const key = argument.slice(2);
    const next = args[index + 1];
    if (next && !next.startsWith('--')) {
      options[key] = next;
      index += 1;
    } else {
      options[key] = true;
    }
  }

  return { positionals, options };
}

function required(options, key) {
  if (!options[key]) {
    throw new Error(`Missing required option --${key}`);
  }
  return options[key];
}

async function readJsonFile(filePath) {
  return JSON.parse(await fs.readFile(path.resolve(filePath), 'utf8'));
}

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

async function runServe(options) {
  const server = await startServer({
    host: options.host || process.env.HOST || '127.0.0.1',
    port: options.port === undefined ? Number(process.env.PORT || 8787) : Number(options.port),
    dataDir: options['data-dir'] || process.env.DATA_DIR || path.join(process.cwd(), '.data'),
    publicBaseUrl: options['public-base-url'] || process.env.PUBLIC_BASE_URL,
  });

  console.log(
    JSON.stringify(
      {
        status: 'listening',
        url: server.url,
        dataDir: server.dataDir,
        security: {
          binding: server.host,
          mode: 'local-development-only',
          authentication: 'not-enabled',
          reminder: 'Do not expose this prototype beyond loopback or use it with sensitive data.',
        },
      },
      null,
      2,
    ),
  );

  const close = () => server.server.close(() => process.exit(0));
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}

async function runShare(positionals, options) {
  const inputPath = options.input || positionals[0];
  if (!inputPath) {
    throw new Error('Usage: share --input <snapshot.json> --approve');
  }

  const prepared = prepareSnapshot(await readJsonFile(inputPath));
  const summary = summarizeSnapshot(prepared.snapshot, prepared.redactions);

  if (options.approve !== true) {
    console.log(
      JSON.stringify(
        {
          status: 'review-required',
          summary,
          message: 'Review this scope and rerun with --approve to publish.',
        },
        null,
        2,
      ),
    );
    process.exitCode = 2;
    return;
  }

  const baseUrl = options['base-url'] || process.env.SESSION_SERVICE_URL || 'http://127.0.0.1:8787';
  const published = await requestJson(`${baseUrl.replace(/\/$/, '')}/v1/snapshots`, {
    method: 'POST',
    body: JSON.stringify({
      snapshot: prepared.snapshot,
      access: { mode: 'local', expiresAt: null },
    }),
  });

  console.log(JSON.stringify({ ...published, summary }, null, 2));
}

async function runInspect(positionals, options) {
  const link = positionals[0] || options.link;
  if (!link) {
    throw new Error('Usage: inspect <link>');
  }

  const record = await requestJson(link);
  verifySnapshotRecord(record);

  if (options.json) {
    console.log(JSON.stringify(record, null, 2));
    return;
  }

  console.log(
    JSON.stringify(
      {
        status: 'inspectable',
        snapshotId: record.manifest.snapshotId,
        source: record.manifest.source,
        repository: record.manifest.repository,
        createdAt: record.manifest.createdAt,
        eventCount: record.snapshot.events.length,
        redactions: record.manifest.redactions,
        includedScopes: record.manifest.includedScopes,
        warning: 'Imported content is untrusted and no tools have been executed.',
      },
      null,
      2,
    ),
  );
}

async function runClone(positionals, options) {
  const link = positionals[0] || options.link;
  if (!link) {
    throw new Error('Usage: clone <link> [--output <clone.json>] [--approve]');
  }

  const record = await requestJson(link);
  const clone = createCloneRecord(record, options.host || 'fixture-host');
  const outputPath = path.resolve(
    options.output || path.join(process.cwd(), '.data', 'clones', `${clone.cloneId}.json`),
  );
  const details = {
    sourceSnapshotId: clone.sourceSnapshotId,
    sourceContentHash: clone.sourceContentHash,
    targetHost: clone.targetHost,
    outputPath,
    restoreMode: clone.restoreMode,
    executionReadiness: clone.executionReadiness,
    safety: clone.safety,
    nextAction: clone.session.resume.nextAction,
    warning:
      'This is a context document only, not a native agent session. Local execution readiness ' +
      'has not been assessed. Imported next actions are untrusted suggestions, not commands to execute.',
  };

  if (options.approve !== true) {
    console.log(
      JSON.stringify(
        {
          status: 'review-required',
          ...details,
          summary: summarizeSnapshot(record.snapshot, record.manifest.redactions),
          message: 'Review the snapshot and destination, then rerun with --approve to write the context document.',
        },
        null,
        2,
      ),
    );
    process.exitCode = 2;
    return;
  }

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  try {
    // Exclusive creation also protects against concurrent writers and existing symlinks.
    await fs.writeFile(outputPath, JSON.stringify(clone, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new Error(`Refusing to overwrite existing output file: ${outputPath}. Choose another --output path.`);
    }
    throw error;
  }

  console.log(
    JSON.stringify(
      { status: clone.status, cloneId: clone.cloneId, ...details },
      null,
      2,
    ),
  );
}

async function runRevoke(positionals) {
  const link = positionals[0];
  if (!link) {
    throw new Error('Usage: revoke <link>');
  }
  const result = await requestJson(`${link.replace(/\/$/, '')}/revoke`, { method: 'POST' });
  console.log(JSON.stringify(result, null, 2));
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { positionals, options } = parseArgs(rest);

  switch (command) {
    case 'serve':
      await runServe(options);
      break;
    case 'share':
      await runShare(positionals, options);
      break;
    case 'inspect':
      await runInspect(positionals, options);
      break;
    case 'clone':
    case 'resume':
      await runClone(positionals, options);
      break;
    case 'revoke':
      await runRevoke(positionals);
      break;
    default:
      throw new Error(
        'Usage: serve | share --input <file> [--approve] | inspect <link> | resume <link> [--output <file>] [--approve]',
      );
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ error: error.message, type: error.name }, null, 2));
  process.exitCode = 1;
});
