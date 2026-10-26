# Changelog

## Record of what this file left out (written 2026-10-26)

### Removed before 1.0.0: `options.style`

`anonymize(code, { style })` took `'roles'` (role-typed placeholders such as
`__CLS__1`) or `'plain'` (the old `__P<n>__` numbering). It was removed in
[a5c494b](https://github.com/veilio-inc/veilio/commit/a5c494b0f992974779b9369c81d9dda6eff81cf9)
on 2026-07-29, before 1.0.0. Every version names its placeholders by role.

This file never recorded the removal. The README kept listing the option in
every published version from 1.0.0 to 1.7.0, and 1.8.0 was the first without
it. In those versions, `{ style: 'plain' }` was not refused. Its value is a
string, so the engine read the object as an existing symbol map, and the key
was stored in the map.

### Versions 1.3.0 to 1.10.1

Their release notes are on GitHub Releases, under the `engine-v*` tags:
<https://github.com/veilio-inc/veilio/releases>. The release tool writes each
version's notes into the published package, but it no longer commits this
file, so the copy in the repository skips from 1.2.0 to the latest release.

## [1.2.0](https://github.com/veilio-inc/veilio/compare/engine-v1.1.0...engine-v1.2.0) (2026-08-15)

### Features

* **engine:** expose isPlaceholder for validating untrusted maps ([fe4794c](https://github.com/veilio-inc/veilio/commit/fe4794c43c49feb7daebf19c08063f67e09c95cb))

## [1.1.0](https://github.com/veilio-inc/veilio/compare/engine-v1.0.1...engine-v1.1.0) (2026-08-13)

### Features

* **engine:** mask author-marked spans and report restore failures ([cc6cd87](https://github.com/veilio-inc/veilio/commit/cc6cd87a9668eff6ec9b25d99c68505991e671a3))

## [1.0.1](https://github.com/veilio-inc/veilio/compare/engine-v1.0.0...engine-v1.0.1) (2026-08-09)

### Build

* **release:** generate engine versions with semantic-release ([85d55af](https://github.com/veilio-inc/veilio/commit/85d55af269fe15db41051fd7d01dc8d8cf5fea06))

## 1.0.0

First release of `@veilio-inc/engine` — a two-way code anonymizer that replaces real
identifiers with placeholder tokens before source code is sent to an LLM, and
restores them in the answer.

### Anonymize and restore

- `anonymize(code, options)` returns the masked code and the symbol map.
  Identifiers are replaced with role-typed placeholders (`__CLS__1`, `__FN__2`,
  `__VAR__3`) so the output still reads as code to a model.
- `restore(text, map, options)` puts the real names back, and can strip
  AI-generated noise (JSDoc, TODO comments, narration) on the way through.
- `withAiPreamble(anonymized)` / `AI_PREAMBLE` prepend a note telling the model
  the placeholders are intentional.

### Languages

Ten, with per-language keyword sets and comment syntax, detected from the source
or set explicitly: TypeScript/JavaScript, Python, Go, Java, C#, Rust, Ruby, PHP,
C, and SQL. Reserved words are never masked — masking `func` or `def` would
leave output no model can read.

A 105-name skiplist is left intact for the same reason: generic identifiers
(`args`, `fn`, `obj`, `val`) and common stdlib methods (`map`, `push`,
`filter`). Masking these carries no information and costs readability.

### Credentials are redacted, not masked

`detectSecrets` / `scanSecrets` recognize 33 credential patterns — AWS, GCP,
Azure, Stripe, GitHub, Slack, OpenAI, Anthropic, private-key blocks, JWTs and
more. A detected credential is replaced irreversibly and **never enters the
symbol map**, so `restore()` cannot bring it back and a shared map can never
carry a live key. A reversible mask on a secret would store the secret.

Emails and private IPs are reported at `medium` severity but left in place —
only `critical` and `high` findings are redacted, and only those block.

`medium` also carries `possible-credential`: a value that is credential-shaped
but could equally be configuration, such as `client_secret: "disabled"` next to
`password = "correcthorse"`. Nothing in the syntax separates those two, so the
engine reports the ambiguity rather than guessing. Reporting is the safe side of
that call — redaction is irreversible by design, so a wrong guess would corrupt
code that `restore()` can never repair, while a wrong warning costs a line in a
panel. Values that are unambiguously credentials, including a lower-case
password inside a connection string or an `Authorization` header, stay at `high`
and are still redacted.

### Comment-aware masking

Comments are tokenized separately, so prose is not scrambled into placeholders.

### Privacy invariants

Pure, local transform: **no network, no telemetry, no environment reads, zero
runtime dependencies.** Enforced by `tests/purity.test.ts` in CI, not promised in
a README — for a package that reads your source code, the supply chain is the
product.
