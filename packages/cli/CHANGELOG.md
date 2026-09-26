# @veilio-inc/cli

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
