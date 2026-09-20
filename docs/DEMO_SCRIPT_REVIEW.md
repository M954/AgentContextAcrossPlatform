# Revised Demo Script - Approved

**Status: approved for production on 2026-09-20.**

The presentation positions the current architecture as a central-server solution. The six approved screenshot steps retain their privacy redactions and evidence limitations; "local demo" is not the presentation's main branding. The production storyboard contains the final timing and condensed on-screen text.

## Opening sequence

### Title page - Project and team

**On screen**

AgentContextAcrossPlatform

**Share the context. Continue the work.**

Team: **Haowen Feng | Qinqi Xu**

**Narration**

> Agent Context Across Platform. Share the session context, and let another person continue the work.

**Visual direction**

A clean project title, a simple sender-to-recipient graphic, and clearly visible team names. No detailed architecture or screenshot on this page.

### Page 1 - The question and project overview

**On screen**

**Can another team member reproduce your agent context and capability?**

**Can a teammate pick up where your agent stopped?**

The handoff should preserve:

- The task, decisions, and evidence.
- The files, tools, and capability requirements.
- The next steps, prerequisites, and known limitations.

**Project overview:** A tool/MCP integration that shares agent context, selected files, capability requirements, and the current stopping point so another team member can reproduce the workflow and continue the unfinished work in their own authorized environment.

**Narration**

> When an investigation pauses, can a teammate pick up where your agent stopped and reproduce its context and capability? Our project packages the task, history, selected files, capability requirements, and next steps into a reviewed handoff, so work can continue without starting over.

**Visual direction**

Show both questions prominently. Use two simple target blocks: "Reproduce context and capability" and "Stop and continue". Place the concise project overview below them; avoid installation details on this page.

### Page 2 - The challenges

**On screen**

**A transcript alone is not a transferable working session.**

| Challenge | What we must preserve or make visible |
|---|---|
| Context portability | Different agents, formats, and context limits |
| Execution readiness | Missing files, tools, data access, and environment differences |
| Trust and governance | Sensitive information, ownership, consent, and permissions |

**Bottom line:** Restore context without pretending the recipient's environment is identical.

**Narration**

> The challenge goes beyond copying text. Agent formats differ, files and tools may be missing, and permissions do not transfer. We also need to protect sensitive information and make unknowns visible.

**Visual direction**

Three clear challenge cards, with short labels and one supporting sentence each.

### Page 3 - The ideal solution

**On screen**

**One share action. One continuation request.**

```text
Sender                       Reviewed handoff                  Recipient
Install once                 Selected context + files          Open a controlled link
Share the session     ->     Capability requirements      ->   Continue in their own agent
                             A permission-controlled link
```

Behind the simple experience:

**Capture -> Redact -> Approve -> Share -> Validate -> Resume**

Small footer: **Target experience. Existing authorization and supported-agent capabilities still apply.**

**Narration**

> Ideally, the sender installs once and shares in one reviewed action. The recipient opens a controlled link and continues in their own agent. Capture, redaction, approval, and validation stay behind that simple experience.

**Visual direction**

Use a sender/link/recipient diagram, with a smaller control pipeline beneath it. Clearly label this page as the ideal experience, not a claim that every host already supports setup-free native restoration.

### Demo start page - What we achieved first and what comes next

**On screen**

**Current solution: central server-based session handoff.**

| Implemented first: central server solution | Next step: SharePoint / OneDrive |
|---|---|
| A service for reviewed session snapshots and links | Protected file-based sharing across people |
| Publication, retrieval and revocation endpoints | Approved Microsoft identity and recipient permissions |
| Review-to-restore workflow through MCP/CLI | Security, governance and compliance validation |

**Deployment target: a hosted Web App.**

**Now watch: share -> confirm -> publish -> resume -> continue.**

**Narration**

> The current solution uses a central server to manage session snapshots and sharing links. We implemented this server-side workflow first. It can be hosted in a Web App once production controls are in place. Next, we will leverage SharePoint and OneDrive for secure, compliance-aligned file sharing.

**Visual direction**

Use a strong "Current solution / Next step" layout. Show a central service connecting the sender and recipient, with a Web App hosting label. Place SharePoint/OneDrive on the right as the next sharing foundation. Do not make the localhost address or test location the headline.

## Approved screenshot segment - keep unchanged

Keep the screenshot order, crops, privacy redactions and substantive messages. Change surrounding "LOCAL DEMO" branding to "SESSION HANDOFF DEMO" or "CENTRAL SERVER DEMO". Avoid repeatedly emphasizing the test location; keep actual addresses and provider values in the screenshots rather than editing them to look hosted.

| Step | Screenshot | Current message to retain |
|---|---|---|
| 1. Start sharing | `session_share.png` | Select the task and captured context. The first request shows OneDrive intent, not a completed cloud upload. |
| 2. Define the audience | `share_to_target_user.png` | The cloud path asks for named recipients. The localhost test does not demonstrate Microsoft recipient authorization. |
| 3. Confirm information | `confirm_information.png` | The actual demonstration uses `provider: local`; review scope and omissions before publication. |
| 4. Publish a snapshot | `locally_share_snapshot.png` | The demo server returns a JSON snapshot and link. This is a summary, not the full live runtime. |
| 5. Resume | `session_resume.png` | Select the local link, Copilot target and recipient workspace. Source permissions and credentials do not transfer. |
| 6. Continue the task | `session_restore_finish.png` | Recorded output reports restored context and a dataset match. Preserve the HTTP 403/cached-ranking caveat and the statement that SQL was not run. |

Do not replace the captured limitations with stronger claims. The endpoint visible in the screenshots is the test/demo instance of the central service, not proof of an already deployed Web App or completed SharePoint/OneDrive rollout.

## Closing pages - retain

### Future rollout

**On screen**

**Next: SharePoint and OneDrive as the file-sharing foundation.**

- Approved identities and specific-recipient access.
- Minimal capture, redaction, and explicit review.
- Applicable sensitivity, DLP and Conditional Access controls.
- Audit, retention, expiration, revocation and live cross-user validation.

**Narration**

> Next, we will leverage SharePoint and OneDrive as a security- and compliance-aligned file-sharing foundation. The rollout will use approved identities, scoped recipients, and organizational data controls, with validation against tenant security and compliance requirements.

### Team and contact

**On screen**

**Haowen Feng | Qinqi Xu**

Contact either team member to collaborate on the next phase.

`github.com/M954/AgentContextAcrossPlatform`

**Narration**

Retain the existing closing narration:

> Contact our team to collaborate on the next phase: a simpler handoff that keeps security, permissions, and evidence visible.

## Production boundary

The approved revision updates the production storyboard, opening layouts, narration and surrounding labels. The screenshot content, crops and privacy masks are retained. The video and captions follow [the production storyboard](../scripts/demo-video/storyboard.json).

**Accuracy note for production, not a headline slide:** the current server instance runs on loopback for testing and demonstration. Hosting the service in a Web App requires production authentication, authorization, HTTPS, operational controls and validation; do not imply that the unauthenticated test endpoint can simply be exposed to the internet unchanged. Reproducing capabilities also requires the recipient's own tools and permissions, not copying source credentials.
