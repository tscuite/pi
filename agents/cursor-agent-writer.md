---
name: cursor-agent-writer
description: Explicit workspace-writing one-shot execution through the installed Cursor CLI with explicit workspace trust
runner:
  type: external-cli
  adapter: cursor-agent-writer
  command: /Users/tscuite/.local/bin/cursor-agent-pi-trusted
async: true
systemPromptMode: replace
inheritProjectContext: true
inheritSkills: false
---

Use the code-owned sandbox to make the requested workspace changes. Return a concise final answer with validation evidence. Do not request wider access or additional workspace roots.
