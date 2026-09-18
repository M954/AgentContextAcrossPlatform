'use strict';

const MAX_REQUIREMENTS = 64;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const KINDS = new Set(['runtime', 'workspace', 'tool', 'data']);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invalid(location, message) {
  // Do not include imported values in validation errors.
  throw new Error(`Invalid next-step requirements at ${location}: ${message}`);
}

function onlyKeys(value, keys, location) {
  if (Object.keys(value).some(key => !keys.includes(key))) {
    invalid(location, 'unexpected property');
  }
}

function validateNextStep(step) {
  if (step === undefined) {
    return;
  }
  const location = 'resume.nextStep';
  if (!isObject(step)) invalid(location, 'expected an object');
  onlyKeys(step, ['id', 'requirements'], location);
  if (typeof step.id !== 'string' || !IDENTIFIER.test(step.id)) {
    invalid(`${location}.id`, 'expected a bounded identifier');
  }
  if (!Array.isArray(step.requirements) || step.requirements.length > MAX_REQUIREMENTS) {
    invalid(`${location}.requirements`, `expected at most ${MAX_REQUIREMENTS} entries`);
  }

  const ids = new Set();
  for (const [index, requirement] of step.requirements.entries()) {
    const at = `${location}.requirements[${index}]`;
    if (!isObject(requirement)) invalid(at, 'expected an object');
    onlyKeys(requirement, ['id', 'kind', 'contractKey', 'required', 'expected', 'description'], at);
    if (typeof requirement.id !== 'string' || !IDENTIFIER.test(requirement.id) || ids.has(requirement.id)) {
      invalid(`${at}.id`, 'expected a unique bounded identifier');
    }
    ids.add(requirement.id);
    if (!KINDS.has(requirement.kind)) invalid(`${at}.kind`, 'unsupported requirement kind');
    if (typeof requirement.contractKey !== 'string' || !IDENTIFIER.test(requirement.contractKey)) {
      invalid(`${at}.contractKey`, 'expected a bounded contract identifier');
    }
    if (typeof requirement.required !== 'boolean') invalid(`${at}.required`, 'expected a boolean');
    if (!isObject(requirement.expected)) invalid(`${at}.expected`, 'expected an object');
    if (requirement.description !== undefined &&
        (typeof requirement.description !== 'string' || requirement.description.length > 2000)) {
      invalid(`${at}.description`, 'expected a string of at most 2000 characters');
    }

    switch (requirement.contractKey) {
      case 'runtime.bridge-node':
        if (requirement.kind !== 'runtime') invalid(at, 'contract kind must be runtime');
        onlyKeys(requirement.expected, ['minimumMajor'], `${at}.expected`);
        if (!Number.isSafeInteger(requirement.expected.minimumMajor) ||
            requirement.expected.minimumMajor < 0 || requirement.expected.minimumMajor > 1000) {
          invalid(`${at}.expected.minimumMajor`, 'expected an integer between 0 and 1000');
        }
        break;
      case 'runtime.bridge-platform':
        if (requirement.kind !== 'runtime') invalid(at, 'contract kind must be runtime');
        onlyKeys(requirement.expected, ['platform'], `${at}.expected`);
        if (typeof requirement.expected.platform !== 'string' || !IDENTIFIER.test(requirement.expected.platform)) {
          invalid(`${at}.expected.platform`, 'expected a platform identifier');
        }
        break;
      case 'workspace.file':
        if (requirement.kind !== 'workspace') invalid(at, 'contract kind must be workspace');
        onlyKeys(requirement.expected, ['relativePath'], `${at}.expected`);
        if (typeof requirement.expected.relativePath !== 'string' ||
            !requirement.expected.relativePath.length || requirement.expected.relativePath.length > 512) {
          invalid(`${at}.expected.relativePath`, 'expected a path of 1 to 512 characters');
        }
        break;
      default:
        // Unknown contracts remain data. No dynamic module loading or execution.
        break;
    }
  }
}

module.exports = { MAX_REQUIREMENTS, validateNextStep };
