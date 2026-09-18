# Pi and Copilot Integration with Reviewed OneDrive Handoff

The native adapters run **inside the existing OneDrive/SharePoint review workflow**. They do not introduce another sharing server, a platform token system, or boolean approval shortcuts.

Validated locally with pi 0.85.1 and Copilot CLI 1.0.84-5. The Microsoft Graph transfer tests use synthetic fixtures; a live tenant round trip still requires an approved application, consent, and tester accounts.

## One Approval Pipeline

```text
Selected export or current pi branch
  -> normalize and redact
  -> prepare publish review
  -> human confirmation of exact draft/account/destination/recipients
  -> OneDrive/SharePoint upload and named-recipient link
  -> recipient inspect with chosen target and workspace
  -> import review binds bundle, identity, version, host and workspace
  -> human confirmation
  -> remote access/version and local destination rechecks
  -> isolated context files + optional native session
```

`session_clone` and CLI `resume --review` take a review ID, not an approval boolean or a replacement target. Changing the target, workspace, account, configuration, or relevant host binding requires a fresh review. A cancelled or failed attempt never grants execution permission.

## CLI: Choose the Target During Inspect

Configure and sign in using the [OneDrive setup](../README.md#onedrivesharepoint-setup). Then:

```powershell
# Source format is detected; no source-agent argument is needed.
node src/cli.js share --input <conversation-export> --to teammate@contoso.com
node src/cli.js share --review <publish-review-id>

# Recipient chooses pi or copilot BEFORE approving the import:
node src/cli.js inspect "<sharing-link>" --target pi --workspace C:\my-project
node src/cli.js resume --review <import-review-id>
```

For Copilot use `--target copilot`. Omit `--target` for the default context-document path. Adding `--target`, `--workspace`, or an output override to `resume --review` is rejected rather than silently changing a reviewed action.

```powershell
node src/cli.js doctor
node src/cli.js assess --review <import-review-id>
```

Capability probing is a separate explicit command. Inspect itself does not launch a host. Passive assessment is advisory and uses only the workspace already bound to the review; it cannot authorize import or execution.

## Pi Extension

After `npm ci`, load the reviewed extension for one run:

```powershell
pi -e C:\path\to\AgentContextAcrossPlatform\extensions\pi-session.ts
```

Or install the local pi package with `pi install C:\path\to\AgentContextAcrossPlatform`. The package manifest loads only `pi-session.ts`, not the internal offline worker. Installing a package runs trusted local extension code; review it first.

Configure/sign in from your own terminal using the same `AGENT_CONTEXT_HOME` as the extension. It uses the existing MSAL/OS-protected identity and never asks you to paste tokens or sign-in codes into chat.

### Share the Current Branch

```text
/ac-share teammate@contoso.com
```

With no arguments, the extension asks for explicit recipient emails. It:

1. Requires an idle session and a trusted interactive/RPC UI.
2. Asks to capture the active branch through the current SessionManager.
3. Excludes other branches, thinking blocks, private `!!` output, hidden extension state, and source model configuration.
4. Lets the user remove content before preparation; new redactions require another preview.
5. Prepares the same persisted publish review used by CLI/MCP.
6. Shows the exact draft and requires confirmation through pi's UI.
7. Checks that the source session/leaf did not change during review, then calls `HandoffWorkflow.complete`.

`/ac-share --local` is available only for synthetic loopback testing and cannot grant named-recipient access. OneDrive is the normal path.

### Import and Switch

```text
/ac-resume <sharing-link>
```

The extension prepares an import review with `target: pi` and the current recipient workspace. After the user reviews and confirms it, the workflow rechecks remote access/version and the destination, creates a persisted pi session, and returns a receipt. Only then does the extension use `ctx.switchSession()`.

It uses the replacement context for post-switch UI, leaves the editor empty, and does not start a model turn. If switching is cancelled by another extension, the created session remains available and its path is reported. Built-in pi commands are not overridden.

## Capture Compatibility

Supported selected inputs include normalized snapshots, pi v2/v3 JSONL, Copilot event/semantic JSONL, chat-message JSON, and Markdown/text exports. The upstream bounded JSON and per-text limits still apply; no schema or secret checks are relaxed for native input.

Capture metadata lives under `source.capture`; omission descriptions also appear in `omitted`. Missing source timestamps use an epoch placeholder explicitly marked `timestampBasis: unavailable`, not an invented observed time.

For pi files, the default branch ends at the last appended entry. A file does not establish a different live in-memory selection. Use the live extension or explicitly choose a leaf:

```powershell
node src/cli.js share --input <pi-session.jsonl> --leaf <entry-id> --to teammate@contoso.com
```

No automatic whole-machine history scan or full live Copilot capture is implemented. Long/unsupported records fail explicitly; select a smaller authorized export instead of silently dropping content.

## Native Destination Boundaries

Every new import review records:

- `document`, `pi`, or `copilot` target.
- Canonical recipient workspace and directory identity, when selected.
- Isolated output directory under private application state.
- Native executable/configuration fingerprint and adapter code fingerprint.
- External-reference representation and unassessed execution state.

These are rechecked after human approval and immediately before host invocation. The checks detect normal configuration/directory changes; they are not an OS sandbox against hostile programs running as the same user.

### Pi

The worker uses public SessionManager APIs in an isolated offline process with extensions, tools, context discovery, and startup networking disabled except for the trusted import worker. It creates one visible custom message containing historical reference data.

Pi 0.85.1 defers normal persistence until an assistant turn. The adapter therefore builds a private seed through `SessionManager.inMemory()`, then uses `SessionManager.forkFrom()` and reopens the saved file to verify persistence. It does not fabricate an assistant response or call private flush APIs. The temporary parent seed is removed; durable source provenance is in the custom message.

The new session is saved inside the reviewed import directory. Open it using the returned command:

```powershell
pi --session "<sessionFile>"
```

### Copilot

The adapter validates a generated semantic transcript with the official `sessions import --dry-run`, then imports it offline. Historical records are quoted in one user-context message, never pending tools or source system instructions.

Copilot uses a new private home under the reviewed import directory, not an unreviewed ambient `COPILOT_HOME`. The result's `resumeCommand.env.COPILOT_HOME` identifies that home. Set it before opening the returned session; sign in with your own model account if needed. No Graph or source credentials are copied into it.

Both targets report `native_session_created` and `executionReadiness: not_assessed`. No model turn, historical tool, repository patch, or automatic environment repair is performed.

## Failure and Recovery

- Cancellation leaves no native session.
- Remote revocation/version change blocks an uncompleted import before the host is called.
- Changed target/workspace/host configuration requires a new review.
- Successful review replay returns the saved receipt instead of creating another session.
- An ambiguous failed native attempt retains the claim. Its error includes recovery paths; inspect the host before preparing a new review.
- Local staging data and imported files use private directories, including Windows ACL protection. The OS account remains a trust boundary.

## Tests and Demos

```powershell
npm test
npm run demo -- --source pi --target copilot
npm run demo -- --source copilot --target pi

$env:AGENT_CONTEXT_TEST_PI = "1"
node --test test/pi-integration.test.js
Remove-Item Env:AGENT_CONTEXT_TEST_PI
```

Demos use a synthetic Graph transport and explicit synthetic approval callbacks, but native targets use the actual installed host. They never authenticate to a live tenant or automate the production CLI confirmation phrase. Reports distinguish those facts and do not claim the example coding task was completed.

The opt-in pi tests exercise the real extension UI protocol, cancellation, reviewed publication, persistent creation, runtime replacement, and sharing after replacement. Test configuration and sessions are isolated from the user's existing pi history.
