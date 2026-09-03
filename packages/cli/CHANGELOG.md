# @veilio-inc/cli

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
