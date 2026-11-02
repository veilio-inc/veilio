---
'@veilio-inc/mcp': patch
---

The package description and README no longer say an agent never sees the real names: the server masks what the agent reads through it, and does not stop the agent reading files or command output with its own tools. In Claude Code, veilio-guard enforces masking for everything the model sees.
