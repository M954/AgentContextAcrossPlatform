# Passive Readiness for Reviewed Imports

Readiness is an advisory operation on an existing recipient import review. It does not approve import, launch a native host, run a source command, or grant permission to execute a next step.

## Usage

Bind the target/workspace while inspecting the bundle:

```powershell
node src/cli.js inspect "<sharing-link>" --target pi --workspace C:\my-project
node src/cli.js assess --review <import-review-id>
# After reviewing the declared prerequisite list for completeness:
node src/cli.js assess --review <import-review-id> --requirements-reviewed
```

The MCP equivalent is `session_assess` with `reviewId` and optional boolean `requirementsReviewed`. It accepts no workspace override. To select another workspace, inspect again and create a new review.

The operation checks review lifetime, account/configuration, local destination binding, and current remote access/version before inspecting local prerequisites. `requirementsReviewed` is only a completeness attestation, not a human authorization receipt. Import still requires its own exact-draft confirmation form or interactive CLI.

## Optional Snapshot Declaration

A snapshot can declare `resume.nextStep`:

```json
{
  "id": "check-project-inputs",
  "requirements": [
    {
      "id": "bridge-runtime",
      "kind": "runtime",
      "contractKey": "runtime.bridge-node",
      "required": true,
      "expected": { "minimumMajor": 20 }
    },
    {
      "id": "query-file",
      "kind": "workspace",
      "contractKey": "workspace.file",
      "required": true,
      "expected": { "relativePath": "queries/example.sql" }
    }
  ]
}
```

Requirements have unique bounded IDs, an explicit boolean `required`, a kind (`runtime`, `workspace`, `tool`, or `data`), a contract key, and an expected-value object. There are at most 64 entries. Known contracts reject unsupported fields/types. Unknown contracts remain data and yield `unknown`, never dynamic code loading.

Snapshots without this declaration remain importable but do not imply readiness. The legacy `requiredCapabilities` names alone do not prove any tool or data access. No automatic extraction or independent proof of requirement completeness is implemented.

## Implemented Checks

| Contract | Check |
|---|---|
| `runtime.bridge-node` | Local bridge Node major version meets `minimumMajor`; not the target agent's runtime |
| `runtime.bridge-platform` | Local bridge platform matches `platform`; a difference is `changed` |
| `workspace.file` | A regular file exists at a bounded relative path under the reviewed workspace |
| Any other contract | `unknown` / `NO_VERIFIED_ADAPTER` |

File checks inspect metadata only. They do not read contents, follow links/junctions, enumerate a directory tree, or establish file safety, readability, or semantic equivalence. Unsafe/sensitive paths stay unknown rather than being reported as absent. Explicit network-style workspace paths are rejected, but this is not detection of every mounted network filesystem or an OS sandbox.

## Status Rules

| Condition | Status |
|---|---|
| Required prerequisite confirmed unavailable | `blocked` |
| Required prerequisite unknown/changed, or coverage unreviewed/empty | `needs_adaptation` |
| Required prerequisites pass; optional ones have limitations | `ready_with_limitations` |
| Declared prerequisites pass and coverage is attested to | `ready` |

Reports include the source hash, review digest, selected step, findings, checked time, a local fact fingerprint, and `executionAuthorized: false`. They are point-in-time observations, not reusable authorization tokens. Changed prerequisites require reassessment; changing target/workspace requires a new import review.

A blocked report does not prevent a user from importing context for inspection. Neither document nor native import automatically upgrades its own execution state: both remain `not_assessed`. A subsequent action must be independently reviewed against the recipient's actual environment.
