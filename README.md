# AgentContextAcrossPlatform

**Share a reviewed session bundle through OneDrive or SharePoint, then import it into another person's local agent environment.**

The implementation uploads one bounded JSON bundle, creates a specific-people read-only link, and downloads it using the recipient's own Microsoft identity. OneDrive supplies storage and sharing permissions; no custom hosted Web App is required for this path.

> **Restore mode: context document, not native session resumption.** Automatic capture of the complete Copilot transcript, native session creation, and recipient environment readiness checks are not implemented. Only authorized normalized input and selected text files are supported. The Graph adapter has synthetic contract coverage; deployment in your tenant requires an approved Entra application, consent, and a live two-user exercise.

## What is implemented

```text
Authorized snapshot + selected text files
    -> local redaction and review
    -> human approval bound to that exact draft/account/destination/recipients
    -> OneDrive upload
    -> specific-people read link
    -> recipient signs in and inspects
    -> separate human approval and access/version recheck
    -> isolated context document + supporting files
```

The provider accepts modern `onedrive.cloud.microsoft` links, `1drv.ms` links, and explicitly configured SharePoint hostnames. It resolves links through Microsoft Graph rather than scraping the sharing webpage. A link to a presentation, spreadsheet, arbitrary JSON, or folder is not a session bundle.

Work/school OneDrive and SharePoint are supported by this implementation. Consumer Microsoft accounts are not: the specific-people link grant API used here does not support delegated personal accounts.

## Privacy, security, and limitations

- **Default-deny writes.** Preparing a share only creates a local sanitized draft. Publication and import require a trusted MCP human-confirmation form or interactive CLI approval. `approval: true`, `--approve`, and `--yes` are not authorization.
- **Exact review scope.** Reviews bind the sanitized bundle, action, account, destination, recipients, configuration and expiration. Changing them requires another review. Ambiguous/failed attempts are not silently retried.
- **Minimal collection.** No home-directory scanning, environment capture, or automatic historical-session collection. At most 20 explicitly selected UTF-8 text files are included. Credential/agent-state locations, traversal paths, symlinks and junctions are blocked.
- **Local secret processing.** Inline secret values are replaced, not retained next to a marker. Known bearer/basic credentials and private-key blocks stop publication. Detection is best effort, not proof that sensitive data is absent. Read the full preview.
- **Own identity.** The recipient signs in independently. MSAL uses OS-protected token persistence; tokens, cookies, and sign-in codes must never be pasted into chat or included in bundles. No plaintext token-cache fallback is allowed.
- **Restricted sharing.** Only specific-people read links are requested, never anonymous or organization-wide links. Existing folder/site permissions remain: choose a private or appropriately restricted destination. A read-only link does not make a broadly accessible library private.
- **Bounded transfers.** Only Microsoft Graph receives Graph tokens. Microsoft-issued upload/download URLs are checked and fetched without the Graph token; arbitrary origins and further redirects are rejected. Payloads, response sizes and timeouts are bounded.
- **Changed-file detection.** Uploads use a fresh digest-bearing filename with conflict behavior `fail`. Import checks the payload and filename digest, and rechecks access/version after review. A hash is not an author signature or tamper-proof storage; authenticated SharePoint remains a trust boundary.
- **No replay.** Imported events and files are historical, untrusted data. Import writes only to an isolated local directory; it does not run queries, scripts, package hooks, source MCP configuration, or patches.
- **Revocation has limits.** Revoking our link does not remove independent/inherited access or downloaded copies. If sharing fails, the provider attempts to remove only its newly created file and reports cleanup failures explicitly.
- **Local boundary.** Drafts/imports live in the current user's state directory. The local OS account, filesystem permissions and trusted MCP client are security boundaries; this plugin does not sandbox other tools or hostile programs running as the same OS user.

## Development setup

Node.js 20+ is required. From this repository:

```powershell
npm ci
npm test
```

The existing Node test runner covers local REST, official MCP STDIO interoperability, synthetic Graph upload/link/download, denied recipients, changed bundles, redaction, and approval boundaries. Synthetic Graph responses are not evidence of a live tenant deployment.

## OneDrive/SharePoint setup

Use an approved public-client Entra app for your work/school tenant. Configure its desktop/mobile loopback redirect for the MSAL interactive flow. Do not configure a client secret.

```powershell
node src\cli.js configure --client-id <app-id> --tenant-id <tenant-id> --sharepoint-host contoso-my.sharepoint.com --sharepoint-host contoso.sharepoint.com
node src\cli.js login
```

Run login in your own interactive terminal. The Microsoft browser sign-in flow and your organization's Conditional Access policies apply.

By default, the upload target is your OneDrive root. For a restricted SharePoint library or another approved folder:

```powershell
node src\cli.js configure --drive-id <drive-id> --folder-id <folder-id>
```

