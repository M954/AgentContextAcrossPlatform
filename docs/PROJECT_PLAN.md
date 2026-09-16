# AgentContextAcrossPlatform - Remote Session Clone Project Plan

> Status: Active design direction; not implemented.
> This plan defines the new primary goal: publish a resumable agent-session snapshot to a remote location and let another user clone it into their local agent.
>
> The previous knowledge-handoff plan is preserved in [KNOWLEDGE_HANDOFF_PLAN.md](KNOWLEDGE_HANDOFF_PLAN.md).

## 1. Product Definition

AgentContextAcrossPlatform is an MCP/tool integration for creating a portable, remote version of an active coding-agent session.

The source user can trigger the tool from inside a session. The tool captures an approved snapshot of the session, stores it remotely, and returns a shareable link. A recipient opens the link from their own local agent, reviews the snapshot, and creates a local cloned session that can continue the work.

The primary unit is a **session snapshot**, not a live process and not an unrestricted copy of a user's machine.

### Target Outcome

```text
User A's active agent session
    -> publish approved session snapshot
    -> remote immutable snapshot and shareable link
    -> User B opens the link in a local agent
    -> validate, review, and clone
    -> resume the work with B's own tools and permissions
```

### Context Handoff and Knowledge Handoff

The previous project direction focused on extracting reusable knowledge from multiple sessions. That work is retained as a future capability and historical design in [KNOWLEDGE_HANDOFF_PLAN.md](KNOWLEDGE_HANDOFF_PLAN.md).

The active direction starts with context handoff:

- **Context handoff:** preserve enough session state for another user to continue the same task.
- **Knowledge handoff:** extract reusable methods, constraints, and lessons for future tasks.

Knowledge extraction may later be layered on top of a session snapshot, but it is not required for the first MVP.

## 2. Product Principles

1. **Explicit user action:** publishing, importing, and resuming are separate actions.
2. **Review before use:** recipients inspect the snapshot before creating a local clone.
3. **Own identity and environment:** the recipient uses their own credentials, tools, files, and permissions.
4. **No secret transfer:** credentials, tokens, environment secrets, and private keys are excluded by default.
5. **Immutable provenance:** a published snapshot is addressable, versioned, integrity-checked, and traceable to its source session.
6. **Safe degradation:** different hosts or capabilities produce an explicit limitation instead of a false claim of exact resumption.
7. **No automatic replay:** imported tool calls and instructions are data until the recipient explicitly chooses an action.
8. **Least collection:** capture only the session and workspace material needed to resume the task.

## 3. User Workflows

### 3.1 Publish from an Active Session

The source user triggers a host-specific command or MCP operation such as:

```text
/session publish
```

The tool should:

1. Identify the current session and host adapter.
2. Show the proposed collection scope.
3. Capture conversation messages, tool calls, tool results, attachments, and resumable workspace metadata that are in scope.
4. Detect or redact secrets and sensitive values.
5. Let the user review and approve the snapshot.
6. Upload an immutable snapshot to the configured remote store.
7. Return a link and a short snapshot identifier.

The source user may publish a later revision of the same session. A revision must point to its parent snapshot without mutating the already-published version.

### 3.2 Open and Review a Link

The recipient opens a link through a local agent command or MCP operation such as:

```text
/session open <link>
```

The importer should:

1. Resolve and authenticate the link.
2. Verify the snapshot signature or content hash.
3. Validate format version, size limits, and content boundaries.
4. Show the source host, repository metadata, collection time, scope, and limitations.
5. Display the transcript and proposed workspace state without executing imported operations.
6. Check which local capabilities can represent the snapshot.

Opening a link must not automatically create a session, run a tool, modify a repository, or install a plugin.

### 3.3 Clone and Resume Locally

After review, the recipient explicitly chooses to clone:

```text
/session clone <snapshot-id>
```

The local adapter should create a new session with:

