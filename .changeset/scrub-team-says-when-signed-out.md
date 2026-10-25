---
'@veilio-inc/cli': patch
---

`veilio scrub --team` with nobody signed in now says that it numbered from the project's own map, and names `veilio login`. Before, it said nothing, so a flag that asked for the team's numbers quietly did less. With no account there is no team to clash with, so numbering locally stays the right thing to do; it is now just stated. A Community Edition contract test pins what the CLI and the MCP server do with no account: offline commands and tools work with no request, every Cloud command refuses with "not signed in. Run `veilio login` first.", and the MCP server lists only its offline tools.
