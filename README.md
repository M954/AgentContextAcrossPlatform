# AgentContextAcrossPlatform

**Share a reviewed session bundle through OneDrive or SharePoint, then import it into another person's local agent environment.**

The implementation uploads one bounded JSON bundle, creates a specific-people read-only link, and downloads it using the recipient's own Microsoft identity. OneDrive supplies storage and sharing permissions; no custom hosted Web App is required for this path.

> **Default restore mode: context document.** Explicitly reviewed native pi/Copilot creation and live pi branch capture are also available. Native sessions contain external reference context, not a reconstructed source environment. Passive readiness checks are advisory. The Graph adapter has synthetic contract coverage; deployment in your tenant still requires an approved Entra application, consent, and a live two-user exercise. See [pi/native integration](docs/PI.md).

For the full sharer/recipient journey, Copilot chat experience, failure handling, and prioritized unfinished work, see [Current workflow, user experience, and remaining gaps](docs/WORKFLOW_AND_GAPS.md).

## What is implemented

```text
Authorized snapshot, selected export, or live pi branch + selected text files
    -> local redaction and review
    -> human approval bound to that exact draft/account/destination/recipients
    -> OneDrive upload
    -> specific-people read link
    -> recipient signs in and inspects
    -> choose document/pi/Copilot target and recipient workspace
    -> exact import review + human approval + access/version/destination recheck
    -> isolated context document + files + optional native session
```

The provider accepts modern `onedrive.cloud.microsoft` links, `1drv.ms` links, and explicitly configured SharePoint hostnames. It resolves links through Microsoft Graph rather than scraping the sharing webpage. A presentation, spreadsheet, arbitrary JSON file, or folder is not a session bundle.

Work/school OneDrive and SharePoint are supported by this implementation. Consumer Microsoft accounts are not: the specific-people link grant API used here does not support delegated personal accounts.

## Privacy, security, and limitations

- **Default-deny writes.** Preparing a share only creates a local sanitized draft. Publication and import require a trusted MCP human-confirmation form or interactive CLI approval. `approval: true`, `--approve`, and `--yes` are not authorization.
- **Exact review scope.** Reviews bind the sanitized bundle, action, account, destination, recipients, configuration and expiration. Native import additionally binds its target, recipient workspace, output directory and host configuration. Changing them requires another review. Ambiguous/failed attempts are not silently retried.
- **Minimal collection.** No home-directory scanning, environment capture, or automatic historical-session collection. The pi extension captures only its approved active branch; selected export files are normalized without following attachments. At most 20 supporting text files/attachments are included. Credential/agent-state locations are blocked for supporting-file collection; explicitly selected conversation histories use dedicated parsers.
- **Local secret processing.** Supported inline secrets are replaced, including quoted/escaped values. Incomplete quoted credentials, known bearer/basic credentials and private-key blocks stop publication. Detection is best effort, not proof that sensitive data is absent. Read the full preview.
- **Own identity.** The recipient signs in independently. MSAL uses OS-protected token persistence; tokens, cookies, and sign-in codes must never be pasted into chat or included in bundles. No plaintext token-cache fallback is allowed.
- **Restricted sharing.** Only specific-people read links are requested, never anonymous or organization-wide links. Existing folder/site permissions remain: choose a private or restricted destination. A read-only link does not make a broadly accessible library private.
- **Bounded transfers.** Only Microsoft Graph receives Graph tokens. Microsoft-issued upload/download URLs are checked and fetched without the Graph token; arbitrary origins and further redirects are rejected. Payloads, response sizes and timeouts are bounded.
- **Changed-file detection.** Uploads use a fresh digest-bearing filename with conflict behavior `fail`. Import checks the payload and filename digest, then rechecks access/version after review. A hash is not an author signature or tamper-proof storage; authenticated SharePoint remains a trust boundary.
- **No replay or overwrite.** Imported events and files are historical, untrusted data. Import writes exclusively to an isolated directory; it does not run source queries, scripts, package hooks, MCP configuration or patches, and never overwrites existing files.
- **Revocation has limits.** Revoking our link does not remove independent/inherited access or downloaded copies. If sharing fails, the provider attempts to remove only its newly created file and reports cleanup failures explicitly.
- **Local boundary.** Drafts/imports live in the current user's state directory. The OS account, filesystem permissions and trusted MCP client are security boundaries; this plugin does not sandbox other tools or hostile programs running as the same user.

