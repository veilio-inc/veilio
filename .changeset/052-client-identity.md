---
'@veilio-inc/cli': patch
'@veilio-inc/mcp': patch
---

Every request to Veilio Cloud now names the program that sent it: `X-Veilio-Client: cli` with `User-Agent: veilio-cli/<version>` from the CLI, and `X-Veilio-Client: mcp` with `User-Agent: veilio-mcp/<version>` from the MCP server, which until now labelled its requests `cli`. Cloud logs both when it rate-limits a request. It is a self-report and never decides access.
