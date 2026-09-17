# AgentContextAcrossPlatform

**Publish a resumable remote clone of an active coding-agent session so another user can continue it in their own local agent.**

> **Status: Local prototype implemented. The current service is loopback-only and intended for test data; production authentication, authorization, and remote storage are not implemented yet.**
> See the [active project plan](docs/PROJECT_PLAN.md) for the target architecture and security requirements.

## Target

The source user triggers a tool or MCP operation from inside an agent session. The tool captures an approved snapshot of the current session, removes or flags sensitive content, stores the snapshot remotely, and returns a shareable link.

Another user opens the link in their local agent, reviews the snapshot, checks local capabilities, and explicitly creates a new local session that resumes the work with their own identity, tools, permissions, files, and environment.

```text
Active session
    -> review and publish snapshot
    -> immutable remote version
    -> shareable link
    -> recipient opens and reviews
    -> local clone
    -> resume with recipient's environment
```

The link identifies a versioned snapshot. It does not transfer a live process, credentials, private connections, or unrestricted workspace contents.

## Core Principles

- Publishing, importing, and resuming are separate user-approved actions.
- Snapshots are immutable, integrity-checked, and linked to their source session.
- Credentials, tokens, private keys, and secret environment values are never transferred.
- Imported transcript text and tool calls are untrusted data and are not executed automatically.
- A cloned session uses the recipient's own identity, permissions, tools, and repository state.
- Unsupported host capabilities and missing workspace data are reported explicitly.

## Privacy, Security, and Permissions

This project handles conversation history, tool activity, repository metadata, and potentially sensitive workspace data. Privacy and security are core product requirements.

- Sharing is **default-deny**: nothing is uploaded until the user selects a scope, reviews exclusions and redactions, and confirms publication.
- The default scope contains the current task context and repository metadata. Files, diffs, attachments, environment data, and historical sessions require explicit selection.
- Credentials, tokens, cookies, private keys, `.env` files, credential stores, and secret environment values are blocked or redacted locally before upload.
- High-confidence secrets that cannot be safely redacted must block publication.
- Imported transcript text, tool arguments, paths, and commands are untrusted data. They are never executed automatically.
- The recipient uses their own identity, tools, permissions, and repository. Source connections and credentials are never transferred.
- Production links require authentication and access control. Expiration, revocation, and minimal audit events are required.
- Downloaded copies cannot be revoked, so the UI must state this before sharing.

The initial prototype is loopback-only and stores snapshots locally for testing. It has no production authentication or remote encryption and must not be used to share real secrets or sensitive customer data.

## Copilot CLI Integration

The project can be exposed inside Copilot CLI as a local STDIO MCP server. Start the local snapshot service first:

```powershell
npm start
```

Then register the MCP server from the repository checkout:

```powershell
copilot mcp add agent-context -- node "<absolute-path-to-repository>\src\mcp-server.js"
```

Alternatively, use `/mcp add` inside Copilot CLI and choose **Local/STDIO** with the same command. The server exposes `session_publish`, `session_inspect`, `session_clone`, `session_revoke`, and `session_status`.

The project skill is available at `.github/skills/session-handoff/SKILL.md`. Copilot CLI loads it as a project skill after the repository is trusted. Use `/skills reload` after adding it to an already-running CLI session.

Copilot CLI still requires permission for MCP tools. Prefer narrowly scoped permissions, for example:

```powershell
copilot --allow-tool "agent-context(session_publish)" -p "Prepare a session review and do not publish it."
```

Use separate approvals for `agent-context(session_inspect)` and `agent-context(session_clone)`. Do not use `--allow-all` for this integration; publication and cloning must remain explicit user decisions.

The current MCP integration accepts a normalized snapshot supplied by the host or model; it does not yet read the live Copilot transcript automatically. Native capture is the next host-adapter task. The current clone operation is file-backed and must not be described as native session resumption.

## Proposed MCP Operations

Host-specific command syntax may differ, but the first MCP surface should provide equivalent operations:

| Operation | Purpose |
|---|---|
| `session_publish` | Review and upload the current session snapshot |
| `session_inspect` | Resolve and inspect a remote snapshot |
| `session_clone` | Create a local resumable session |
| `session_revoke` | Revoke access when supported |
| `session_status` | Show versions, integrity, and access state |

## MVP Workflow

1. Capture one supported host's active session.
2. Normalize messages, tool calls, results, attachments, and bounded workspace metadata.
3. Review and redact before upload.
4. Store an immutable snapshot behind an authenticated remote link.
5. Open the link from a second local agent.
6. Validate capabilities and repository differences.
7. Create a new local session with external provenance.
8. Resume only after the recipient confirms the next action.

## Customer Interface

The customer-facing experience should be two actions:

```text
/session share
/session resume <link>
```

The sharer chooses the capture scope, reviews redactions and exclusions, confirms publication, and receives an authenticated link.

The recipient opens or pastes the link, reviews the captured context and limitations, checks local capabilities and repository state, and confirms creation of a new local session. The recipient's agent pauses before running any new tool call.

## Installation Model

For true native sharing and resumption, each user installs or enables one local host adapter per supported agent. The adapter provides the `/session` commands, captures the current session, and creates the local clone.

Users do not install anything per session or per link, and they do not need to run the remote storage service locally. Initial setup configures the remote endpoint and user authentication.

Without a compatible host adapter, the link can still provide a web preview or downloadable transcript, but it cannot create a native resumable session.

## Local Prototype

The repository currently includes a dependency-free local service and fixture adapter. It implements the safe workflow boundary without claiming to be a production remote service:

```powershell
npm test
npm start
```

In another terminal:

```powershell
npm run share -- --input fixtures/sample-session.json
npm run share -- --input fixtures/sample-session.json --approve
npm run inspect -- <returned-link>
npm run resume -- <returned-link> --output .data\clones\sample.json
```

The service binds to `127.0.0.1`, stores snapshots under `.data\`, rejects non-local access modes, validates content hashes, blocks high-confidence bearer tokens and private keys, and never replays imported tools. This prototype has no user authentication, team authorization, production encryption, or native host-session integration.

## Documentation

- [Active remote session clone project plan](docs/PROJECT_PLAN.md)
- [Code plan: implementation modules, readiness checks, and tests](docs/CODE_PLAN.md)
- [Preserved previous knowledge-handoff plan](docs/KNOWLEDGE_HANDOFF_PLAN.md)

The previous project direction focused on extracting reusable knowledge from multiple sessions. It has been renamed and preserved so that work is not lost; knowledge handoff can later be built on top of remote session snapshots.
