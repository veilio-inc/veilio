# @veilio-inc/cli

## 0.5.0

### Minor Changes

- [#86](https://github.com/veilio-inc/veilio/pull/86) [`2df75b5`](https://github.com/veilio-inc/veilio/commit/2df75b5a34da240a209baab6a96726d946b8eadd) Thanks [@DlgSHi](https://github.com/DlgSHi)! - `veilio scrub` numbers from the team's namespace when signed in, as the web app and the MCP server do.

  A staging walk found a team member's terminal giving `reverseEntry` the placeholder the team uses for `settleInvoice`: `scrub` numbered from the project's own map only. Now, signed in to a team with the key unlocked:
  - a name the team knows gets the team's placeholder;
  - a new name is numbered above the team's and the project's highest;
  - only the team entries the output uses are kept;
  - the summary says `Namespace: team`.

  When the team's maps cannot be used, `scrub` says so and why, also under `--quiet`, and still masks from the project's map. That covers a locked key, Cloud being unreachable, and no answer within 5 seconds. Signed out, it makes no request, as before. The composition is shared with the MCP server's anonymize tools, so the two give identical placeholders for the same input.

## 0.4.0

### Minor Changes

- [#82](https://github.com/veilio-inc/veilio/pull/82) [`d833bff`](https://github.com/veilio-inc/veilio/commit/d833bff344c63f3d6a3e1593618c75814ba86feb) Thanks [@DlgSHi](https://github.com/DlgSHi)! - Name the placeholders the AI changed the shape of, and let a pipeline or an agent refuse a restore that would leave any placeholder behind.

  - A placeholder whose case or underscores the model changed (`__fn__1`, `_FN__1`) was passed through without a word; no map can restore it. `veilio restore` now names it on stderr (also under `--quiet`), and `restore_text` names it in a WARNING line. The rule is the engine's (`report.altered`, engine 1.8.0), so the web app says the same.
  - `veilio restore --strict`: if a placeholder would be left in the text (invented, altered, disputed between the team's maps, numbered locally), nothing is written to stdout, they are named, and it exits 1. A credential redacted on purpose never fails it.
  - `restore_text { strict: true }`: the same rule; an error result carrying the report and no text.

  Needs `@veilio-inc/engine` 1.8.0 or later (the floor is raised when the engine is published).

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

## 0.3.0

### Minor Changes

- [#67](https://github.com/veilio-inc/veilio/pull/67) [`93f091b`](https://github.com/veilio-inc/veilio/commit/93f091b2b3cb88340217672832ea17fbe74ebc00) Thanks [@DlgSHi](https://github.com/DlgSHi)! - Apply the account's custom rules outside the browser. `veilio rules pull` fetches your personal and team rules and `veilio scrub` applies them offline, stating on each run how many it applied and how old the copy is; `logout` removes the copy. The MCP server fetches them at startup and states their source on every anonymize result. Before, rules set in the web app were ignored by both, so the same code was masked differently.

### Patch Changes

- [#67](https://github.com/veilio-inc/veilio/pull/67) [`cfd7518`](https://github.com/veilio-inc/veilio/commit/cfd75183799c93d9fdbac3a4d25f44eeb88bb63e) Thanks [@DlgSHi](https://github.com/DlgSHi)! - Ship the Veilio Community License 1.1, which adds Section 5A: no license is granted in or from Russia or Belarus, to organizations established there, or to sanctioned persons.

- [#67](https://github.com/veilio-inc/veilio/pull/67) [`f3afaff`](https://github.com/veilio-inc/veilio/commit/f3afaff14a4cc6124db6298fe634ad8e1768baec) Thanks [@DlgSHi](https://github.com/DlgSHi)! - `veilio login` now works on an account with two-factor authentication: it asks for the authentication code (or a recovery code) and completes the sign-in. Before, it stored the short-lived challenge instead of a session and then reported the password as wrong.

- [#67](https://github.com/veilio-inc/veilio/pull/67) [`fad8854`](https://github.com/veilio-inc/veilio/commit/fad8854a2cf3c3ef1584c6c362a27c92ae1d6160) Thanks [@DlgSHi](https://github.com/DlgSHi)! - `veilio maps pull` opens a team map. It used the vault key for every map and failed on a team map with "Unrecognized vault envelope"; a team map now opens with the team key `veilio team unlock` stored, without asking for the vault passphrase. With no team key unlocked it says to run `veilio team unlock`, and it writes nothing it could not open.

- [#68](https://github.com/veilio-inc/veilio/pull/68) [`aac4077`](https://github.com/veilio-inc/veilio/commit/aac40770a711911d676f9d563f765e3e4722866c) Thanks [@DlgSHi](https://github.com/DlgSHi)! - Require `@veilio-inc/engine` 1.6.2. It carries two fixes both tools rely on: a whitelist rule now applies to names a map already holds, and restore no longer replaces a placeholder inside a longer number. With the old `^1.6.0` floor an install could resolve 1.6.1 and silently miss both.

- [#67](https://github.com/veilio-inc/veilio/pull/67) [`c212221`](https://github.com/veilio-inc/veilio/commit/c2122214af5597d31b4d9c2bce115c7732fed7f0) Thanks [@DlgSHi](https://github.com/DlgSHi)! - The MCP server reads the whole team namespace in one request (`GET /api/maps/team-envelopes`) instead of one request per team map, which ran into the maps rate limit on larger teams. A failed read reports the `local` namespace rather than a team namespace silently missing maps. Instances without the endpoint are still read one map at a time.

- [#67](https://github.com/veilio-inc/veilio/pull/67) [`9356a37`](https://github.com/veilio-inc/veilio/commit/9356a37aed1f3d1ad131a8add73cd2f2ca6669b7) Thanks [@DlgSHi](https://github.com/DlgSHi)! - Report the real version. `veilio --version` and the MCP server's `serverInfo` both said 0.1.0 while 0.2.0 was installed - the number was typed into the source and never moved with a release. Both now read it from their own package. `veilio --help` also lists `team unlock` and `team lock`, which it had left out.

## 0.2.0

### Minor Changes

- [#61](https://github.com/veilio-inc/veilio/pull/61) [`9694e6d`](https://github.com/veilio-inc/veilio/commit/9694e6d22c2e732a905a73fa3066c718a65ed123) Thanks [@DlgSHi](https://github.com/DlgSHi)! - Sign in to Veilio Cloud and sync personal maps from the terminal.

  `veilio login` prompts for credentials and writes a session token to a single
  file under your home directory; `veilio whoami` reads it without making a
  request, and `veilio logout` revokes server-side before removing it. `veilio
maps list`, `maps pull <id>` and `maps push <name>` move maps between the local
  store and Cloud.

  Map sync is zero-knowledge. The vault key is derived locally from your
  passphrase with PBKDF2-SHA256 and the server holds only a per-account salt, so
  Cloud stores ciphertext it cannot read. `maps pull` decrypts locally and writes
  second, so an interrupted pull never leaves a partial map.

  `scrub`, `restore`, `scan` and `map` are unchanged and still make no network
  call. Signing in adds nothing to them; it only unlocks the commands that name
  Cloud explicitly.

### Patch Changes

- [#61](https://github.com/veilio-inc/veilio/pull/61) [`9694e6d`](https://github.com/veilio-inc/veilio/commit/9694e6d22c2e732a905a73fa3066c718a65ed123) Thanks [@DlgSHi](https://github.com/DlgSHi)! - Read piped stdin correctly across sequential prompts.

  `veilio login` asks for an email and then a password. Given piped input it
  consumed the whole stream on the first prompt, so the second saw nothing and the
  command exited 0 having done nothing at all — the worst shape a failure can
  take, because a script checking the exit code concludes it worked.

  Prompts now take one line each from the stream. The regression got past a test
  suite that mocked stdin rather than piping to a real process, so the fix ships
  with a test that spawns the binary and pipes to it.

## 0.1.0

First public release.

`veilio scrub`, `restore` and `scan` — anonymize identifiers and redact
credentials before code reaches an LLM, then restore them afterwards. For pipes,
pre-commit hooks and CI.

Runs entirely in your own process: no account, no API key, and no network call on
any command. `tests/purity.test.ts` traps the network globals and fails if one is
ever introduced.

Written by hand rather than generated. Changesets writes this file during
`changeset version`, and this release deliberately skips that step — the package
had never been published, so `0.1.0` was free and `changeset publish` takes it
straight from the manifest. Entries from the next release onward are generated
above this one.
