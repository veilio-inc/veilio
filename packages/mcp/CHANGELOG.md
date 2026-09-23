# @veilio-inc/mcp

## 0.2.0

### Minor Changes

- [#61](https://github.com/veilio-inc/veilio/pull/61) [`9694e6d`](https://github.com/veilio-inc/veilio/commit/9694e6d22c2e732a905a73fa3066c718a65ed123) Thanks [@DlgSHi](https://github.com/DlgSHi)! - Resolve identifiers against the team's shared namespace, and say which one was
  used.

  Every anonymize result now states the namespace that produced its placeholders:
  `team` when resolved against the team's shared dictionary, fetched from Cloud
  once at startup, so every teammate's agent produces the same placeholder for the
  same identifier; `local` when resolved locally.

  `local` is the normal, fully-functional state for anyone not on a paid team. The
  server never blocks on the fetch, and the fallback is always stated rather than
  silent — a shared placeholder that quietly stopped being shared would be worse
  than one that was never shared at all.

  There is no separate sign-in here. The server reads the same credential file
  `veilio login` writes.

  Team namespace resolution is not zero-knowledge: merging identifiers across
  teammates requires the server to hold them in plaintext. Personal map sync in the
  CLI is a different mechanism and remains zero-knowledge.

### Patch Changes

- Updated dependencies [[`9694e6d`](https://github.com/veilio-inc/veilio/commit/9694e6d22c2e732a905a73fa3066c718a65ed123), [`9694e6d`](https://github.com/veilio-inc/veilio/commit/9694e6d22c2e732a905a73fa3066c718a65ed123)]:
  - @veilio-inc/cli@0.2.0

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
