---
'@veilio-inc/cli': patch
'@veilio-inc/mcp': patch
---

Document what 0.3.1 actually does. Both READMEs described the tools as they were
before the one restore rule landed, and npm renders those files.

The CLI's README now lists every flag `veilio --help` does — `--keep-docs`,
`--force` and `--instance` were missing — names the three files the Cloud
commands write under `~/.veilio/`, and explains restoring a teammate's
placeholders: a disputed one is left and named rather than guessed, a locked
team key says so, a signed-out restore still makes no request, and a signed-in
one waits five seconds for Cloud at most.

The MCP server's README no longer claims the team namespace is read once and
reused for the life of the process — `veilio team unlock` after startup is
picked up without a restart. It also documents the restore rule and the error
result a locked or unreadable team produces, what happens to placeholders
minted during a lapse, the reason the `local` line carries, and the two lines
every anonymize result can add: the language-fallback warning and the count of
comment prose left unmasked.
