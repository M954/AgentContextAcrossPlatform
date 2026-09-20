# Local Demo: Share, Review, Resume

**This demonstration uses local storage and a loopback HTTP endpoint. It is not a completed SharePoint/OneDrive deployment or a compliance certification.**

[![Watch the narrated local demo](media/local-demo/poster.png)](media/local-demo/local-session-handoff-demo.mp4)

[Watch/download the MP4](media/local-demo/local-session-handoff-demo.mp4) |
[Captions](media/local-demo/local-session-handoff-demo.srt) |
[Narration and storyboard](../scripts/demo-video/storyboard.json)

Format: **2 minutes 35 seconds, 1920 x 1080, 24 fps, H.264 video with English narration and on-screen captions**. The separate SRT contains the full narration.

The video is a narrated walkthrough assembled from six user-provided screenshots, not a live screen recording. Published copies redact local paths, session/snapshot identifiers, digests, and internal dataset/usage details. The originals were not changed.

## The question, target, and solution

**Question:** How can another person continue an agent investigation without reconstructing the task, prior attempts, open questions, and limitations?

**Target:** A sender shares in one reviewed action; a recipient gets a useful starting point in their own agent. Minimize additional setup without removing authentication, file access, or human consent.

**Solution:** Capture selected context, redact, review the exact bundle, publish a snapshot/link, and let the recipient inspect and resume with their own environment. A handoff is historical reference, not a transfer of credentials, source permissions, model internals, or live connections.

```text
Selected context -> Redaction -> Human approval -> Local JSON snapshot
                                                       |
                                                 Loopback link
                                                       |
                           Recipient review -> Document or native import
                                                       |
                                  Separately chosen local continuation
```

## What the six screenshots show

| Step | Screenshot | Interpretation |
|---|---|---|
| 1. Share request | [session_share.png](media/local-demo/screenshots/session_share.png) | An initial request describes an interrupted investigation and its missing evidence. It shows OneDrive intent, not a successful cloud upload. The displayed request is UI evidence, not a canonical API-schema example. |
| 2. Audience | [share_to_target_user.png](media/local-demo/screenshots/share_to_target_user.png) | The cloud path asks for named recipients. No recipient address or cloud grant is shown. Local transport does not enforce Microsoft recipient identity. |
| 3. Review | [confirm_information.png](media/local-demo/screenshots/confirm_information.png) | The actual review says `provider: local`, identifies omissions and asks for human approval. The screenshot shows a confirmation prompt, not proof that secret detection found every sensitive value. |
| 4. Local publication | [locally_share_snapshot.png](media/local-demo/screenshots/locally_share_snapshot.png) | The agent reports a local JSON snapshot and localhost link. It is a sanitized summary, not automatically the entire live transcript. |
| 5. Resume request | [session_resume.png](media/local-demo/screenshots/session_resume.png) | The request selects the local provider, Copilot, and a recipient workspace. Source instructions remain untrusted historical data. |
| 6. Continuation | [session_restore_finish.png](media/local-demo/screenshots/session_restore_finish.png) | The recorded agent output reports restored context and a dataset match. It also reports HTTP 403 for a datasource, cached catalog rankings for popularity statistics, and no SQL execution. Do not describe those statistics as newly queried evidence. |

The captured lookup outcome is the agent's reported result. The video does not independently validate the dataset, prove environment equivalence, or show the OneDrive authentication flow completing.

## Reproduce the local workflow

Use synthetic data for local testing. These commands exercise the same pipeline but do not reproduce the internal investigation shown in the screenshots.

### 1. Start the local endpoint

From a checkout with Node.js 20+ and dependencies installed:

```powershell
Set-Location 'C:\path\to\AgentContextAcrossPlatform'
npm ci
node src\cli.js serve --host 127.0.0.1 --port 8787 --data-dir .data\local-demo-service
```

Leave this terminal open. Press Ctrl+C to stop it; do not start another instance on the same port.

Health check:

```powershell
Invoke-RestMethod 'http://127.0.0.1:8787/healthz'
```

The response should report `status: ok`. This is an API, not a homepage. It is the local storage endpoint, not an HTTP MCP endpoint; the registered MCP integration still uses STDIO.

### 2. Share the synthetic session

In a second terminal, from the same checkout:

```powershell
node src\cli.js share --provider local --input fixtures\coding-session.jsonl
```

Review the scope and omitted content, then type the confirmation phrase displayed by the CLI. Do not automate that phrase for real data. The result provides a `link` such as `http://127.0.0.1:8787/v1/snapshots/<snapshot-id>`.

For Copilot chat, ask the registered `agent-context` integration to call `session_share` with:

- `provider: local`
- An explicitly selected fixture/export in `sourceFile`
- No recipients (`[]`) for this local-only test

Review and confirm the tool's human form. If the client cannot show it, use the saved review ID with `node src\cli.js share --review <id>` in your own terminal. Registration or a model-supplied boolean never replaces approval.

