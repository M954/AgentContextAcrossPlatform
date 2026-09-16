# AgentContextAcrossPlatform

**Publish a resumable remote clone of an active coding-agent session so another user can continue it in their own local agent.**

> **Status: Hackathon design stage. No working plugin, MCP server, or remote session service has been implemented yet.**
> See the [active project plan](docs/PROJECT_PLAN.md) for the target architecture and MVP.

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

## Documentation

- [Active remote session clone project plan](docs/PROJECT_PLAN.md)
- [Preserved previous knowledge-handoff plan](docs/KNOWLEDGE_HANDOFF_PLAN.md)

The previous project direction focused on extracting reusable knowledge from multiple sessions. It has been renamed and preserved so that work is not lost; knowledge handoff can later be built on top of remote session snapshots.
