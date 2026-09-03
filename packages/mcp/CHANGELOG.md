# @veilio-inc/mcp

## 0.1.0

First public release.

An MCP server exposing the anonymizer to coding agents. Its tools take a **file
path**, so the server reads the file in its own process and the agent only ever
sees `__CLS__1.__FN__2()` — a tool taking code as an argument would be pointless,
since the real identifiers would already be in the model's context by the time it
was called.

Shares one symbol map with the `veilio` CLI, so you can mask inside an agent and
restore from a terminal, or the reverse. No account, no API key, and no network
call: `tests/purity.test.ts` traps the network globals and fails if one is ever
introduced.

Written by hand rather than generated, for the same reason as the CLI's: this
release skips `changeset version`, because 0.1.0 had never been published and
`changeset publish` takes it straight from the manifest. Entries from the next
release onward are generated above this one.
