# AgentContextAcrossPlatform — Hackathon Project Plan

> Status: Discussion draft; not implemented.
> This document captures the agreed product direction, architectural boundaries, and first MVP scenario. Commands, file extensions, and directory layouts are design examples, not features currently available in this repository.

## 1. Product Definition

A plugin for coding agents that extracts reusable knowledge from work recorded across different agents and sessions on the current machine. Users review and export that knowledge as a single file, which another user can import through the plugin and use in their own agent and environment.

**The core is discovering, organizing, and reusing knowledge accumulated through work—not moving chat logs. File sharing is the delivery mechanism.**

### Context Handoff vs. Knowledge Handoff

- Context handoff communicates where the original task stopped so someone else can continue it.
- Knowledge handoff extracts methods, constraints, rationale, lessons from failures, and applicability boundaries for future related tasks.
- An investigation result belongs to a particular task; a parameterized investigation method can become reusable knowledge.
- Importing knowledge does not modify model weights or guarantee permanent model memory. Knowledge is stored externally and provided on demand for relevant tasks.

### Agreed Product Constraints

1. Plugin-based; no standalone hosted service or platform account system.
2. No Git-based knowledge synchronization or transport.
3. User A exports one file through a command and sends it to B through a channel such as chat or email.
4. User B imports the file through a command and reviews it before using the knowledge or investigation workflow.
5. Cross-user and cross-agent; adapters handle differences between supported hosts.
6. Users do not need to specify the source agent or understand native session formats.
7. The product vision covers multiple agents and sessions on the local machine, not just the current conversation.
8. Sharing knowledge does not grant data access, carry A's credentials, or automatically synchronize code or environments.

## 2. Core Value and Hypotheses to Validate

### Why Not Just Ask an Agent to Write Markdown?

If the only workflow is “summarize the current session → write a file → read it elsewhere,” the incremental value is limited. Markdown can already carry knowledge; inventing a new format is not evidence of value.

Capabilities worth implementing and validating include:

- Discovering authorized histories from different agents and normalizing messages, tool calls, and results.
- Connecting the evolution of a problem, user corrections, failed attempts, and later validation across sessions.
- Distinguishing project facts, personal preferences, transferable methods, and unverified hypotheses.
- Preserving sources, applicability conditions, counterexamples, and later revisions.
- Turning actual execution records into reviewable, parameterized workflows for recipients.
- Checking tool dependencies and prerequisites in the recipient's environment and retaining execution evidence.

These are product hypotheses. We should not claim in advance that they outperform a general-purpose agent with a strong prompt.

### Cross-Session Example

```text
Session A: Tries approach X
Session B: Finds that X fails under condition C
Session C: Contains a user correction; approach Y passes the relevant tests
    ↓
Candidate knowledge: Do not apply X directly under condition C;
consider Y and run the corresponding validation.
```

Repeated occurrence does not establish correctness. Copies of the same record must not count as independent evidence.

## 3. User Workflows

### 3.1 Discovery and Extraction

Proposed command:

```text
/knowledge mine
```

1. Automatically discover supported local agent session sources.
2. Show the collection scope and let users select projects, time ranges, and sessions.
3. Read only authorized sources; do not perform unrestricted collection across the machine.
4. Normalize source formats and organize relevant records by problem or topic.
5. Generate candidate knowledge with evidence, applicability conditions, and uncertainty.
6. Let users inspect sources, edit, keep, or dismiss candidates.

Direct extraction from the current conversation remains one entry point within the broader product.

### 3.2 Export

```text
/knowledge export
```

Users select knowledge entries or investigation workflows, preview the contents, remove sensitive information, and generate one portable file. Users handle delivery themselves.

### 3.3 Import and Use

```text
/knowledge import <file>
```

1. Validate the format, version, size, and content boundaries.
2. Show the contents, claimed provenance, applicability, and dependencies.
3. Ask the user to confirm the target project and adoption scope.
4. Check local tools and environmental prerequisites.
5. Provide knowledge on demand; for investigation workflows, collect parameters and request execution confirmation.

Proposed investigation entry point:

```text
/knowledge run <investigation-id>
```

Invocation syntax is host-specific, but the logical capabilities remain consistent. Importing, adopting knowledge, and executing queries are distinct actions and must not collapse into unconditional execution.

## 4. First MVP: Reusing a Titan Latency Investigation

### 4.1 Scenario

User A already has a local conversation that used Titan data to investigate latency. A wants to share the method with B so that B can investigate a different time range or target in their own environment.

The conversation has not yet been provided, and Titan's actual interfaces, data structures, and metric definitions have not been confirmed. The implementation must not assume that Titan necessarily uses Kusto, SQL, or a particular MCP tool.

