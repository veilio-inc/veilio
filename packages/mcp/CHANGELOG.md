# @veilio-inc/mcp

## 0.5.0

### Minor Changes

- [#86](https://github.com/veilio-inc/veilio/pull/86) [`2df75b5`](https://github.com/veilio-inc/veilio/commit/2df75b5a34da240a209baab6a96726d946b8eadd) Thanks [@DlgSHi](https://github.com/DlgSHi)! - `veilio scrub` numbers from the team's namespace when signed in, as the web app and the MCP server do.

  A staging walk found a team member's terminal giving `reverseEntry` the placeholder the team uses for `settleInvoice`: `scrub` numbered from the project's own map only. Now, signed in to a team with the key unlocked:
  - a name the team knows gets the team's placeholder;
  - a new name is numbered above the team's and the project's highest;
  - only the team entries the output uses are kept;
  - the summary says `Namespace: team`.

  When the team's maps cannot be used, `scrub` says so and why, also under `--quiet`, and still masks from the project's map. That covers a locked key, Cloud being unreachable, and no answer within 5 seconds. Signed out, it makes no request, as before. The composition is shared with the MCP server's anonymize tools, so the two give identical placeholders for the same input.

### Patch Changes

- Updated dependencies [[`2df75b5`](https://github.com/veilio-inc/veilio/commit/2df75b5a34da240a209baab6a96726d946b8eadd)]:
  - @veilio-inc/cli@0.5.0

## 0.4.0

### Minor Changes

- [#82](https://github.com/veilio-inc/veilio/pull/82) [`d833bff`](https://github.com/veilio-inc/veilio/commit/d833bff344c63f3d6a3e1593618c75814ba86feb) Thanks [@DlgSHi](https://github.com/DlgSHi)! - Name the placeholders the AI changed the shape of, and let a pipeline or an agent refuse a restore that would leave any placeholder behind.

  - A placeholder whose case or underscores the model changed (`__fn__1`, `_FN__1`) was passed through without a word; no map can restore it. `veilio restore` now names it on stderr (also under `--quiet`), and `restore_text` names it in a WARNING line. The rule is the engine's (`report.altered`, engine 1.8.0), so the web app says the same.
  - `veilio restore --strict`: if a placeholder would be left in the text (invented, altered, disputed between the team's maps, numbered locally), nothing is written to stdout, they are named, and it exits 1. A credential redacted on purpose never fails it.
  - `restore_text { strict: true }`: the same rule; an error result carrying the report and no text.

  Needs `@veilio-inc/engine` 1.8.0 or later (the floor is raised when the engine is published).

### Patch Changes

- Updated dependencies [[`d833bff`](https://github.com/veilio-inc/veilio/commit/d833bff344c63f3d6a3e1593618c75814ba86feb)]:
  - @veilio-inc/cli@0.4.0

## 0.3.2

### Patch Changes

- [#75](https://github.com/veilio-inc/veilio/pull/75) [`6b4cbaa`](https://github.com/veilio-inc/veilio/commit/6b4cbaae9ec5658ec86ce67d69e0bac05305cc1b) Thanks [@DlgSHi](https://github.com/DlgSHi)! - Document what 0.3.1 actually does. Both READMEs described the tools as they were
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

- Updated dependencies [[`6b4cbaa`](https://github.com/veilio-inc/veilio/commit/6b4cbaae9ec5658ec86ce67d69e0bac05305cc1b)]:
  - @veilio-inc/cli@0.3.2

## 0.3.1

### Patch Changes

- [#72](https://github.com/veilio-inc/veilio/pull/72) [`d728fa3`](https://github.com/veilio-inc/veilio/commit/d728fa34362e84e97bd9f4c7c2ce6c0fa1588039) Thanks [@DlgSHi](https://github.com/DlgSHi)! - One restore rule for the web app, the CLI and the MCP server.

  Requires `@veilio-inc/engine` 1.7.0 (`restoreLayers`, `analyzeTeamNamespace`), released by semantic-release from the engine commit.

  - **cli:** `veilio restore` now restores a teammate's placeholders from the team's maps.
    - A disputed or locally numbered placeholder is left and named, never guessed.
    - With the team key locked, it says to run `veilio team unlock`.
    - Signed out, it makes no network request. Signed in, it waits for Cloud for 5 seconds at most.
    - The counts are measured against this project's map.
  - **mcp:**
    - `restore_text` follows the same rule, and aliases now restore.
    - A locked or unreadable team gives an error result that says why, and the namespace line says why it is `local`.
    - A `veilio team unlock` run after the server started is picked up without a restart.
    - Anonymizing after a lapse uses the team's placeholders instead of the ones the project numbered during the lapse, which teammates would have restored to a different identifier.

- Updated dependencies [[`d728fa3`](https://github.com/veilio-inc/veilio/commit/d728fa34362e84e97bd9f4c7c2ce6c0fa1588039)]:
  - @veilio-inc/cli@0.3.1

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