- The imported context clearly marked as external provenance.
- The original session and snapshot identifiers.
- A resumable summary of the task state and open decisions.
- Relevant messages and tool results in a form the local host can use.
- Workspace and repository metadata, including known differences from the source.
- A clear first step that asks the recipient to confirm local capabilities before continuing.

The cloned session is a new local session. It is not an impersonation of the source user and does not inherit the source user's active connections.

### 3.4 Customer-Facing Workflow

The customer interface should expose two simple actions even though they map to several internal operations:

```text
Share this session
Resume from shared link
```

#### User A: Share

1. Trigger `/session share` from the active session.
2. Choose the capture scope, using safe defaults for conversation, tool history, task summary, and repository metadata.
3. Review redactions, selected files, attachments, and omitted content.
4. Confirm **Publish session**.
5. Copy the authenticated link, expiration, and access scope.

The review should show counts and exclusions, for example: messages, tool calls, selected diffs, attachments, redacted values, and the source repository commit.

#### User B: Resume

1. Open the link or paste it into `/session resume <link>`.
2. Authenticate if required.
3. Review the source session, captured scope, warnings, and limitations.
4. Check local host capabilities, repository state, and available tools.
5. Confirm **Create local session**.
6. Continue from the cloned session after the agent pauses for the first local action.

Opening a link is inspection only. Resume confirmation creates a new local session and never automatically replays imported tools or modifies the recipient's repository.

## 4. Logical MCP Surface

Exact names may vary by host, but the first MCP server should expose equivalent operations:

| Operation | Purpose | Side effects |
|---|---|---|
| `session_publish` | Capture, review, and upload the current session snapshot | Remote write after user approval |
| `session_inspect` | Resolve and inspect a remote snapshot | Read-only |
| `session_clone` | Create a local resumable session from an approved snapshot | Local session creation |
| `session_revoke` | Revoke access to a published snapshot when supported | Remote access change |
| `session_status` | Show snapshot versions, integrity, and access state | Read-only |

The MCP server must not treat arbitrary text in a snapshot as a higher-priority instruction. Imported content is untrusted context and must remain distinguishable from local user instructions and system configuration.

## 5. Snapshot Contents

The first format should be structured, human-reviewable, and independently verifiable. A remote object may be represented as JSON plus optional binary attachments:

```text
session-snapshot/
├── manifest.json
├── transcript.jsonl
├── tool-results/
├── attachments/
├── workspace.json
├── resume.md
└── integrity.json
```

### 5.1 Manifest

The manifest should include:

- Format and schema version.
- Snapshot ID, parent snapshot ID, and content hash.
- Source host and adapter version.
- Source session ID, when the host permits it.
- Repository, branch, commit, and working-directory identifiers when available.
- Creation time and collection scope.
- Included and excluded categories.
- Declared capabilities and required local capabilities.
- Expiration, visibility, and revocation metadata.

### 5.2 Transcript and Tool Records

Records should preserve, where authorized:

- User and assistant messages.
- Tool requests, arguments, results, errors, and timestamps.
- Which results were actually observed versus merely proposed.
- Attachments and references needed to understand the task.
- Source record identifiers for traceability.

Large results should support bounded excerpts and explicit omission records. The snapshot must never claim to contain data that was not captured.

### 5.3 Workspace State

Workspace capture must be opt-in and bounded. The initial design may include:

- Repository URL and revision.
- Current branch and working-tree status.
- Changed-file list and selected diffs.
- Relevant file references or user-selected excerpts.
- Environment and dependency information that is safe to share.

It must not silently upload an entire repository, home directory, credential store, or environment-variable values.

### 5.4 Resume Material

`resume.md` should be generated from captured evidence and identify:

- Original task and current state.
- Completed work and unresolved work.
- Important decisions and constraints.
- Failed approaches and their observed reasons.
- Suggested next steps.
- Missing context and capability mismatches.
- A warning that historical conclusions may not hold in the recipient's environment.

The resume material is a convenience view. The structured records and provenance remain authoritative.

