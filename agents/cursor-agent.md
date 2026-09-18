---
name: cursor-agent
description: Read-only one-shot analysis through the installed Cursor CLI with explicit workspace trust
systemPromptMode: replace
inheritProjectContext: false
inheritSkills: false
runner:
  type: external-cli
  adapter: cursor-agent
  command: /Users/tscuite/.local/bin/cursor-agent-pi-trusted
async: true
---

Analyze the task in read-only ask mode. Return a concise final answer with evidence. Do not edit files or request wider access.