## Development setup

Node.js 20+ is required:

```powershell
npm ci
npm test
```

The Node test runner covers local REST, official MCP STDIO interoperability, synthetic Graph upload/link/download, denied recipients, changed bundles, redaction and approval boundaries. Synthetic Graph responses are not evidence of a live tenant deployment.

## OneDrive/SharePoint setup

Use an approved public-client Entra app for your work/school tenant. Configure its desktop/mobile localhost redirect for the MSAL interactive flow. Do not configure a client secret.

```powershell
node src\cli.js configure --client-id <app-id> --tenant-id <tenant-id> --sharepoint-host contoso-my.sharepoint.com --sharepoint-host contoso.sharepoint.com
node src\cli.js login
```

Run login in your own interactive terminal. Microsoft browser sign-in and your organization's Conditional Access policies apply.

By default, the upload target is your OneDrive root. For another approved folder or restricted SharePoint library:

```powershell
node src\cli.js configure --drive-id <drive-id> --folder-id <folder-id>
```

The default delegated Graph scope is `Files.ReadWrite`, required by the documented sharing-link resolution/grant APIs. It is **not read-only app access**. Tenant approval may be required. If your organization requires Selected permissions, configure approved scopes with repeated `--scope` options and verify endpoint/resource grants; the tool never silently requests broader permissions.

Public configuration and OS-encrypted authentication state live under the user-specific `.agent-context` directory. `AGENT_CONTEXT_HOME` selects a private alternative. Do not use a shared or repository-synchronized directory. `node src\cli.js logout` clears this integration's sign-in state, not existing sharing permissions.

On Windows, Windows PowerShell is required for owner/ACL checks; new state directories are restricted to the current user, SYSTEM and Administrators. Existing broadly accessible state is rejected, not silently repaired. On other platforms the native secure store must be available and unlocked.

## Share from the CLI

`--input` accepts an authorized normalized snapshot or a selected export. Format detection supports pi v2/v3 JSONL, Copilot event/semantic JSONL, chat-message JSON and Markdown/text. No source-agent argument is required. The current pi branch can also be shared directly through the [pi extension](docs/PI.md). File capture is bounded, excludes private state, and does not scan other sessions.

```powershell
node src\cli.js share --input fixtures\sample-session.json --to teammate@contoso.com
```

Optionally add selected supporting text files relative to your current workspace:

```powershell
node src\cli.js share --input <snapshot.json> --to teammate@contoso.com --file queries\example.sql
```

This returns a `reviewId`, digest and local `previewPath`, without uploading. Inspect the complete preview, then:

```powershell
node src\cli.js share --review <review-id>
```

The CLI displays the plan and requires typed confirmation. It returns the actual Microsoft-generated link, bundle digest, and publication ID only after sharing succeeds. Tokens and temporary transfer URLs are not returned.

## Recipient import

The recipient configures/signs in independently, then:

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

Results report `status: "context_imported"`, `restoreMode: "context_document"`, `executionReadiness: "not_assessed"` and a `needs_adaptation` readiness explanation. The user may explicitly attach `context.md` to a new agent chat and choose a local next step. The source agent's hidden state, tools, permissions, repository and live connections are not restored.

### Native pi or Copilot destination

Choose the target and workspace when inspecting, not after approval:

```powershell
node src\cli.js inspect "<sharing-link>" --target pi --workspace C:\my-project
# Or use --target copilot
node src\cli.js assess --review <import-review-id>
node src\cli.js resume --review <import-review-id>
```

The import form shows the selected target, workspace and private output location. Changing them requires another inspect/review; `resume --review` accepts no target/workspace overrides. After consent, access/version and destination checks run before any native host invocation.

A successful native import reports `native_session_created`, a local session ID, and a resume command. It performs no model turn or source tool replay. Pi writes an external custom-context message; Copilot imports a semantic text-context message through its official importer. Both remain execution-unassessed. Copilot uses the private home shown in `resumeCommand.env.COPILOT_HOME`; sign in there with your own model account if needed.

