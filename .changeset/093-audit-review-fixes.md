---
'@veilio-inc/cli': patch
'@veilio-inc/mcp': patch
---

`veilio scrub` and the MCP server's anonymize tools now stop and say so when the saved custom rules cannot be read, where before they masked without them. The MCP server ignores `VEILIO_MCP_RESTORE` and `VEILIO_MCP_DESTRUCTIVE` when the project's own `.mcp.json` sets them, and map ids and names from Cloud are shown without control characters. Two runs saving one project's map at once can no longer leave a placeholder standing for two names, and the GitHub Action's message for other events names the `paths` input.