### 4.2 What to Extract from the Original Conversation

- The investigation goal and problem definition.
- Data sources, tool capabilities, and environment dependencies.
- Actual queries, parameters, and associated results.
- Queries that failed and how they were subsequently corrected.
- Latency metric definitions and important filters.
- Query order and the question each step is intended to answer.
- User corrections, reasoning behind decisions, and method limitations.
- Replaceable parameters and structures that must not be changed arbitrarily.

Prefer recovering operations from available tool-call records over asking the model to rewrite them from memory. Distinguish successful execution, results that support a conclusion, and suggestions that were discussed but never validated.

### 4.3 What the Export Represents

The package describes “how to investigate this class of problem,” not “the new problem must have the same root cause.”

Parameters may include the time range, investigation target, and comparison range, but their exact fields must come from the actual workflow. The original data connection can be documented as a dependency without automatically requiring the recipient to use that same connection.

Historical results are evidence with a defined scope, not conclusions about the new investigation.

### 4.4 Execution by the Recipient

```text
Import and review the investigation method
    ↓
Check local Titan tools and access permissions
    ↓
Enter the new target, time range, and other parameters
    ↓
Check required data structures and metric definitions
    ↓
Run reviewed, read-only queries after confirmation
    ↓
Choose next steps based on results; pause for input when necessary
    ↓
Report queries, supporting results, limitations, and open questions
```

- Use B's own identity, connections, and permissions.
- If capabilities, fields, or metrics do not match, explicitly pause or reduce functionality rather than claiming that the workflow transferred successfully.
- The new data may contain no anomaly. Reports must allow “no anomaly found” or “insufficient evidence.”
- Bound query scope, count, duration, and result size to prevent unbounded queries and unnecessary costs.

## 5. Architecture

```text
Agent plugin entry point / local session discovery
                    ↓
               Host Adapters
                    ↓
          Normalized Conversation
                    ↓
         Knowledge Extraction Core
                    ↓
  Candidate knowledge, sources, scope, and user review
                    ↓
          Single-file knowledge package
                    ↓
  Recipient plugin: validation, review, and adaptation
                    ↓
  On-demand knowledge / confirmed investigation execution
```

### 5.1 Host Adapter

Handles host-specific responsibilities:

- Discover supported session storage locations automatically.
- Read authorized messages, tool calls, results, and attachment references.
- Register commands and obtain current project and session information.
- Provide normalized knowledge to the current agent.

The core library should not contain business logic that branches on agent names. The source agent may be retained as provenance metadata, but it is neither a required user input nor an execution dependency of the imported package.

“All agents” is a compatibility goal, not a substitute for individual validation. Unreadable sources should produce an explicit unsupported-source message or require a standard export, rather than silently claiming complete collection.

### 5.2 Knowledge Core

Processes normalized data:

- Record normalization, deduplication, and source linking.
- Topic organization and cross-session correction and conflict detection.
- Candidate extraction, review, revision, and export.
- Parameter definitions, input validation, and on-demand context assembly.

The model performs semantic extraction. Local code performs deterministic checks on formats, references, parameters, and tool results where possible. Tool validation must not be presented as proof of every semantic claim in the knowledge.

### 5.3 Tool Capability Adapter

Separate from the Host Adapter, this layer handles execution capabilities in the recipient's environment, such as Titan queries.

The exact tool name used in the original conversation should not be treated as the only possible implementation. However, substitutions require validated capability mappings; the model must not arbitrarily assume that two interfaces are semantically equivalent.

### 5.4 Storage and Execution

- Local files store candidate knowledge, review records, and imported content.
- The MVP can use lightweight indexes; a database, vector search, or persistent service is not required.
- Prefer the host agent's model capabilities rather than building a separate inference backend.
- “No custom hosted backend” does not mean “no data leaves the machine.” If the host uses a remote model, history or evidence included in its context may be sent to the model provider. Make the data scope explicit before analysis.

## 6. Draft Knowledge Package

The tentative format is one ZIP file containing human-readable material and structured metadata. The final format may change during the MVP; the format itself is not the differentiator.

```text
titan-latency.knowledge.zip
├── manifest.json       # Format version, knowledge type, scope, parameters, capabilities
├── KNOWLEDGE.md        # Methods, steps, rationale, counterexamples, and limitations
├── queries/            # Reviewed query templates, optional
└── evidence.md         # Selected, redacted source evidence, optional
```

Each knowledge entry should describe at least:

- Content and type: fact, method, constraint, lesson, or hypothesis.
- Applicable projects, environments, versions, and triggering conditions.
- Sources and evidence, distinguishing user requirements, tool observations, and model inferences.
- Recommended actions and conditions under which they do not apply.
- Known contradictions, missing information, and validation methods.

