---
'@veilio-inc/mcp': patch
---

At startup, without veilio-guard, the server prints one line to stderr and tells the agent the same in its instructions: in Claude Code, to install the guard; in other agents, to turn off the agent's own file and shell tools. `CI` silences it.