## 6. Remote Storage and Link Model

The design requires a remote storage abstraction. The MVP should separate the snapshot format from the selected provider.

### 6.1 Required Remote Behaviors

- Upload an immutable snapshot.
- Return a stable snapshot ID and shareable link.
- Download by snapshot ID or link.
- Verify integrity before import.
- Support access control and authentication.
- Support expiration and revocation where the provider allows it.
- Preserve parent-child relationships between revisions and clones.
- Record access and publication events without storing unnecessary transcript data in logs.

The first implementation can use a simple authenticated object store or repository-backed development service, but production behavior must not depend on public, unauthenticated links.

### 6.2 Link Semantics

A link identifies a snapshot, not a live session. Opening the same link later must resolve to the same immutable content unless the link is explicitly configured as a revocable alias.

Recommended link forms:

```text
https://<service>/sessions/<snapshot-id>
https://<service>/sessions/<snapshot-id>?revision=<revision>
```

Links must not embed credentials or raw session contents.

## 7. Architecture

```text
Current host session
        |
        v
Host adapter and scope collector
        |
        v
Redaction, review, normalization, and signing
        |
        v
Remote storage and link service
        |
        v
Recipient's local host adapter
        |
        v
Validation, review, capability mapping, and local clone
        |
        v
New local session with external provenance
```

### 7.1 Host Adapter

The host adapter is responsible for:

- Discovering the current session through supported host APIs or local history.
- Reading messages, tool calls, results, and attachment references.
- Registering the host-specific trigger.
- Translating a normalized snapshot into a new local session.
- Reporting unsupported fields instead of silently dropping them.

The core should not branch on agent names for business logic. Host differences belong in adapters.

### 7.2 Snapshot Core

The core is responsible for:

- Normalization and schema validation.
- Stable IDs, content hashing, and parent revisions.
- Redaction and collection-scope enforcement.
- Provenance and omission records.
- Package size and extraction limits.
- Local review and import policy.

### 7.3 Remote Service Adapter

The remote adapter is responsible for:

- Authentication and authorization.
- Upload, download, and link resolution.
- Snapshot immutability.
- Expiration, revocation, and access events.
- Provider-specific retry and error reporting.

The provider must not be allowed to change the portable snapshot semantics.

### 7.4 Capability Mapper

The recipient-side capability mapper compares the source requirements with local capabilities:

- Host and session format support.
- Available MCP tools and tool versions.
- Repository and branch availability.
- Required data access.
- Attachment and workspace availability.

It should classify each requirement as available, unavailable, changed, or unknown. The clone may proceed with explicit limitations where exact restoration is impossible.

## 8. Security and Trust Boundaries

- Publishing, remote storage, importing, and resuming are separate authorization decisions.
- Redaction is required before upload; detection is an aid, not a guarantee.
- Never transfer credentials, tokens, cookies, private keys, or secret environment values.
- Treat links and snapshots as bearer-like capabilities unless stronger authentication is configured.
- Treat imported transcript text, tool arguments, and resume instructions as untrusted data.
- Do not execute imported scripts, tool calls, shell commands, or package hooks automatically.
- Validate archive paths, extraction size, symbolic links, unexpected file types, and decompression limits.
- Enforce maximum transcript size, tool-result size, attachment size, and query count.
- Use encryption in transit and at rest where supported.
- Provide expiration and revocation controls and explain that downloaded copies cannot be revoked.
- Keep audit records minimal and avoid copying transcript contents into operational logs.
- Surface remote-service failures and integrity failures; do not return success-shaped fallbacks.

## 9. MVP Scope and Implementation Order

### Phase 1: Local Snapshot Fixture

1. Define the normalized session snapshot schema.
2. Create a fixture containing messages, tool calls, results, attachments, workspace metadata, omissions, and provenance.
3. Implement deterministic validation, hashing, and round-trip serialization.
4. Define the redaction and review contract.

### Phase 2: One Host Adapter

