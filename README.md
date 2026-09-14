# AgentContextAcrossPlatform

**Turn knowledge from coding agent histories into reusable expertise for someone else's agent.**

A plugin-based knowledge-sharing project that brings together work recorded across local agents and sessions. It extracts knowledge and investigation methods with traceable sources and explicit applicability boundaries, lets users review and export them as a single file, and enables recipients to import and use them in their own agents and environments.

> **Status: Hackathon design stage. No working plugins or commands have been implemented yet.**
> The commands, filenames, and workflows below are proposed designs. See the [project plan](docs/PROJECT_PLAN.md) for detailed requirements and architecture.

## Why This Project?

Development experience is often scattered across agent histories:

- One session tries an approach.
- Another discovers that it fails under certain conditions.
- A later session contains a user correction and validation of a different approach.

A single-session summary can miss these connections. We want to recover **what worked, why it worked, when it does not apply, and what evidence supports it.**

### Knowledge Handoff, Not Just Context Handoff

| | Context handoff | Knowledge handoff |
|---|---|---|
| Core question | Where did the original task stop? | What did we learn from the work? |
| Main content | Progress, changes, and next steps | Methods, constraints, rationale, and lessons from failures |
| Intended use | Continue the same task | Apply knowledge to future related tasks |
| Success criterion | The recipient can resume work | The recipient can reuse the knowledge correctly and recognize when it does not apply |

**The file format is not the core value.** A regular prompt can already summarize a session into Markdown. The value we need to validate lies in cross-session synthesis, source traceability, applicability checks, and the execution of reusable workflows.

## How It Works

```text
User A's machine
  Multiple agents / multiple sessions
                  ↓
  Discover authorized records and normalize formats
                  ↓
  Extract knowledge, corrections, counterexamples, and evidence
                  ↓
           User review and selection
                  ↓
             Export one file
                  │
       User sends it through email or chat
                  ↓
User B's machine
  Plugin import → Review applicability and dependencies
                  ↓
  Use the knowledge in B's own agent and environment
```

- **Plugin-based:** No standalone hosted service or platform account system.
- **Single-file exchange:** No Git-based synchronization; users handle file delivery.
- **Cross-agent and cross-user:** Adapters handle host differences. Users do not need to specify the source agent.
- **Knowledge is separate from access:** Sharing does not include credentials or grant data access.
- **On-demand use:** Imported knowledge is stored externally and provided for relevant tasks; it does not modify model weights.

Supporting every agent is the long-term compatibility goal. Individual sources and hosts must be implemented and validated before they are considered supported.

## First MVP: Titan Latency Investigation

**Turn an existing Titan latency investigation into a method another user can reuse.**

### User A: Export from an Investigation

The original conversation may contain data source selection, queries, fixes, metric explanations, and user corrections. The plugin organizes these into:

- Queries that were actually executed and their associated results.
- The purpose, order, and rationale of each investigation step.
- Replaceable parameters such as the time range and investigation target.
- Tool dependencies, applicability conditions, lessons from failures, and limitations.
- Selected and redacted source evidence.

After review, A exports a knowledge package, such as `titan-latency.knowledge.zip`, and sends it to B.

### User B: Run in Their Own Environment

After import, the plugin checks local Titan query capabilities and prerequisites, then collects parameters for the new investigation. With B's confirmation, it runs reviewed, read-only queries using **B's own identity and permissions**, and produces a report grounded in the actual queries and results.

Missing permissions, changed data structures, or insufficient evidence must lead to an explicit pause or limitation report, not a claim that the workflow transferred successfully.

**The investigation method is reused; A's historical root cause is not treated as B's new conclusion.** Titan's actual interfaces, data structures, and metric definitions still need to be confirmed from a real conversation.

## Proposed Commands

These commands are not implemented yet. Each host adapter will provide the appropriate invocation syntax.

| Command | Purpose |
|---|---|
| `/knowledge mine` | Discover supported history sources and extract candidate knowledge within selected projects, time ranges, and sessions |
| `/knowledge export` | Review and export selected knowledge or investigation workflows |
| `/knowledge import <file>` | Validate a package, preview its contents, and confirm where it should apply |
| `/knowledge run <investigation-id>` | Check dependencies, collect parameters, and run an investigation after confirmation |

Importing a file, adopting its knowledge, and executing queries are separate actions. Import must not automatically execute commands contained in a package.

## Architecture Boundaries

- **Host Adapters:** Discover and read session formats, register commands, and provide knowledge to the current agent.
- **Knowledge Core:** Process normalized records, link sources, extract and review knowledge, and manage packages and parameters.
- **Tool Capability Adapters:** Map execution capabilities in the recipient's environment, such as Titan queries, independently of the source agent.

Prefer local files and lightweight indexes. Cloud services, vector databases, and knowledge graphs are not prerequisites for the MVP.

## Hackathon Roadmap

### Phase 1: Complete One Real Investigation Workflow

- [ ] Build a normalized fixture from a real Titan conversation.
- [ ] Extract a reviewable investigation method, queries, and applicability conditions.
- [ ] Implement single-file export, validation, and import.
- [ ] Check dependencies and run the parameterized workflow in the recipient's environment.
- [ ] Validate reuse with a different time range or target.

### Phase 2: Demonstrate Cross-Session Knowledge Extraction

- [ ] Integrate two validated local agent history sources.
- [ ] Discover sources automatically and support project and time filtering.
- [ ] Synthesize corrections, lessons from failures, and later revisions across records.
- [ ] Demonstrate at least one useful insight that requires combining multiple sessions.

Evaluate against **the same records + a strong summarization prompt + Markdown**, not just a single-session summary. Focus on whether the knowledge is worth keeping, whether its sources are traceable, and whether the recipient can apply it without overgeneralizing.

## Security and Privacy

- Read only authorized sources. Control collection, submission to a model for analysis, and export separately.
- Do not share full conversations, credentials, or large amounts of raw investigation data by default. Provide human review; sensitive-data detection is only an aid.
- Treat imported packages as untrusted data. Do not automatically execute scripts or overwrite global agent instructions.
- Query execution requires explicit capability mapping, parameter validation, scope limits, and user authorization.
- No custom backend does not mean no data leaves the machine: material supplied to a remote model may be sent to its provider.
- Once a file is shared, copies already made by the recipient cannot reliably be revoked.

## Documentation

- [Project Plan](docs/PROJECT_PLAN.md): Product boundaries, the Titan MVP, adapter architecture, draft package format, security requirements, acceptance criteria, and related work.