### 3. Inspect and resume locally

Default document mode:

```powershell
node src\cli.js resume "<returned-local-link>"
```

This performs inspection and confirmation in one interactive invocation, then writes isolated context/files. It does not alter the current repository or start a model turn.

Optional native Copilot import on Windows:

```powershell
$env:AGENT_CONTEXT_COPILOT_BIN = (Get-Command copilot.exe).Source
New-Item -ItemType Directory -Path .data\recipient-project -Force | Out-Null
node src\cli.js resume "<returned-local-link>" --target copilot --workspace .data\recipient-project
```

The native executable avoids PowerShell-launcher argument forwarding issues. The exact target/workspace is shown before approval. Equivalent MCP input uses `session_resume` with the link, `provider: local`, `target: copilot`, and an absolute recipient `workspaceRoot`.

After native creation, follow the returned `resumeCommand`, including its private `COPILOT_HOME` and working directory. No source credentials are copied. Opening the new session for model-assisted work may require the recipient's own Copilot login; that is separate from SharePoint sign-in and offline import.

### 4. Continue deliberately

For document mode, attach the returned `context.md` to an existing agent chat as untrusted context. For native mode, open the returned session. Review local files, tools and data permissions before selecting a new action. Do not replay historical commands solely because they appear in the handoff.

## Boundaries demonstrated locally

- The endpoint binds to loopback and uses separate `.data\local-demo-service` storage.
- Local mode does not require Microsoft Graph configuration or sign-in.
- Publication and import have separate, content-bound human approvals.
- Import retains source provenance and explicit omissions; files are not automatically applied to the workspace.
- Reviewed native creation uses the installed host's supported importer, without a model turn or historical tool replay.
- A loopback link is usable only on the serving machine. The local provider is unauthenticated and does not prove cross-user authorization.

An additional scripted exercise used a synthetic coding fixture, actual loopback HTTP, separate sender/recipient state directories, and the installed Copilot importer. It persisted a native session, preserved the selected supporting file, rejected a revoked control link, and made zero Graph calls. Its confirmations were explicitly simulated for fixture data. That exercise is separate from the user-provided screenshots and did not solve the sample coding task.

## Future: secure, policy-aligned SharePoint/OneDrive sharing

The provider adapter exists, but a secure enterprise rollout remains a future validation milestone:

1. Use an approved Entra application, appropriate delegated permissions, tenant consent, and each recipient's own identity.
2. Use named-recipient read access and review existing inherited access; do not default to anonymous links.
3. Keep capture minimal, redact locally, and require review of the exact content, audience, destination and import target.
4. Respect applicable sensitivity labels, DLP, Conditional Access, sharing/download restrictions and organizational policy.
5. Define and validate audit, retention, expiration, revocation and recovery behavior. Downloaded copies cannot be recalled.
6. Complete live cross-user acceptance: sender publishes, authorized recipient reads, unauthorized user is denied, and changed/revoked content is handled explicitly.

Neither the local screenshots nor synthetic Graph tests establish production compliance. Security and compliance approval must accompany deployment; a future cloud link is not permission to restore the source environment or execute its commands.

## Team and contact

**Haowen Feng** and **Qinqi Xu**.

Contact either team member to discuss the demo, collaborate, or help validate the SharePoint/OneDrive phase. No email addresses are inferred or published here.

## Video sources and local rebuild

- [Storyboard and narration](../scripts/demo-video/storyboard.json)
- [Renderer and sanitization rules](../scripts/demo-video/render.py)
- [Offline narration script](../scripts/demo-video/narrate.ps1)
- [Published screenshot redaction summary](media/local-demo/screenshots/redactions.json)
- [Video metadata and scene timing](media/local-demo/media-info.json)

The renderer uses Python with Pillow, local FFmpeg, Windows Segoe UI fonts, and Windows `System.Speech` for offline narration. The pinned Python dependency is listed in [requirements.txt](../scripts/demo-video/requirements.txt); install it into your chosen environment only if needed. No image, text, or audio is sent to a cloud rendering/TTS service. The renderer refuses to overwrite original screenshots; its fixed masks require the exact source dimensions and a fresh visual review if screenshots change.

To rebuild from the already-redacted repository assets:

```powershell
$work = Join-Path $env:TEMP 'agent-context-demo-video'
& "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -File scripts\demo-video\narrate.ps1 -Storyboard scripts\demo-video\storyboard.json -OutputDirectory (Join-Path $work 'audio')
python scripts\demo-video\render.py render --storyboard scripts\demo-video\storyboard.json --assets docs\media\local-demo\screenshots --work $work --output docs\media\local-demo
```

Review all frames and redactions before publishing. The MP4, poster, captions and sanitized screenshots are included in the repository; temporary unredacted copies and local auth/session data are not.