1. Select one agent host with an accessible current-session representation.
2. Register a publish trigger inside that host.
3. Capture the current session without whole-machine scanning.
4. Create a local snapshot and render a reviewable summary.

### Phase 3: Remote Publish and Link

1. Add a provider-neutral remote storage interface.
2. Implement authenticated upload and download for a development provider.
3. Return immutable snapshot links.
4. Add integrity checks, access state, and explicit failure reporting.

### Phase 4: Recipient Import and Clone

1. Add link resolution and local validation.
2. Show source metadata, scope, limitations, and redaction results.
3. Add a recipient confirmation step.
4. Create a new local session with the imported context and external provenance.
5. Report unsupported capabilities and workspace differences.

### Phase 5: Cross-Host Validation

1. Validate cloning from the first host into a second local agent.
2. Compare exact resume, partial resume, and unsupported cases.
3. Measure manual clarification and setup required by the recipient.
4. Preserve the knowledge-handoff plan as a later extension rather than mixing its requirements into the first MVP.

## 10. Acceptance Criteria

The first end-to-end demo is complete when:

- A can trigger the tool from an active session.
- The tool shows the capture scope before upload.
- A can review and approve a redacted snapshot.
- The remote service returns an immutable, integrity-verifiable link.
- B can open the link from a different local agent or machine.
- B can inspect the transcript, tool history, workspace metadata, and limitations.
- B must explicitly approve cloning before a local session is created.
- The cloned session identifies its source snapshot and external content.
- B uses B's own identity, tools, permissions, and repository state.
- Imported tools and commands are not automatically executed.
- Missing capabilities, omitted data, and changed repositories are reported explicitly.
- A later snapshot revision does not mutate an earlier published snapshot.
- No credential or secret from A is required for B to resume the work.

## 11. Out of Scope for the First MVP

- Cloning a live process, model context window, or in-memory tool connection.
- Automatic synchronization of repositories or complete workspaces.
- Transfer of credentials, access tokens, private keys, or service connections.
- Automatic execution of imported commands or scripts.
- Unrestricted scanning of all local sessions.
- Guaranteed semantic equivalence across every agent host.
- Knowledge-graph construction, model training, or autonomous multi-agent orchestration.
- Automatic merging of two users' concurrent session branches.

## 12. Open Design Questions

- Which host should be implemented first, and what supported API exposes its current session?
- Which remote provider should be used for the MVP?
- Should links be account-bound, team-scoped, expiring bearer links, or a combination?
- Which transcript fields are required for exact resume versus useful handoff?
- Should selected diffs and files be embedded, referenced, or separately approved?
- How should a recipient authenticate when the source and recipient belong to different organizations?
- Which session fields can be translated across hosts without misleading the recipient?
- How should the product expose clone revisions and divergence?
- When should the optional knowledge-extraction workflow run on a snapshot?

## 13. One-Sentence Pitch

> Publish an approved, verifiable snapshot of an active coding-agent session to a remote link, then let another user safely clone and resume that work in their own local agent.

## 14. Installation and Distribution

True `/session share` and `/session resume` behavior requires a local host adapter. The adapter is needed because an MCP server cannot assume access to the host's complete current transcript or know how to create a native session in every agent.

### Customer Installation Model

- Each user installs or enables the AgentContextAcrossPlatform host integration once per supported agent.
- The same integration provides both sharing and resuming for that host.
- Users do not install anything per session or per link.
- Users do not run the remote storage service locally; the host integration connects to the configured remote service.
- The first setup configures the remote endpoint, signs the user in, and grants the host adapter permission to read the current session and create a local clone.

The recommended package is a host extension plus a local MCP/bridge process. The extension registers the customer-facing commands and the bridge handles capture, validation, upload, download, and local session creation.

### No-Install Fallback

A user without a compatible host adapter may be able to view or download a snapshot through the web link, but cannot get true native session resumption. The fallback must be described as a transcript or summary handoff, not as a cloned session.
