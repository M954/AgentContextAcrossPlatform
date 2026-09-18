# Code Plan: Session Sharing with Recipient Readiness Checks

> Status: Target design with a partial implementation. The modules and readiness workflow below are not all completed; use [Current workflow, user experience, and remaining gaps](WORKFLOW_AND_GAPS.md) for the implemented customer journey.
> Based on the [active project plan](PROJECT_PLAN.md), with an important refinement: restoring context and being able to continue execution are separate outcomes. A successful import must never imply that the recipient's environment reproduces the source environment.
> The earlier knowledge-mining direction remains in [KNOWLEDGE_HANDOFF_PLAN.md](KNOWLEDGE_HANDOFF_PLAN.md) and is not part of this implementation's first milestone.

Implementation update: v0.3.0 retains OneDrive/SharePoint transport, delegated MSAL authentication, content-bound human reviews and official MCP tools. It adds pi live capture, selected export parsing, advisory readiness, and native pi/Copilot import after exact target/workspace review and remote access/version rechecks. No boolean approval bypass or custom production sharing server is restored. See [PI.md](PI.md) and [READINESS.md](READINESS.md). Live tenant acceptance and general environment compatibility remain unverified.

v0.4.0 adds `session_share` / `session_resume` quick actions, `npx`-launchable CLI/MCP bins for one-command registration, and portable Markdown for no-addon recipient reading. Existing staged operations and native-import checks remain; simplifying visible commands does not merge consent with execution. A managed publisher app profile and optional bundled runtime remain setup priorities, while recipients should use an existing authorized reader rather than being required to install this integration.

## 1. Implementation Target

Build one end-to-end workflow:

```text
A: /session share
   capture -> normalize -> redact -> review -> publish immutable snapshot
                                                       |
                                                authenticated link
                                                       |
B: /session resume <link>
   fetch -> validate -> inspect -> bind local environment -> check readiness
                                                       |
                              explicit approval -> create paused local session
                                                       |
                         separate approval -> validate or run one supported next step
```

The user-facing interface remains two commands. Review, environment mapping, session creation, and execution are separate steps behind those commands.

### What We Can Promise

- Preserve the authorized, captured records and explicitly report omissions.
- Import them into a supported host, or provide a clearly labeled context-document fallback.
- Check the known prerequisites of a selected next step.
- Report missing, changed, and unknown dependencies instead of pretending the environment was restored.
- Use the recipient's own credentials and tools for any new operation.

### What We Cannot Promise

- An identical model state, live process, filesystem, service connection, or future response.
- Complete requirements discovery from an arbitrary transcript.
- Identical historical query results after external data changes.
- Native session creation in a host without a verified supported mechanism.
- Successful completion of the original task merely because import or preflight succeeds.

A context-only import, a native session with blocked execution, and a native session ready for a specific next step are distinct, valid outcomes.

## 2. Proposed Stack and Repository Layout

### Current Baseline

Commit `0a2fcc5` added a dependency-free JavaScript prototype: `src/cli.js`, `src/server.js`, `src/snapshot.js`, `src/storage.js`, a synthetic session fixture, and `test/e2e.test.js`. Its package declares Node.js >=20 and uses npm scripts with the built-in Node test runner. The documented service is loopback-only and does not provide production authentication or native host-session integration.

Build on that baseline rather than treating this as an empty repository. Preserve the existing commands and tests while extracting interfaces and adding readiness checks. Check snapshot compatibility before introducing a replacement schema. The layout and stack below are a proposed evolution, not a prerequisite for the next incremental change.

### Target Stack

Use TypeScript with strict checking, Node.js 24 LTS, pnpm workspaces, Zod for runtime schemas, Vitest for tests, and the official MCP SDK for the local bridge. Use Fastify for a minimal authenticated remote API. Lock dependency versions if this migration is adopted; no packages are installed by this plan.

The earlier standalone SQLite/HTTP provider proposal is superseded for the main sharing path: use the existing OneDrive/SharePoint provider and MSAL authentication. The local HTTP implementation remains a synthetic test provider. The module layout below is conceptual; the current implementation stays in `src/` without requiring a TypeScript/workspace rewrite.