The publisher can revoke a link by saved publication ID, with another confirmation:

```powershell
node src\cli.js revoke <snapshot-id>
```

## Copilot CLI integration

The repository includes an Agent Plugins 1.0 manifest, MCP configuration and the `session-handoff` skill.

For a checkout with dependencies installed:

```powershell
copilot mcp add agent-context -- node "<checkout>\src\mcp-server.js"
```

Or install the packaged plugin inside Copilot:

```text
/plugin install M954/AgentContextAcrossPlatform
```

**One-time dependency setup is still required after a GitHub plugin install:** run `npm ci` in the installed plugin root with user approval, then reload/restart the integration. Plugin installation does not automatically execute dependency-install scripts. The skill includes setup instructions. Users need Node.js but no local web server for OneDrive sharing.

In chat, ask to use the `session-handoff` skill:

```text
Prepare a OneDrive share of this authorized snapshot for <recipient>.
Inspect the session bundle at <sharing-link>.
Import the reviewed bundle as local context.
```

Tools: `session_prepare_publish`, `session_publish`, `session_inspect`, `session_assess`, `session_capabilities`, `session_clone`, `session_revoke`, `session_status`.

`session_prepare_publish` accepts exactly one `snapshot` or user-selected `sourceFile`. `session_inspect` optionally accepts `target` and absolute `workspaceRoot`. `session_clone` still accepts only the reviewed ID—never an approval boolean or target override.

The server asks the human directly through MCP elicitation. Without a supported confirmation form, publication/import is blocked and the user must use the interactive CLI. Do not use `--allow-all` to work around permissions. No custom `/session share` or `/session resume` commands are registered.

**Migration from the earlier prototype:** boolean approval arguments and the CLI `--approve`/`--output` import path are no longer accepted. Prepare/inspect first, then use the review ID. This replaces the earlier boolean guard with content-bound human approval, while preserving no-overwrite behavior and truthful document/native reporting.

## Pi extension and cross-agent validation

After dependency setup, load the reviewed extension or install this checkout as a pi package:

```powershell
pi -e <checkout>\extensions\pi-session.ts
# Or: pi install <checkout>
```

Inside pi, use `/ac-share teammate@contoso.com` and `/ac-resume <sharing-link>`. These commands use the same persisted review IDs, Microsoft identity, human UI confirmation, and access/version rechecks as CLI/MCP. They do not override pi's built-in commands. See [pi setup and native import boundaries](docs/PI.md).

```powershell
npm run demo -- --source pi --target copilot
npm run demo -- --source copilot --target pi
```

Demos use synthetic Graph transport and synthetic approval callbacks with the real installed destination host. They do not sign in to a tenant, automate the production CLI confirmation phrase, call a model, or complete the sample coding task. Reports explicitly distinguish simulated transport from real native creation.

## Local-only transport test

The loopback service remains a synthetic test provider, not production storage:

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

It has no user authentication; keep it on loopback with synthetic data. Do not deploy this test server as an internet-facing service.

## Design and API references

- [Current workflow, user experience, and remaining gaps](docs/WORKFLOW_AND_GAPS.md)
- [Pi/Copilot native integration with reviewed OneDrive sharing](docs/PI.md)
- [Passive readiness for import reviews](docs/READINESS.md)
- [Active project plan](docs/PROJECT_PLAN.md)
- [Code plan and recipient-readiness milestones](docs/CODE_PLAN.md)
- [Preserved knowledge-handoff plan](docs/KNOWLEDGE_HANDOFF_PLAN.md)
- [Graph upload sessions](https://learn.microsoft.com/en-us/graph/api/driveitem-createuploadsession?view=graph-rest-1.0)
- [Create sharing links](https://learn.microsoft.com/en-us/graph/api/driveitem-createlink?view=graph-rest-1.0)
- [Grant named users link access](https://learn.microsoft.com/en-us/graph/api/permission-grant?view=graph-rest-1.0)
- [Resolve shared items](https://learn.microsoft.com/en-us/graph/api/shares-get?view=graph-rest-1.0)
- [Download file content](https://learn.microsoft.com/en-us/graph/api/driveitem-get-content?view=graph-rest-1.0)