Packages should be self-contained where possible. Inaccessible evidence must be labeled rather than represented only by absolute paths on A's machine. Procedural knowledge could be rendered into Agent Skills-compatible material, but that must not cause bundled code to be installed or executed automatically.

## 7. Security and Trust Boundaries

- Collection, submission to a model for analysis, and export for sharing are separate authorization steps.
- Do not export full conversations, credentials, raw environment variable values, or large amounts of raw Titan data by default.
- Provide sensitive-data detection and human preview. Detection reduces risk but cannot guarantee the absence of sensitive information.
- Claimed authors and agent names do not automatically authenticate identity.
- Treat imported packages as untrusted data; they do not automatically acquire high-priority instruction authority.
- Do not execute bundled scripts, use package-supplied paths to access arbitrary files, or overwrite global agent instructions automatically.
- If ZIP is used, check extraction size, path traversal, symbolic links, and unexpected file types.
- Query execution requires explicit local capability mapping, parameter validation, and user authorization.
- Once a file has been shared, copies already made by recipients cannot reliably be revoked.

## 8. Hackathon Scope and Implementation Order

### Phase 1: One End-to-End Investigation

1. Build a normalized fixture from the selected Titan conversation.
2. Extract a reviewable investigation workflow and queries without inventing data structures.
3. Implement single-file export, validation, and import.
4. Check dependencies and execute the parameterized workflow in the recipient's environment.
5. Validate reuse with a different time range or target.

This phase demonstrates knowledge delivery and use. It does not claim machine-wide, multi-session extraction.

### Phase 2: Demonstrate Cross-Session Extraction

1. Integrate two agent history sources that have been validated in practice.
2. Discover sources automatically and provide project and time filtering.
3. Use multiple related investigation records to extract corrections, repeated failures, and subsequent revisions.
4. Demonstrate at least one useful insight that requires synthesizing multiple records.

Supporting multiple sources is an internal engineering scope decision, not a reason to require users to select the source agent manually.

### Out of Scope for Now

- Deep integration with every agent.
- Unrestricted whole-machine scanning or automatic history uploads.
- Cloud synchronization, account systems, Git transport, or a public knowledge community.
- General-purpose knowledge graphs, model training, or autonomous multi-agent orchestration.
- Automatically adopting rules across projects or executing external code.

## 9. Acceptance Criteria and Baseline

### Titan MVP Acceptance Criteria

- A can export a reviewable file from an existing investigation.
- B does not need the original session or knowledge of the source agent.
- B runs the investigation with their own Titan permissions and new parameters.
- Execution results are traceable to actual queries; model claims of success are not substitutes for evidence.
- Missing dependencies, changed data structures, no anomalies, and insufficient evidence are handled explicitly.
- The workflow does not depend on A's private credentials or undisclosed material available only on A's machine.

### Knowledge Extraction Quality

Compare against **the same records + a strong summarization prompt + Markdown**, not just a single-session summary.

Evaluate:

- Which knowledge users actually want to keep.
- Whether later corrections and counterexamples are incorporated correctly.
- Whether project-specific experience is incorrectly generalized.
- How easily sources can be inspected.
- Whether recipients avoid unproductive attempts and refrain from applying knowledge outside its scope.

Report cases where the baseline already succeeds honestly. Do not claim improvements that have not been validated.

## 10. Related Work and Open Questions

### Current Limitations of Similar Projects

The relevant pain points concern the fit of existing tools to our workflow, not an absence of competing products. Distinguish documented product boundaries from hypotheses about user friction.

The observations below come from the projects' public READMEs. They are not installation tests, performance benchmarks, or an exhaustive market survey. Missing documentation is not proof of a missing capability, and these observations should be rechecked as the projects evolve.

#### continues: Session Transfer Is Not Yet Evidence of Knowledge Synthesis

