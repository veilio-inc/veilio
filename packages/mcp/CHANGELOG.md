# @veilio-inc/mcp

## 0.3.0

### Minor Changes

- [#67](https://github.com/veilio-inc/veilio/pull/67) [`93f091b`](https://github.com/veilio-inc/veilio/commit/93f091b2b3cb88340217672832ea17fbe74ebc00) Thanks [@DlgSHi](https://github.com/DlgSHi)! - Apply the account's custom rules outside the browser. `veilio rules pull` fetches your personal and team rules and `veilio scrub` applies them offline, stating on each run how many it applied and how old the copy is; `logout` removes the copy. The MCP server fetches them at startup and states their source on every anonymize result. Before, rules set in the web app were ignored by both, so the same code was masked differently.

### Patch Changes

- [#67](https://github.com/veilio-inc/veilio/pull/67) [`cfd7518`](https://github.com/veilio-inc/veilio/commit/cfd75183799c93d9fdbac3a4d25f44eeb88bb63e) Thanks [@DlgSHi](https://github.com/DlgSHi)! - Ship the Veilio Community License 1.1, which adds Section 5A: no license is granted in or from Russia or Belarus, to organizations established there, or to sanctioned persons.

- [#68](https://github.com/veilio-inc/veilio/pull/68) [`aac4077`](https://github.com/veilio-inc/veilio/commit/aac40770a711911d676f9d563f765e3e4722866c) Thanks [@DlgSHi](https://github.com/DlgSHi)! - Require `@veilio-inc/engine` 1.6.2. It carries two fixes both tools rely on: a whitelist rule now applies to names a map already holds, and restore no longer replaces a placeholder inside a longer number. With the old `^1.6.0` floor an install could resolve 1.6.1 and silently miss both.

- [#67](https://github.com/veilio-inc/veilio/pull/67) [`c212221`](https://github.com/veilio-inc/veilio/commit/c2122214af5597d31b4d9c2bce115c7732fed7f0) Thanks [@DlgSHi](https://github.com/DlgSHi)! - The MCP server reads the whole team namespace in one request (`GET /api/maps/team-envelopes`) instead of one request per team map, which ran into the maps rate limit on larger teams. A failed read reports the `local` namespace rather than a team namespace silently missing maps. Instances without the endpoint are still read one map at a time.

- [#67](https://github.com/veilio-inc/veilio/pull/67) [`15f8490`](https://github.com/veilio-inc/veilio/commit/15f8490620d227feb3cc3d560b1b8004715dfa76) Thanks [@DlgSHi](https://github.com/DlgSHi)! - A placeholder the team's saved maps give different identifiers is no longer guessed. The server leaves it out of the namespace it anonymizes with, and `restore_text` leaves it in the text with a warning instead of restoring whichever meaning the local store holds.

- [#67](https://github.com/veilio-inc/veilio/pull/67) [`9356a37`](https://github.com/veilio-inc/veilio/commit/9356a37aed1f3d1ad131a8add73cd2f2ca6669b7) Thanks [@DlgSHi](https://github.com/DlgSHi)! - Report the real version. `veilio --version` and the MCP server's `serverInfo` both said 0.1.0 while 0.2.0 was installed - the number was typed into the source and never moved with a release. Both now read it from their own package. `veilio --help` also lists `team unlock` and `team lock`, which it had left out.
- Updated dependencies [[`cfd7518`](https://github.com/veilio-inc/veilio/commit/cfd75183799c93d9fdbac3a4d25f44eeb88bb63e), [`f3afaff`](https://github.com/veilio-inc/veilio/commit/f3afaff14a4cc6124db6298fe634ad8e1768baec), [`93f091b`](https://github.com/veilio-inc/veilio/commit/93f091b2b3cb88340217672832ea17fbe74ebc00), [`fad8854`](https://github.com/veilio-inc/veilio/commit/fad8854a2cf3c3ef1584c6c362a27c92ae1d6160), [`aac4077`](https://github.com/veilio-inc/veilio/commit/aac40770a711911d676f9d563f765e3e4722866c), [`c212221`](https://github.com/veilio-inc/veilio/commit/c2122214af5597d31b4d9c2bce115c7732fed7f0), [`9356a37`](https://github.com/veilio-inc/veilio/commit/9356a37aed1f3d1ad131a8add73cd2f2ca6669b7)]:
  - @veilio-inc/cli@0.3.0

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
