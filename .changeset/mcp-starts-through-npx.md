---
'@veilio-inc/mcp': patch
---

The MCP server starts when it is run through `npx`, an npm bin link, a path with a space, or on Windows.

The check that decides whether the file was run as a program compared `import.meta.url` with `file://` plus `argv[1]` as text. Through the symlink npx and npm use, from a path with a space, and for every Windows path, the two never matched: the server exited 0 without output and never answered `initialize`. This included the `npx -y @veilio-inc/mcp` set-up the README gives. The server now uses the same check as the CLI, which resolves the link and builds the URL the way Node does. Reported from a Windows test session; reproduced on macOS through `npx`.