Source: [continues README](https://github.com/yigitkonur/cli-continues).

- **Documented capabilities:** Discovers and parses native histories from multiple agents, transfers a selected session to another tool, and supports bulk Markdown or JSON export.
- **Remaining friction for our scenario:** The documented primary unit is a session handoff. Exporting many sessions does not itself combine later corrections, contradictory findings, and repeated investigations into a reusable method. The handoff also references the original session's full local path, which a different user may not be able to access.
- **What to validate:** Whether a user can derive and share a self-contained, cross-session investigation method without manually selecting, combining, and adapting exported records. Do not claim that continues lacks discovery or file export; it already provides both.

#### SpecStory Lore: Knowledge Mining Already Exists; Native-History Onboarding Needs Investigation

Source: [Lore README](https://github.com/specstoryai/getspecstory/tree/main/lore).

- **Documented capabilities:** Mines SpecStory histories across agents, sessions, projects, and teammates; uses evidence and outcome signals; generates reusable Skills; and proposes updates as evidence grows. It is optimized for Claude Code while documenting fallback behavior for other hosts.
- **Remaining friction for our scenario:** The documented input corpus is SpecStory history, whereas our entry point is the native session history already present on a user's machine. The reviewed README does not establish the complete onboarding path from untouched native histories. Existing conversion or backfill options must be checked before claiming a limitation.
- **What to validate:** The setup and manual preparation required to use those existing histories, followed by the steps needed for a different user to adopt a Titan investigation with new parameters and local tool bindings. Do not claim that cross-session mining, team-aware knowledge, evidence-backed Skills, or multi-agent reuse are unique to us.

#### Waybill: Portable Handoff Does Not Include History Mining or Workflow Execution

Source: [Waybill README](https://github.com/wardmos/waybill).

- **Documented capabilities:** Local, reviewable handoff bundles; agent integrations; export/import; redaction; packing and unpacking; and repository verification. It explicitly states that it does not parse agent transcripts and is not a workflow runner.
- **Remaining friction for our scenario:** Users need another layer to extract methods from existing histories and to run a parameterized Titan investigation in a recipient's environment. Its safety-oriented handoff scope is intentional, not a defect in its implementation.
- **What to validate:** Whether our extraction and controlled execution layers reduce the additional work compared with using Waybill plus the receiving agent. Its Git inspection collects repository evidence; it is not Git-based knowledge transport. We must not present local file sharing or safe import as missing features.

#### Portable Handoff: Structural Validation Does Not Prove Knowledge Transfer

Source: [Portable Handoff README](https://github.com/legoambarish/portable-handoff).

- **Documented capabilities:** A single Markdown capsule containing canonical JSON, provenance labels, deterministic repository facts, integrity checks, staleness detection, and secret redaction.
- **Documented limitation:** Its Limits section states that semantic quality depends on the model doing the compaction, that compaction loses information, and that its quality harness cannot establish how much useful knowledge the model supplied.
- **Remaining friction for our scenario:** A valid capsule and matching repository evidence do not establish that the investigation method applies to a different Titan environment or data range. This is also a challenge our project must solve, not an automatic advantage we possess.
- **What to validate:** Whether source-linked extraction and recipient-side capability and metric checks reduce unsupported conclusions, missed prerequisites, and failed attempts on a new investigation.

### Proposed Opportunity and How to Test It

The proposed differentiation is an integrated workflow, not a claim that each individual capability is new:

```text
Existing native histories
    → Cross-session methods, corrections, and evidence
    → Reviewed, parameterized investigation package
    → Adoption by another user with their own tools and permissions
    → Results grounded in actual queries
```

Validate three specific sources of friction:

1. **Preparing the input:** What must users install, export, convert, or select before existing sessions can be mined?
2. **Producing reusable knowledge:** How much manual work is needed to reconcile corrections, preserve evidence, and separate reusable methods from one-off results?
3. **Making it work for someone else:** How much manual editing, dependency setup, parameter replacement, and clarification is needed before the recipient can perform a new investigation?

Use the same authorized session corpus and new investigation task when comparing a strong Markdown baseline, an existing tool or combination of tools, and our prototype. Record preparation steps, manual edits, clarification requests, inaccessible references, and actual query outcomes. Report strengths and failures for every approach without inventing savings or success rates.

Our integration may introduce its own costs: native-format maintenance, model analysis cost, and tool-adapter setup. Include those in the comparison. If existing tools already handle the scenario well, consider extending or composing them rather than duplicating their functionality.

### Existing Capabilities We Should Reuse or Match

- [Agent Skills](https://github.com/agentskills/agentskills) already provides an open format for portable knowledge and workflows. Compatibility may be preferable to another standalone knowledge format.
- Local operation, cross-agent support, single-file or packaged sharing, redaction, provenance, staleness checks, and cross-session mining already exist in related projects. None should be presented as a standalone unique differentiator.
- An honest claim for this hackathon is to demonstrate one complete native-history-to-Titan-reuse workflow and measure the remaining manual work—not to claim that existing projects cannot share knowledge.

### Open Questions

- The actual Titan conversation fixture and what may be shared from it.
- Titan's current tool interfaces, metric definitions, and recipient permissions.
- A second set of investigation parameters and a credible validation method for the demo.
- Hackathon team size and time budget.
- The initial adapter implementation and test scope, determined internally rather than required as user input.

## 11. One-Sentence Pitch

> Extract evidence-backed knowledge with explicit applicability boundaries from coding agent histories, and turn a Titan latency investigation into a portable method that another user's agent can reuse in its own environment.