The default delegated Graph scope is `Files.ReadWrite`, required by the documented sharing-link resolution/grant APIs. It is **not read-only app access**. Tenant approval may be required. If your organization requires Selected permissions, configure the approved scopes with repeated `--scope` options and verify the chosen endpoints/resource grants; this tool never silently requests broader permissions.

Public configuration and OS-encrypted authentication state live under the user-specific `.agent-context` directory. `AGENT_CONTEXT_HOME` can select a private alternative. Do not use a shared or repository-synchronized directory. Use `node src\cli.js logout` to clear this integration's sign-in state.

On Windows, Windows PowerShell is required for owner/ACL checks; newly created state directories are restricted to the current user, SYSTEM and Administrators. Existing broadly accessible state is rejected, not silently repaired. On other platforms the native secure store must be available and unlocked. Logout does not revoke existing file-sharing permissions.

## Share from the CLI

The input must be an authorized normalized snapshot matching `fixtures\sample-session.json`. It is not a native Copilot export parser.

```powershell
node src\cli.js share --input fixtures\sample-session.json --to teammate@contoso.com
```

Optionally add specific supporting text files, relative to your current workspace:

```powershell
node src\cli.js share --input <snapshot.json> --to teammate@contoso.com --file queries\example.sql
```

This returns a `reviewId`, digest and local `previewPath`, without uploading. Inspect the preview, then run:

```powershell
node src\cli.js share --review <review-id>
```

The CLI shows the plan and requires typed confirmation. It then returns the actual Microsoft-generated link, bundle digest, and publication ID. Tokens and temporary transfer URLs are not returned.

## Recipient import

The recipient configures/signs in to the integration independently, then:

```powershell
node src\cli.js inspect "<OneDrive-or-SharePoint-link>"
node src\cli.js resume --review <returned-review-id>
```

Inspect creates a local review, not a session. After confirmation, resume produces:

```text
<private-state-directory>
  imports
    <clone-id>
      context.md
      session.agent-session.json
      files
        <selected supporting files>
```

The result reports `restoreMode: "context_document"` and `readiness: "needs_adaptation"`. The user may explicitly attach `context.md` to a new agent chat and decide the next local step. This does not restore the source agent's hidden state, tools, permissions, repository or live connections.

The publisher may revoke a link using the saved publication ID, with another confirmation:

```powershell
node src\cli.js revoke <snapshot-id>
```

## Copilot CLI integration

The repository now includes an Agent Plugins 1.0 manifest, MCP configuration, and the `session-handoff` skill.

For a local checkout with dependencies installed, register the MCP server:

```powershell
copilot mcp add agent-context -- node "<checkout>\src\mcp-server.js"
```

Or install the packaged plugin through Copilot:

```text
/plugin install M954/AgentContextAcrossPlatform
```

**One-time dependency setup is still required after a GitHub plugin install:** run `npm ci` in the installed plugin root with user approval, then reload/restart the integration. Plugin installation does not automatically execute dependency-install scripts. The skill includes setup instructions. Users need Node.js, but do not need to run a local web server for OneDrive sharing.

In chat, ask to use the `session-handoff` skill:

```text
Prepare a OneDrive share of this authorized snapshot for <recipient>.
Inspect the session bundle at <sharing-link>.
Import the reviewed bundle as local context.
```

Tools: `session_prepare_publish`, `session_publish`, `session_inspect`, `session_clone`, `session_revoke`, `session_status`.

The MCP server asks the human directly for approval using elicitation. If the client lacks a supported confirmation form, publication/import is blocked and the user must use the interactive CLI. Do not use `--allow-all` to work around permissions. No custom `/session share` or `/session resume` slash commands are registered.

## Local-only transport test

The loopback service remains a synthetic test provider, not the intended production storage:

```powershell
npm start
```

In another terminal:

```powershell
node src\cli.js share --provider local --input fixtures\sample-session.json
node src\cli.js share --review <review-id>
node src\cli.js inspect "<returned-local-link>"
node src\cli.js resume --review <review-id>
```

It has no user authentication; keep it on loopback and use synthetic data only. Do not deploy this local server as an internet-facing service.

## Design and API references

- [Active project plan](docs/PROJECT_PLAN.md)
- [Code plan and recipient-readiness milestones](docs/CODE_PLAN.md)
- [Preserved knowledge-handoff plan](docs/KNOWLEDGE_HANDOFF_PLAN.md)
- [Graph upload sessions](https://learn.microsoft.com/en-us/graph/api/driveitem-createuploadsession?view=graph-rest-1.0)
- [Create sharing links](https://learn.microsoft.com/en-us/graph/api/driveitem-createlink?view=graph-rest-1.0)
- [Grant named users link access](https://learn.microsoft.com/en-us/graph/api/permission-grant?view=graph-rest-1.0)
- [Resolve shared items](https://learn.microsoft.com/en-us/graph/api/shares-get?view=graph-rest-1.0)
- [Download file content](https://learn.microsoft.com/en-us/graph/api/driveitem-get-content?view=graph-rest-1.0)
