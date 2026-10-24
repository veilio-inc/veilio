---
'@veilio-inc/mcp': patch
'@veilio-inc/cli': patch
---

The MCP server's `anonymize_file` now masks a file the way `veilio scrub <file>` does: in the language its extension names, unless one is asked for, and with the names it takes from a public package left as written. Both use one shared rule, `@veilio-inc/cli/third-party`, so the two give the same placeholders for the same file. `anonymize_text` is unchanged: with no file and no project, it treats nothing as third-party, as `scrub` does on standard input.