```text
apps/
  bridge/src/                 # Local MCP operations; host integration entry points
  cli/src/                    # Development and context-document fallback client
  remote/src/                 # Authenticated snapshot API; no model execution
packages/
  contracts/src/
    snapshot.ts               # Versioned capture schema and runtime validation
    requirements.ts           # Next-step requirements and local bindings
    readiness.ts              # Findings, reports, and restore results
    errors.ts                 # Typed failure codes
  core/src/
    capture.ts                # Scope enforcement and record normalization
    redact.ts                 # Redaction and omission accounting
    integrity.ts              # Canonical serialization and content digests
    publish.ts                # Prepare/review/publish orchestration
    inspect.ts                # Authenticated fetch and validation
    requirements.ts           # Proposed requirements with sources and uncertainty
    readiness.ts              # Deterministic aggregation of adapter findings
    restore.ts                # Budgeted context assembly and paused-session creation
    approvals.ts              # Local review receipts and invalidation
    local-store.ts            # Private drafts, reports, and imported artifacts
  adapters/src/
    hosts/                    # Host-specific capture and restore implementations
    capabilities/             # Trusted tool, data, workspace, and runtime checks
    remote/                   # HTTP client and in-memory test provider
    fixtures/                 # Explicitly simulated hosts and generic task dependencies
tests/
  fixtures/                   # Sanitized source records and environment variants
  unit/
  contract/
  integration/
  e2e/
docs/
  CODE_PLAN.md
```

Keep these as a few workspace packages with internal modules, not a microservice fleet. Do not add a web dashboard, vector database, or generic workflow engine to the first slice.

## 3. Data Contracts

All external inputs require runtime validation. The snippets below show contract boundaries, not complete implementations.

### 3.1 Immutable Snapshot vs. Mutable Access State

The first wire format is one bounded UTF-8 JSON payload containing:

- `schemaVersion` and source host/adapter metadata.
- Normalized messages and linked tool requests/results with stable record IDs.
- A task summary, open decisions, and proposed next steps.
- Opt-in workspace metadata and selected text excerpts.
- Proposed requirements with source references and explicit uncertainty.
- Redaction and omission records, including incomplete tool results or attachments.

Start with bounded text evidence. Record unsupported binary attachments as omissions rather than implementing archive extraction in the first iteration.

Use a separate envelope containing the server-assigned snapshot ID, payload digest, parent snapshot ID, and authenticated publication metadata. The digest covers canonical payload bytes, not an envelope containing its own digest. Use a tested JSON canonicalization implementation and published test vectors rather than an ad hoc serializer.

Owner identity, recipient access, revocation, and expiration belong to server-managed metadata outside the immutable payload. A client-supplied author field is only a provenance claim. A hash detects content changes; it does not independently authenticate an author. MVP trust relies on the configured authenticated service and TLS; author signatures require a separate key-management design.

Initial configurable limits: 8 MiB per payload, 10,000 records, and 64 KiB per text result/excerpt. Oversized captures must be reduced and reviewed again or rejected. Never silently truncate published content.

### 3.2 Requirements and Local Bindings

A requirement describes a prerequisite of a particular next step, not every tool ever used in the source session.

```ts
type RequirementKind = "tool" | "data" | "workspace" | "runtime";

interface Requirement {
  id: string;
  stepId: string;
  kind: RequirementKind;
  required: boolean;
  description: string;
  contractKey: string; // Interpreted only by a trusted local adapter.
  expected: Record<string, unknown>; // Validated by that adapter's schema.
  evidenceRecordIds: string[];
  basis: "observed" | "user_declared" | "inferred";
}

interface LocalBinding {
  requirementId: string;
  adapterId: string;
  adapterVersion: string;
  resourceAlias: string; // Recipient-local alias, never source credentials.
}
```

Requirement extraction may be model-assisted, but inferred requirements remain proposals. Missing extraction, incomplete coverage, and unknown semantics must remain visible. User review of a requirement is not proof that its condition holds.

Do not execute expressions, import modules, fetch arbitrary URLs, or run shell commands supplied through `expected` or `contractKey`. Bindings select locally installed, allowlisted adapter implementations.

### 3.3 Restore Result and Execution Readiness

