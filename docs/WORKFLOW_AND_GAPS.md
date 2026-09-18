# Current Workflow, User Experience, and Remaining Gaps

> Documentation snapshot: 2026-09-18, implementation reference `3cb7bd7` (v0.2.0).
> This describes the current implementation, not the complete product promised by the project plan.

**Today: a reviewed file-based context handoff through OneDrive/SharePoint.**
**Target: share directly from a live agent session and let another person continue in a supported local agent.**

The current `resume`/`session_clone` operations produce a context document and supporting files. They do not create or switch to a native Copilot session.

## 1. Current end-to-end workflow

```text
Sharer A                                      Recipient B
--------                                      -----------
Prepare authorized snapshot JSON
Select required text files
Choose named recipients
        |
Redact and prepare local review
        |
Inspect full preview
Explicitly approve this draft
        |
Upload bundle to OneDrive/SharePoint
Create specific-people read link
        |
Copy and send link --------------------------> Supply link to the integration
                                              Sign in using B's account
                                              Download and validate bundle
                                              Inspect local review
                                              Explicitly approve import
                                              Recheck access and file version
                                                      |
                                              Write isolated context.md + files
                                                      |
                                              Manually open a new agent chat,
                                              attach approved context, and
                                              decide the next local action
```

OneDrive/SharePoint hosts the bundle and enforces file access. The local integration performs preparation, review, transfer and import. **Neither user needs to run a custom Web App or local HTTP service for the OneDrive path.** The loopback HTTP provider is only a synthetic development test path.

A publication is a point-in-time bundle, not remote control of A's agent. A's later work does not automatically update B's copy. Sharing a later state creates another publication.

## 2. One-time setup and who does it

| Who | Required setup | What this does not establish |
|---|---|---|
| App/site administrator | Approve a public-client Entra application, delegated Graph scopes and any required consent/resource grants; provide an appropriate OneDrive/SharePoint destination | App consent alone does not give every user access to every file |
| Each user | Install Node.js 20+, the integration and its pinned dependencies | Installing an MCP server does not give it the complete current agent transcript |
| Each user | Configure the approved app/tenant IDs and exact trusted SharePoint hostnames; sign in interactively with their own work/school account | A successful login does not prove permission to publish or read a particular bundle |
| Sharer | Select a private or suitably restricted destination and intended recipient addresses | A specific-people link does not remove broader permissions inherited from that destination |

Consumer Microsoft accounts are not supported by the current specific-people link grant implementation.

### Installation choices

For a checkout, run `npm ci` in the repository, then register the MCP process:

```powershell
copilot mcp add agent-context -- node "<checkout>\src\mcp-server.js"
```

Alternatively, install the plugin inside Copilot:

```text
/plugin install M954/AgentContextAcrossPlatform
```

**The plugin command downloads/registers the package; it is not yet complete zero-touch onboarding.** Run `npm ci` once in the installed plugin root with user approval, then reload/restart the integration. The plugin includes the `session-handoff` skill. A manual checkout exposes the project skill when working in that repository.

Choose one registration route rather than configuring duplicate copies of the same server. There is no installation per session or per sharing link.

### Microsoft sign-in

The commands below run from the checkout or installed plugin root. Replace placeholders with approved values and use the actual hostnames for your tenant:

```powershell
node src\cli.js configure --client-id <app-id> --tenant-id <tenant-id> --sharepoint-host contoso-my.sharepoint.com --sharepoint-host contoso.sharepoint.com
node src\cli.js login
```

Login opens Microsoft's browser sign-in flow and must run in the user's own interactive terminal. Do not send credentials, sign-in codes, cookies or access tokens through chat. No client secret is used.

The default delegated scope is `Files.ReadWrite`, not a read-only application scope. This reflects the documented Graph sharing-link APIs. Tenant approval may be required. Approved alternative scopes and their resource grants need validation against the actual endpoints; do not broaden permissions to work around a failure.

