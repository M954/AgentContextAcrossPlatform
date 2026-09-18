---
name: session-handoff
description: Share reviewed OneDrive/SharePoint bundles and import document or explicitly reviewed native pi/Copilot context.
---

# Session handoff

Read the canonical skill at `../../../skills/session-handoff/SKILL.md` relative to this directory before using handoff tools. The same skill is packaged for plugin installation and defines the human-confirmation workflow.

Choose target/workspace during `session_inspect`; complete with only the review ID. Report `context_imported` for a document or `native_session_created` only after confirmed native creation. Execution remains `not_assessed`; passive reports are separate and cannot authorize execution. No source tools are replayed. Model approval flags and post-review target overrides are rejected; a trusted human UI must approve the exact review.