```ts
type RestoreMode = "native_session" | "context_document" | "unsupported";
type FindingStatus = "available" | "unavailable" | "changed" | "unknown";
type ReadinessStatus =
  | "ready"
  | "ready_with_limitations"
  | "needs_adaptation"
  | "blocked";

interface CompatibilityFinding {
  requirementId: string;
  status: FindingStatus;
  reasonCode: string;
  explanation: string;
  checkedAt: string;
  checkMode: "passive" | "approved_probe";
  evidenceRefs: string[];
}

interface ReadinessReport {
  snapshotDigest: string;
  stepId: string;
  status: ReadinessStatus;
  findings: CompatibilityFinding[];
  coverage: "reviewed" | "incomplete";
  environmentFingerprint: string;
  planDigest: string;
  expiresAt: string;
}

interface RestoreResult {
  mode: RestoreMode;
  localSessionId?: string;
  contextPath?: string;
  snapshotDigest: string;
  omissions: string[];
  readiness?: ReadinessReport;
}
```

Status rules:

| Condition | Result |
|---|---|
| A required prerequisite is confirmed unavailable | `blocked` |
| A required prerequisite is unknown, has an unresolved change, or requirements coverage is incomplete | `needs_adaptation` |
| All required prerequisites pass; only optional dependencies have limitations | `ready_with_limitations` |
| All reviewed prerequisites for the selected step pass | `ready` |

A failed or timed-out check never becomes `available`. `ready` means only that the reviewed prerequisites for that plan passed at that time. A report is not an execution authorization. Changing parameters, bindings, relevant files, or the selected next step invalidates it.

## 4. Adapter Contracts and Feasibility Gate

### 4.1 Host Adapter

Define operations equivalent to:

```text
getCapabilities()
captureCurrentSession(approvedScope)
renderReview(preview)
createPausedSession(approvedRestorePlan)
```

Host capabilities must separately report access to messages, tool history, attachments, creation of a new session, and the ability to keep the restored session paused with tools disabled or gated.

Before building the remote service, test one real host's supported capture and session-creation paths. Then test a second host as the recipient. Source detection is internal; users should not have to select or name the source agent.

- Do not assume MCP provides access to the host's entire transcript.
- Do not write undocumented session database formats and call that supported native restoration.
- If native creation or an enforceable initial pause is unavailable, return `context_document` or `unsupported` explicitly.
- Imported source system/developer messages must not become local privileged instructions. Preserve authorized material only as labeled historical data.
- Historical tool calls/results must not become pending local operations or claims that B executed them.
- The plugin cannot control tools invoked outside its own integration. Document that boundary; do not claim that a prompt alone enforces a host-wide execution gate.

### 4.2 Capability Adapter

Provide separate operations for passive inspection and explicitly approved probes:

```text
inspect(requirement, localBinding) -> CompatibilityFinding
planProbe(requirement, localBinding, limits) -> ReviewableProbe
executeApprovedProbe(probe, localApproval) -> CompatibilityFinding
```

Passive inspection uses authorized local configuration, tool schemas, safe file metadata, and recorded versions. Reading remote data or launching a runtime probe requires a separate approval with limits.

Tool-name similarity is insufficient for equivalence. A valid mapping must account for input/output contracts and relevant semantics. Snapshot content cannot register a new adapter or change local policy.

### 4.3 Remote Store

```text
publish(reviewedPayload, accessPolicy, idempotencyKey) -> PublishedSnapshot
inspect(snapshotId) -> AuthorizedMetadata
fetch(snapshotId) -> SnapshotEnvelope
revoke(snapshotId) -> AccessState
```

Production and fixture providers implement the same contract. Local imports, reports, and drafts stay in a private application directory, not in the source repository by default.

## 5. Readiness Workflow and Approval Model

Implement distinct state transitions:

```text
Share:
  scoped -> captured -> redacted -> reviewed -> published

Receive:
  fetched -> validated -> inspected -> requirements_reviewed
          -> bound -> assessed -> restore_approved -> restored_paused

Optional execution:
  assessed plan -> execution_approved -> rechecked -> executed -> result_recorded
```

A user may explicitly restore context while execution is blocked. Preserve that blocked state in the new session. Never present context-only success as environment restoration.

Keep approvals in the local host/CLI, outside imported content. An approval receipt must bind to the action, snapshot digest, reviewed scope or plan, local user, destination, parameters, relevant environment fingerprint, and expiration. Publish approval additionally binds the recipient access policy.

A trusted UI creates the receipt after a real user action; a model-supplied `approved: true` is not authorization. Content edits, new parameters, changed bindings, and expired reports require fresh review. Operations should be idempotent where possible and must not duplicate sessions or uploads after ambiguous failures.