The default upload destination is the signed-in user's OneDrive root. An approved alternative is configured with:

```powershell
node src\cli.js configure --drive-id <drive-id> --folder-id <folder-id>
```

## 3. Sharer experience

### Step A1: Prepare the input

Supply an authorized normalized snapshot shaped like [the synthetic example](../fixtures/sample-session.json). It contains source metadata, task context, events, workspace metadata and proposed next steps. These records are supplied input, not independently verified repository or execution facts.

**There is no automatic full-session exporter yet.** If the input is a summary of visible chat rather than an exact export, label that limitation and record omissions. Do not invent tool results or claim that hidden or truncated history was captured.

### Step A2: Select files and recipients

```powershell
node src\cli.js share --input <snapshot.json> --to teammate@contoso.com --file queries\example.sql
```

`--file` is optional and repeatable; paths are relative to the current working directory. Repeat `--to` for multiple named recipients. The current bounds include 20 selected text files/attachments, 5,000 events, 128 KiB per text value, and a 2 MiB normalized snapshot. Unsupported binary files and oversized input are rejected, not silently included or truncated.

This operation redacts locally, reads the configured destination metadata through Graph, and writes a private review draft. **It does not upload the bundle or grant recipients access.** The user receives:

| Field | Meaning |
|---|---|
| `status: review-required` | Publication has not happened |
| `reviewId`, `reviewDigest`, `expiresAt` | The exact draft to approve, valid for 15 minutes |
| `previewPath` | Local file containing the complete sanitized plan and bundle |
| `summary`, `destination`, `recipients` | Captured scope, redaction count, omissions and intended sharing audience |

Review the entire preview, not just the redaction count. Pattern-based secret detection cannot establish that all sensitive information has been removed.

### Step A3: Approve and publish

```powershell
node src\cli.js share --review <review-id>
```

The CLI shows the plan and requires the user to type the exact confirmation phrase it displays. Pressing Enter without that phrase cancels. Noninteractive calls cannot bypass approval.

Approval is bound to the draft content, action, account, configuration, destination and recipient list. To change the input or audience, prepare and approve another draft.

After upload and recipient grants succeed, the result includes `status: published`, the Microsoft-generated `link`, `snapshotId` and `bundleDigest`. Copy and send the link yourself; automatic Teams/email delivery is not implemented.

The generated file has a digest-bearing `.agent-session.json` name. Do not edit or rename it and expect the existing publication to remain valid. A normal OneDrive/SharePoint link is supported only when it resolves to an exported session bundle, not an arbitrary document or folder.

## 4. Recipient experience

### Step B1: Inspect the link

After their own setup and sign-in, B runs:

```powershell
node src\cli.js inspect "<OneDrive-or-SharePoint-link>"
```

Supported inputs include `onedrive.cloud.microsoft`, `1drv.ms` and explicitly configured SharePoint hosts. Graph resolves the link using B's identity; the integration does not reuse A's credentials or scrape the sharing webpage.

Inspection downloads and validates the bundle, then writes a local review. The response is `status: inspectable`, with a **new recipient-side** `reviewId`, `previewPath`, digest and scope summary. No native agent session or workspace change is created.

Possessing a link is not sufficient authorization. Expired/revoked access, untrusted hosts, unsupported file formats and invalid digests must stop the operation.

### Step B2: Approve the import

```powershell
node src\cli.js resume --review <recipient-review-id>
```

The user reviews and confirms the exact import. Before writing, the integration rechecks remote access, content and version rather than relying only on a cached download. A new import is written to a separate directory:

```text
<private-state-directory>
  imports
    <clone-id>
      context.md
      session.agent-session.json
      files
        <selected supporting files>
```

Existing files are not overwritten. Selected files are not copied into B's working repository; supplied text attachments remain in the bundle/context.

An abbreviated result is:

```json
{
  "status": "context_imported",
  "restoreMode": "context_document",
  "executionReadiness": "not_assessed",
  "readiness": {
    "status": "needs_adaptation"
  },
  "safety": {
    "nativeSessionCreated": false,
    "toolsReplayed": false,
    "repositoryModified": false
  }
}
```

### Step B3: Continue manually

B explicitly opens a new agent chat and attaches the returned `context.md` as untrusted background. The agent and user must assess the local repository, tool availability, permissions, data access and proposed next step before acting.

Imported source instructions are historical data, not local system/developer instructions. Commands, queries, scripts, patches, package hooks and MCP configurations are not automatically replayed. A tool name or a `requiredCapabilities` entry does not prove that B can run the same investigation.

**Successful import is not native session restoration, environment restoration, or successful continuation of the original task.**

## 5. Experience inside Copilot chat

Use the `session-handoff` skill and ordinary chat requests after registration. These are current workflow entry points, not promises of automatic capture:

| User request | Internal operation | What the user sees |
|---|---|---|
| "Prepare a OneDrive share of this authorized snapshot for this recipient." | `session_prepare_publish` | Draft summary, destination, recipients, omissions and preview path; no upload |
| "Publish the reviewed draft." | `session_publish` with `reviewId` | A separate human approval form, then a link on success |
| "Inspect the session bundle at this link." | `session_inspect` | Recipient-side preview and context-only limitations; no execution |
| "Import the reviewed bundle." | `session_clone` with `reviewId` | Another approval form, followed by isolated context/files paths |
| "Revoke this publication." | `session_revoke` with the owned `snapshotId` | Confirmation and link revocation result |
| "Show integration status." | `session_status` | Configuration presence and supported restore mode, not a live access/readiness assessment |

There are two permission boundaries: Copilot's permission to invoke a tool and the integration's approval of the exact publish/import action. Neither replaces the other. A chat statement alone or a model-supplied `approval: true` cannot authorize the write.

If the host supports MCP elicitation, it displays the human confirmation form. Otherwise the action is blocked and the user must run the corresponding `--review` command in their own terminal, with the same private state directory/account/configuration. Do not automate typing the approval phrase.

**No custom `/session share` or `/session resume` commands are registered.** Copilot's built-in session commands are not this project's bundle importer. The old `--approve`, `--yes` and arbitrary `--output` import paths are not supported.

## 6. Failure, revocation, and data lifecycle

| Situation | Current behavior and user action |
|---|---|
| No approved app configuration, sign-in or consent | Configure approved public IDs/scopes and sign in interactively. Do not paste tokens into chat |
| Secure token storage unavailable or local state permissions unsafe | Stop and correct the local storage/permission problem. There is no plaintext-token fallback |
| Secret detection blocks input | Remove or replace the sensitive content locally and prepare a new draft |
| Review expires after 15 minutes, or account/configuration changes | Prepare/inspect again and obtain fresh approval |
| Remote access, content or version changes before import | Refuse the new import; resolve access or inspect the newly published version |
| Sharing fails after upload | Attempt cleanup of the newly created item. If cleanup cannot be confirmed, inspect the provider destination before retrying |
| An attempt is already claimed or its outcome is ambiguous | Do not blindly repeat the write. Inspect the existing result/provider state before preparing another attempt |
| A completed review is reused while still valid | Return the saved result rather than duplicate the upload/import; this is not a new permission check or download |
| User logs out | Clear this integration's sign-in state; existing publications and imported context remain |

The original publisher can revoke a saved publication through `node src\cli.js revoke <snapshot-id>` using the same publishing account/configuration. Keep the local publication receipt; if it is unavailable, manage access in OneDrive/SharePoint.

**Revocation removes our sharing link, not independent/inherited permissions or downloaded copies.** The current publisher does not request an application-configured link expiration. Provider policies may apply. Review expiration is a separate local approval limit, not a remote-link lifetime or a data-deletion policy.

