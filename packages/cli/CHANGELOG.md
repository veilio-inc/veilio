# @veilio-inc/cli

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
