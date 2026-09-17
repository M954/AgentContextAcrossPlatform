---
name: session-handoff
description: Safely share OneDrive/SharePoint session bundles and import them as context documents.
---

# Session handoff

Read the canonical skill at `../../../skills/session-handoff/SKILL.md` relative to this directory before using handoff tools. The same skill is packaged for plugin installation and defines the human-confirmation workflow.

Report `context_imported`, `restoreMode: context_document`, and `executionReadiness: not_assessed` after import. No native session is created, no environment compatibility is assessed, and no source tools are replayed. Never invent those checks. Model-supplied approval flags are not accepted; the trusted confirmation form or interactive CLI must approve the exact review.