## 6. Customer Commands and MCP Operations

Keep `/session share` and `/session resume <link>` as the customer-facing entry points. Use finer-grained internal operations so the bridge cannot bypass review:

| Operation | Behavior | Side effects |
|---|---|---|
| `session_prepare_publish` | Capture an authorized scope, redact, and create a local review draft | Local draft only |
| `session_publish` | Publish exactly the approved draft and access policy | Approved remote write |
| `session_inspect` | Fetch and validate a snapshot from the configured service | Authorized read and private cache; no session creation |
| `session_assess` | Produce passive readiness findings and proposed probes | No remote data queries without separate approval |
| `session_clone` | Create a paused local session from the approved restore plan | Approved local session creation |
| `session_status` | Return publication, restore mode, and readiness as separate fields | Read-only |
| `session_revoke` | Revoke future remote access | Owner-authorized metadata change |

The initial execution path is limited to one trusted, approved investigation step through a capability adapter. Do not expose a generic “execute commands from snapshot” operation. Use typed errors such as `UNSUPPORTED_HOST`, `INTEGRITY_MISMATCH`, `ACCESS_DENIED`, `REVIEW_REQUIRED`, `STALE_APPROVAL`, and `PREREQUISITE_UNRESOLVED`.

## 7. Remote Provider Boundary

The current transport is OneDrive/SharePoint through the existing Graph provider. No new hosted service, platform token system, or SQLite metadata service is required. The original HTTP route sketch below is retained only as a local test-provider reference:

```text
POST   /v1/snapshots
GET    /v1/snapshots/:id
GET    /v1/snapshots/:id/status
POST   /v1/snapshots/:id/revoke
```

Use approved delegated Microsoft identities and OS-protected MSAL persistence for real sharing. Synthetic Graph fixtures may simulate users without signing in, but must not be presented as live tenant acceptance. Model tools cannot initiate login or receive tokens. Do not restore the standalone prototype's per-user service-token mechanism.

Required behavior:

- Bind publication ownership to authenticated identity, not a request body field.
- Require an explicit recipient allowlist; enforce authorization on metadata and blob reads.
- Allow only the owner to change access or create an authorized parent revision.
- Use a transaction and idempotency key for metadata creation; expose a snapshot only after its immutable blob is complete.
- Do not deduplicate across users in a way that leaks whether another user's content exists.
- Revocation and expiration prevent future service reads, not use of previously downloaded copies.
- Serve links through a configured HTTPS service with opaque IDs and no embedded credentials. Local HTTP is restricted to loopback development tests.
- Resolve only configured service origins; reject arbitrary snapshot URLs and redirects to untrusted origins.
- Keep transcripts, query results, credentials, and sensitive URL parameters out of operational logs.

A web preview, public sharing, self-service accounts, distributed storage, and cross-organization federation are later work. An authenticated link can be consumed by the local plugin without building a browser application.

## 8. Generic Coding Validation

The demo uses a synthetic unfinished coding task, not Titan or another domain data source. It captures pi/Copilot exports, prepares exact reviews, simulates named-recipient Graph access, and creates a real native session in the selected installed host after a synthetic test confirmation.

Production interfaces still require trusted human UI; the demo must not automate the CLI confirmation phrase or use a live Microsoft account. Reports distinguish fixture history/Graph transport from actual native creation. No model fixes the example task during this test.

Acceptance includes both pi-to-Copilot and Copilot-to-pi, denied recipients, remote changes/revocation before import, target/workspace changes during approval, and no duplicate host invocation on receipt replay. Passive readiness checks are optional; unknown tool/data prerequisites are not guessed or executed.

## 9. Test Plan

### Unit and Contract Tests

- Schema/version rejection; malformed IDs, invalid references, and oversized content.
- Stable canonical serialization and digest test vectors; payload tampering detection.
- Redaction across messages, arguments, results, attachments, and URL values using synthetic secrets.
- Explicit omission records and preservation of source/result relationships.
- Every readiness aggregation combination, including incomplete coverage and timeouts.
- Invalidated reports and approvals after plan, parameter, binding, or environment changes.
- Host capability reporting and native-session versus context-document fallback behavior.

### Integration and Security Tests