Local reviews, receipts, bundles and context documents persist in the private state directory. Token storage is OS-protected; the other artifacts are JSON/Markdown/text protected by filesystem permissions, not application-level encrypted packages. Automatic retention cleanup and a deletion/history UI are not implemented. The trusted local OS account and MCP host remain security boundaries.

## 7. Evidence and remaining gaps

The current evidence includes local REST and CLI behavior, MCP protocol tests with simulated approval responses, synthetic Graph sender/recipient/denied-user cases, and Windows native encryption of a synthetic cache value. Copilot discovered the plugin and called its status tool.

These do **not** demonstrate a live Microsoft tenant round trip, successful human interaction with every Copilot confirmation UI, full native conversation capture, or actual continuation of an investigation. A hand-written/sanitized fixture is not a native-session round trip.

### Remaining gaps

| Priority | Gap and user impact | Next work / completion gate | Dependency |
|---|---|---|---|
| P0 | Live OneDrive/SharePoint acceptance is unverified | A publishes a synthetic bundle, B downloads with B's account, and C without independent/inherited access is denied; exercise changed/revoked content and the real UI | Approved Entra app/consent, restricted test destination, and tester accounts |
| P0 | No automatic current-session capture | Demonstrate an authorized, bounded host export path preserving available messages/tool records and explicit omissions | Host-adapter engineering; no Web App deployment can supply local session access |
| P0 for native-resume promise | No native recipient session creation | Prove a supported host mechanism that creates a separate session with external provenance and gated execution; otherwise retain the labeled context-document fallback | Host feasibility gate; do not forge private session databases |
| P1 | Installation/sign-in is not a one-step customer experience | Add guided, user-approved bootstrap, configuration and sign-in; exercise a fresh GitHub plugin install and confirmation UI, not just local plugin discovery | Plugin/onboarding engineering and approved app configuration |
| P1 | Recipient readiness is not assessed | Check reviewed tool/data/workspace prerequisites and report available, changed, missing and unknown states before any separately approved next action | Verified capability adapters and representative environments |
| P1 | Lifecycle/recovery UX is minimal | Add publication/review history, safe cleanup/retention, explicit expiration controls and clearer partial-failure recovery | Local state and provider lifecycle work; do not promise recall of downloaded copies |
| P2 | File size/type and platform support are limited | Validate additional OS/client combinations and adapters; extend large/binary attachments only with explicit scope and safety controls | Current release is bounded text, Copilot-facing, and work/school Microsoft accounts only |

Local engineering can continue without a tenant deployment. The app/site administrator and testers are needed for the **live sharing gate**, not for implementing capture, packaging or readiness logic.

Until the native host gates pass, describe the product as **reviewed context handoff**, not a complete session clone. Use the [project plan](PROJECT_PLAN.md) for the longer-term target and the [code plan](CODE_PLAN.md) for implementation milestones.

## 8. Implementation map

| Area | Source |
|---|---|
| CLI commands and typed confirmation | [cli.js](../src/cli.js) |
| Copilot tool schemas and human elicitation | [mcp-server.js](../src/mcp-server.js), [packaged skill](../skills/session-handoff/SKILL.md) |
| Snapshot/file bounds and redaction | [snapshot.js](../src/snapshot.js), [bundle.js](../src/bundle.js) |
| Review lifetime, binding and duplicate-attempt handling | [reviews.js](../src/reviews.js) |
| Share, inspect and isolated context import | [workflow.js](../src/workflow.js) |
| Microsoft authentication and local configuration | [graph-auth.js](../src/graph-auth.js), [config.js](../src/config.js) |
| Upload, link grants, download and revocation | [graph-provider.js](../src/graph-provider.js) |
| Synthetic Graph exercise | [graph-provider.test.js](../test/graph-provider.test.js), [workflow.test.js](../test/workflow.test.js) |
