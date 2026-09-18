'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const { contentHash, verifySnapshotRecord } = require('./snapshot');

function finding(requirement, status, reasonCode, explanation, observed = {}) {
  return {
    requirementId: requirement.id,
    required: requirement.required,
    contractKey: requirement.contractKey,
    status,
    reasonCode,
    explanation,
    observed,
    checkMode: 'passive',
  };
}

function safeParts(relativePath) {
  if (path.posix.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath) ||
      /[\x00-\x1f\x7f:<>"|?*]/.test(relativePath)) return null;
  const parts = relativePath.split(/[\\/]/);
  if (parts.length > 32 || parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part))) {
    return null;
  }
  const blocked = /^(?:\.env.*|\.git|\.ssh|\.aws|\.azure|\.config|\.kube|\.gnupg|\.npmrc|\.netrc|credentials(?:\..*)?|secrets?(?:\..*)?|auth\.json|id_rsa|id_ed25519|con|nul|prn|aux|com[1-9]|lpt[1-9])$/i;
  if (parts.some(part => blocked.test(part) || /\.(?:pem|key|pfx|p12)$/i.test(part))) return null;
  return parts;
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
}

async function resolveWorkspace(workspaceRoot) {
  if (workspaceRoot === undefined) return { status: 'unknown', reason: 'WORKSPACE_NOT_SELECTED' };
  try {
    const root = await fs.realpath(path.resolve(workspaceRoot));
    if (!(await fs.stat(root)).isDirectory()) {
      return { status: 'unavailable', reason: 'WORKSPACE_NOT_DIRECTORY' };
    }
    return { root };
  } catch (error) {
    return {
      status: error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 'unavailable' : 'unknown',
      reason: error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 'WORKSPACE_NOT_FOUND' : 'WORKSPACE_UNREADABLE',
    };
  }
}

async function inspectFile(requirement, workspace) {
  const parts = safeParts(requirement.expected.relativePath);
  if (!parts) {
    return finding(requirement, 'unknown', 'PATH_NOT_ALLOWED', 'The requested path is outside the allowed relative-file scope.');
  }
  if (!workspace.root) {
    return finding(requirement, workspace.status, workspace.reason, 'Select an accessible local workspace explicitly; source workspace paths are never used.');
  }

  let candidate = workspace.root;
  try {
    for (const [index, part] of parts.entries()) {
      candidate = path.join(candidate, part);
      const metadata = await fs.lstat(candidate);
      if (metadata.isSymbolicLink() || !isWithin(workspace.root, await fs.realpath(candidate))) {
        return finding(requirement, 'unknown', 'LINK_NOT_ALLOWED', 'Symbolic links and paths outside the selected workspace are not inspected.');
      }
      const last = index === parts.length - 1;
      if ((!last && !metadata.isDirectory()) || (last && !metadata.isFile())) {
        return finding(requirement, 'unavailable', 'NOT_REGULAR_FILE', 'The required regular file is not present at the requested path.');
      }
      if (last) {
        return finding(requirement, 'available', 'FILE_PRESENT', 'A regular file exists. Contents, revision, readability, and behavior have not been validated.', {
          relativePath: parts.join('/'),
          size: metadata.size,
          modifiedAtMs: metadata.mtimeMs,
        });
      }
    }
  } catch (error) {
    const missing = error.code === 'ENOENT' || error.code === 'ENOTDIR';
    return finding(requirement, missing ? 'unavailable' : 'unknown', missing ? 'FILE_NOT_FOUND' : 'FILE_CHECK_FAILED',
      missing ? 'The required file is missing.' : 'File metadata could not be checked; no contents were read.');
  }
}

async function inspectRequirement(requirement, workspace) {
  switch (requirement.contractKey) {
    case 'runtime.bridge-node': {
      const version = process.versions.node;
      const available = Number(version.split('.')[0]) >= requirement.expected.minimumMajor;
      return finding(requirement, available ? 'available' : 'unavailable', available ? 'NODE_VERSION_MATCH' : 'NODE_VERSION_TOO_OLD',
        'Checked only this local bridge process, not the target agent or an external runtime.', { nodeVersion: version });
    }
    case 'runtime.bridge-platform': {
      const matches = process.platform === requirement.expected.platform;
      return finding(requirement, matches ? 'available' : 'changed', matches ? 'PLATFORM_MATCH' : 'PLATFORM_MISMATCH',
        'Checked the platform of this local bridge process.', { platform: process.platform });
    }
    case 'workspace.file':
      return inspectFile(requirement, workspace);
    default:
      return finding(requirement, 'unknown', 'NO_VERIFIED_ADAPTER', 'No trusted local adapter implements this contract. Tool names, source claims, and historical results do not establish current capability.');
  }
}

function aggregateReadiness(findings, coverage) {
  if (findings.some(item => item.required && item.status === 'unavailable')) return 'blocked';
  if (coverage !== 'reviewed' || !findings.length ||
      findings.some(item => item.required && item.status !== 'available')) return 'needs_adaptation';
  if (findings.some(item => item.status !== 'available')) return 'ready_with_limitations';
  return 'ready';
}

async function assessSnapshot(record, options = {}) {
  verifySnapshotRecord(record);
  if (options.workspaceRoot !== undefined &&
      (typeof options.workspaceRoot !== 'string' || !options.workspaceRoot.trim())) {
    throw new Error('workspaceRoot must be a non-empty local directory path');
  }
  if (options.workspaceRoot !== undefined && /^[\\/]{2}/.test(options.workspaceRoot)) {
    throw new Error('workspaceRoot must not be a network or device path');
  }
  if (options.requirementsReviewed !== undefined && typeof options.requirementsReviewed !== 'boolean') {
    throw new Error('requirementsReviewed must be a boolean');
  }

  const step = record.snapshot.resume.nextStep;
  const requirements = step ? step.requirements : [];
  // Do not inspect any workspace at all unless the selected step needs it.
  const workspace = requirements.some(item => item.contractKey === 'workspace.file')
    ? await resolveWorkspace(options.workspaceRoot)
    : { status: 'unknown', reason: 'WORKSPACE_NOT_SELECTED' };
  const findings = [];
  for (const requirement of requirements) {
    findings.push(await inspectRequirement(requirement, workspace));
  }
  const coverage = options.requirementsReviewed === true && requirements.length > 0 ? 'reviewed' : 'incomplete';
  const checkedAt = new Date().toISOString();

  return {
    status: aggregateReadiness(findings, coverage),
    sourceSnapshotId: record.manifest.snapshotId,
    sourceContentHash: record.manifest.contentHash,
    nextStepId: step ? step.id : null,
    requirementsDigest: `sha256:${contentHash({ nextAction: record.snapshot.resume.nextAction, nextStep: step || null })}`,
    environmentFingerprint: `sha256:${contentHash({
      nodeVersion: process.versions.node,
      platform: process.platform,
      workspace: workspace.root || null,
      findings,
    })}`,
    checkedAt,
    validity: 'point_in_time',
    coverage,
    coverageBasis: coverage === 'reviewed' ? 'recipient_attestation' : 'not_established',
    checkMode: 'passive',
    findings: findings.map(item => ({ ...item, checkedAt })),
    executionAuthorized: false,
    warning:
      'This advisory report covers only the declared next-step requirements. Completeness is not independently proven. ' +
      'No local file contents or credential stores were read, and no commands, data queries, or target-agent APIs were invoked. ' +
      'Reassess after changing the task or environment. Import and clone do not inherit this report as execution approval.',
  };
}

module.exports = { aggregateReadiness, assessSnapshot };