- A publishes; authorized B reads; unrelated C and unauthenticated clients cannot inspect or fetch.
- Ownership spoofing, unauthorized revisions, expired links, revoked links, and immutable version behavior.
- Upload interruption, retry idempotency, and local clone deduplication after partial failure.
- Untrusted origins, redirects, malicious file references, forged source roles, and prompt injection in tool results.
- Import/preview/clone does not execute a tool; an approved probe executes only its reviewed bounded operation.
- Credentials are resolved locally and never copied into an export or operational log.
- Large context is excerpted with explicit omissions and on-demand references, not silently dropped.

### Environment Matrix

| Recipient condition | Expected behavior |
|---|---|
| Required capability and data semantics match | Ready for the selected step after checks and approval |
| Equivalent verified tool under a different name | Ready after explicit local binding and checks |
| Same tool name but different metric semantics | Needs adaptation; no query execution |
| Required data access denied | Blocked; context may still be reviewed or restored with warnings |
| Required local script or file is missing | Blocked until explicitly supplied or replaced and rechecked |
| Optional historical attachment is missing | Limitation recorded; do not block an unrelated next step |
| Different OS, irrelevant to the selected remote query | No failure based on OS difference alone |
| Host cannot create a paused native session | Context-document fallback, never a native-clone success claim |
| Data or permissions change after preflight | Recheck; report current failure rather than trust stale readiness |

## 10. Implementation Milestones

| Milestone | Main files/modules | Completion gate |
|---|---|---|
| M0: Host feasibility | Host adapter spikes and capability notes | One supported capture path and recipient restore behavior demonstrated; limitations documented |
| M1: Contracts and fixtures | `contracts`, fixture adapters, test setup | Valid/invalid fixtures and digest tests pass; no claimed production adapters |
| M2: Local safety and capture | `capture`, `redact`, `approvals`, `local-store` | Reviewable capture with no implicit upload; synthetic secret tests pass |
| M3: Recipient readiness | `requirements`, `readiness`, capability adapters | Environment matrix passes locally before adding network transport |
| M4: Remote publish/inspect | Remote API and client | Two identities exchange an immutable snapshot; third identity denied; retries and revocation tested |
| M5: Host/bridge integration | MCP bridge, real host adapters, `restore` | Share/resume commands create an approved paused session or report the fallback honestly |
| M6: Generic cross-agent validation | Reviewed Graph fixture, pi/Copilot adapters, end-to-end tests | Native import confirmed without model execution; revoked or changed reviews cannot invoke a host |

M0 is the go/no-go gate for the native-session promise. If it fails, explicitly narrow the demo to context handoff and readiness reporting rather than forging host session files.

After contracts stabilize, host adapters, readiness adapters, and the remote provider can be developed in parallel. Avoid making remote infrastructure the first dependency for testing extraction and compatibility logic.

## 11. Definition of Done

The MVP is complete only when:

1. One real source host captures an approved, bounded session without asking the user to identify its format.
2. A publishes a reviewed snapshot and shares an authenticated link with B.
3. B can inspect it without executing source instructions or changing a repository.
4. The output separately identifies imported context, restore mode, and next-step readiness.
5. Required unknown or unavailable dependencies prevent execution, not necessarily context inspection.
6. B approves session creation and any probe or next action separately.
7. A verified adapter uses B's local permissions for a bounded operation; no source credentials are needed.
8. An incompatible environment produces a useful report instead of a false success.
9. The documentation states exactly which hosts and capabilities were tested, and which paths are simulated or unsupported.

Compare against manually sharing the same transcript/summary and adapting it in B's agent. Measure clarification requests, manual mapping steps, missing prerequisites caught, and actual operation outcomes. Do not substitute import success for task success.

## 12. Deferred Work

- Whole-machine, cross-session knowledge mining and generated Skills.
- Generic shell execution, automated environment repair, package installation, or patch application.
- Containers intended to reproduce the source machine; they do not solve data access or identity differences.
- Live process cloning, model-state restoration, or guaranteed semantic equivalence.
- Full binary attachment/archive support, enterprise federation, public previews, and author-signing key infrastructure.
- Additional host/provider integrations before the first two-host workflow is validated.

Open implementation choices include additional host adapters, optional domain-specific capability checks, and live Microsoft tenant deployment. These are engineering decisions to resolve through spikes, not mandatory source-agent questions in the customer flow.
