# @veilio-inc/mcp

## 0.6.3

### Patch Changes

- [#176](https://github.com/veilio-inc/veilio/pull/176) [`21a2729`](https://github.com/veilio-inc/veilio/commit/21a27292561cf90bb4e5663176dbd4e9010184dc) Thanks [@DlgSHi](https://github.com/DlgSHi)! - `veilio scrub`, `veilio scan` and the MCP server's `anonymize_file` and `scan_secrets` tell the engine each file's kind (dotenv, YAML, shell), never its path, so every file is still judged strictly. In those files a strong credential assigned to an environment-style name - `DB_PASSWORD=…`, `GITHUB_TOKEN: …`, `export STRIPE_SECRET_KEY=…` - is redacted, quoted or not, and no piece of it reaches the symbol map; a weak one is handled as the quoted `password = "…"` form is (reported and left as written, or masked as a name when short). Requires `@veilio-inc/engine` 1.13.0 or later (the `fileKind` option). Text from stdin, or passed inline, has no file kind and is read as before.
- Updated dependencies [[`21a2729`](https://github.com/veilio-inc/veilio/commit/21a27292561cf90bb4e5663176dbd4e9010184dc)]:
  - @veilio-inc/cli@0.7.1

## 0.6.2

### Patch Changes

- [#167](https://github.com/veilio-inc/veilio/pull/167) [`163a28e`](https://github.com/veilio-inc/veilio/commit/163a28ea9ced8539f98f4e27f8302180dc178f6c) Thanks [@DlgSHi](https://github.com/DlgSHi)! - The README says when the server reads the team namespace again: after `veilio team unlock`, after a team map is created or updated or any map is removed through the server, after `projects_use` changes the project, and, with `VEILIO_PROJECT` set, when that name points to another project. It also says the server has two runtime dependencies, the engine and the CLI, both from this repository, and none from third parties. Before, it said "zero runtime dependencies".

- [#174](https://github.com/veilio-inc/veilio/pull/174) [`a1f796d`](https://github.com/veilio-inc/veilio/commit/a1f796dad19c50240b6c2277e1a7a3985bd58689) Thanks [@DlgSHi](https://github.com/DlgSHi)! - Requires `@veilio-inc/engine` 1.12.1 or later, which closes the redaction gaps found in 1.12.0.

- [#171](https://github.com/veilio-inc/veilio/pull/171) [`7d76614`](https://github.com/veilio-inc/veilio/commit/7d766143c2cda4a39a1a05f191759d0ff5ba81cc) Thanks [@DlgSHi](https://github.com/DlgSHi)! - Requires `@veilio-inc/engine` 1.12.0 or later: the engine that redacts passwords where they reappear and never stores a credential in the symbol map.

- [#173](https://github.com/veilio-inc/veilio/pull/173) [`265f140`](https://github.com/veilio-inc/veilio/commit/265f14001a20bd9619adf232c048ada70a80ff8d) Thanks [@DlgSHi](https://github.com/DlgSHi)! - The README says that `anonymize_file` and `scan_secrets` read every file strictly: a weak password in a secret position (`PGPASSWORD=Summer24`, a password flag, the password in a URL, an auth header) is redacted in test, fixture and example files too, as in the CLI and the Claude Code guard. The test that reads the home directory now sets up its own.
- Updated dependencies [[`1858b60`](https://github.com/veilio-inc/veilio/commit/1858b60d15c8ebc465d13635734afab40bbe7b6e), [`3169df0`](https://github.com/veilio-inc/veilio/commit/3169df0d15120f6543ed19b5a22a9b9cbdc5fd21), [`a1f796d`](https://github.com/veilio-inc/veilio/commit/a1f796dad19c50240b6c2277e1a7a3985bd58689), [`7d76614`](https://github.com/veilio-inc/veilio/commit/7d766143c2cda4a39a1a05f191759d0ff5ba81cc), [`265f140`](https://github.com/veilio-inc/veilio/commit/265f14001a20bd9619adf232c048ada70a80ff8d)]:
  - @veilio-inc/cli@0.7.0

## 0.6.1

### Patch Changes

- [#162](https://github.com/veilio-inc/veilio/pull/162) [`d8413e3`](https://github.com/veilio-inc/veilio/commit/d8413e3848da6ccd7bc115d52b14df0c1dfc7ed5) Thanks [@DlgSHi](https://github.com/DlgSHi)! - Requires `@veilio-inc/engine` 1.11.0 or later, the engine these packages are tested with.

- [#161](https://github.com/veilio-inc/veilio/pull/161) [`678afe2`](https://github.com/veilio-inc/veilio/commit/678afe26a1042fafc7735187ad43aebd6c1f9f3c) Thanks [@DlgSHi](https://github.com/DlgSHi)! - `VEILIO_PROJECT` in the server's environment pins its project. Set it in a repository's `.mcp.json` `env`, and an agent in that repository works in that project only, whatever `veilio projects use` stored for the shared sign-in.

  - The map tools, `team_status`, `projects_list` and the team namespace that `anonymize_*` and `restore_text` use all follow it. Results that name the project say "(from VEILIO_PROJECT)".
  - A value naming no project your team works in, or a name two projects share, makes those tools return an error naming it. The masking tools refuse rather than mask from the local map.
  - `projects_use` still stores a choice, and warns that the server's `VEILIO_PROJECT` overrides it.
  - Two servers in one HOME with different values scope independently.
  - The namespace is kept for the project's id, not for the value's spelling. If that project is renamed and another is given the old name while the server runs, the next `anonymize_*` or `restore_text` call after 30 s uses the new one (the check is one project listing, at most every 30 s, and only while the variable is set).
  - A masking call asks which project the variable names at most every 30 s, gives the listing 3 s, and masks from the cache when Cloud does not answer. `projects_use` leaves the namespace alone while the variable overrides it, and says the choice was saved, not that the server works in it.

- Updated dependencies [[`008b374`](https://github.com/veilio-inc/veilio/commit/008b3747cb03a3939e5a751936a6d33fb69b024b), [`d8413e3`](https://github.com/veilio-inc/veilio/commit/d8413e3848da6ccd7bc115d52b14df0c1dfc7ed5), [`678afe2`](https://github.com/veilio-inc/veilio/commit/678afe26a1042fafc7735187ad43aebd6c1f9f3c)]:
  - @veilio-inc/cli@0.6.1

## 0.6.0

### Minor Changes

- [#156](https://github.com/veilio-inc/veilio/pull/156) [`d0fa195`](https://github.com/veilio-inc/veilio/commit/d0fa195596481e28e0a4229238ac2a79591f6ddb) Thanks [@DlgSHi](https://github.com/DlgSHi)! - Map, team and project tools for a signed-in agent (spec 052): `maps_list`, `maps_pull`, `maps_create`, `maps_update`, `maps_remove`, `team_status`, `projects_list` and `projects_use`. Each runs the `veilio` CLI's own code and refuses in the same words.

  - With no sign-in, as in the Community Edition, the server lists only its five offline tools, exactly as before.
  - Removing a map, or an update that drops entries, is off unless the server is started with `VEILIO_MCP_DESTRUCTIVE=1`. Even then, a removal must repeat the map's exact name.
  - Personal maps open with the key `veilio vault unlock` keeps. The server never asks for or receives a passphrase.
  - No result contains a passphrase, a key, a wrapped key or an encrypted map. A clash names placeholders, never the real names behind them.
  - The team namespace reloads when the project changes, or after a team map is written through the server.

### Patch Changes

- [#156](https://github.com/veilio-inc/veilio/pull/156) [`44e5820`](https://github.com/veilio-inc/veilio/commit/44e5820acaece18cff2e7d10ff0102aea5b6036d) Thanks [@DlgSHi](https://github.com/DlgSHi)! - Every request to Veilio Cloud now names the program that sent it: `X-Veilio-Client: cli` with `User-Agent: veilio-cli/<version>` from the CLI, and `X-Veilio-Client: mcp` with `User-Agent: veilio-mcp/<version>` from the MCP server, which until now labelled its requests `cli`. Cloud logs both when it rate-limits a request. It is a self-report and never decides access.

- [#156](https://github.com/veilio-inc/veilio/pull/156) [`f4b74fd`](https://github.com/veilio-inc/veilio/commit/f4b74fd96d69763b279cd8f88993cb527971f08e) Thanks [@DlgSHi](https://github.com/DlgSHi)! - Fewer requests per command, so a scripted run or an agent no longer hits Cloud's maps rate limit. A team push or update now reads the listing once and the team's maps once, and gets the map being updated from that same read rather than downloading it again: three requests, down from five. A rate-limited answer (429) is no longer retried, because a retry only counts against the same limit. The MCP server reads the team namespace once per project, and again only after a team write or a change of project. Tests pin a request budget for each command against the built binary, over real HTTP.
- Updated dependencies [[`44e5820`](https://github.com/veilio-inc/veilio/commit/44e5820acaece18cff2e7d10ff0102aea5b6036d), [`d0fa195`](https://github.com/veilio-inc/veilio/commit/d0fa195596481e28e0a4229238ac2a79591f6ddb), [`f4b74fd`](https://github.com/veilio-inc/veilio/commit/f4b74fd96d69763b279cd8f88993cb527971f08e), [`d5b2ecd`](https://github.com/veilio-inc/veilio/commit/d5b2ecd08d3d5b5e16b5691832d84f1fd8f61d0c)]:
  - @veilio-inc/cli@0.6.0

## 0.5.2

### Patch Changes

- [#151](https://github.com/veilio-inc/veilio/pull/151) [`079a5e8`](https://github.com/veilio-inc/veilio/commit/079a5e831caed88d9e8acd65ce0347ea20bffa93) Thanks [@DlgSHi](https://github.com/DlgSHi)! - The MCP server's `anonymize_file` now masks a file the way `veilio scrub <file>` does: in the language its extension names, unless one is asked for, and with the names it takes from a public package left as written. Both use one shared rule, `@veilio-inc/cli/third-party`, so the two give the same placeholders for the same file. `anonymize_text` is unchanged: with no file and no project, it treats nothing as third-party, as `scrub` does on standard input.
- Updated dependencies [[`079a5e8`](https://github.com/veilio-inc/veilio/commit/079a5e831caed88d9e8acd65ce0347ea20bffa93), [`30c6dce`](https://github.com/veilio-inc/veilio/commit/30c6dcec72f2c75af13b02ffd8155d155522dc67)]:
  - @veilio-inc/cli@0.5.2

## 0.5.1

### Patch Changes

- [#99](https://github.com/veilio-inc/veilio/pull/99) [`6bc27cb`](https://github.com/veilio-inc/veilio/commit/6bc27cb04a72f3569452084b0dadf6b3cdbad5c6) Thanks [@DlgSHi](https://github.com/DlgSHi)! - A link or junction inside the project root that leads outside it is refused.

  `anonymize_file` and `scan_secrets` compared paths as text, so `link-outside/secret.txt` under the root read a file outside it when `link-outside` was a symlink or a Windows directory junction, which needs no admin rights. The server now also checks where a path really leads, and reads that resolved path. Links that stay inside the root, and a root that is itself reached through a link, still work. Reported from a Windows test session; the same applies to a symlink committed to a repository on any platform.

- [#99](https://github.com/veilio-inc/veilio/pull/99) [`5d046bd`](https://github.com/veilio-inc/veilio/commit/5d046bda4f3157562c858b8e0321e1de7c3a8335) Thanks [@DlgSHi](https://github.com/DlgSHi)! - The MCP server starts when it is run through `npx`, an npm bin link, a path with a space, or on Windows.

  The check that decides whether the file was run as a program compared `import.meta.url` with `file://` plus `argv[1]` as text. Through the symlink npx and npm use, from a path with a space, and for every Windows path, the two never matched: the server exited 0 without output and never answered `initialize`. This included the `npx -y @veilio-inc/mcp` set-up the README gives. The server now uses the same check as the CLI, which resolves the link and builds the URL the way Node does. Reported from a Windows test session; reproduced on macOS through `npx`.

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
