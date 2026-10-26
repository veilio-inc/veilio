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

### Versions 1.3.0 to 1.11.0

The release tool stopped committing this file on 2026-09-02 (2f1fa5b), so the
copy in the repository skipped from 1.2.0 onwards. The entries for 1.3.0 to
1.11.0 below were copied on 2026-10-26, word for word, from the GitHub Release
semantic-release made for each `engine-v*` tag. Each version's notes were
recovered; none is reconstructed or guessed.

## [1.11.0](https://github.com/veilio-inc/veilio/compare/engine-v1.10.1...engine-v1.11.0) (2026-10-26)

### Features

* **engine:** export REDACTION_TOKENS (used by the guard) ([9e6c3f7](https://github.com/veilio-inc/veilio/commit/9e6c3f72606e85cbc09c8a289badc81184812193))

### Fixes

* **engine:** only a value of whole redaction tokens is not a credential ([1a48240](https://github.com/veilio-inc/veilio/commit/1a482407ceab2a4fad9023ccf8531d93936605fc))
* **engine:** the high-entropy rule reads a long word once ([61c7bdd](https://github.com/veilio-inc/veilio/commit/61c7bdda3943513998ea69e22d444576dc2d490f))
* **engine:** Veilio's own tokens are not credentials ([9d3f6d0](https://github.com/veilio-inc/veilio/commit/9d3f6d0165e70895ab88046be32509761321f11e))

## [1.10.1](https://github.com/veilio-inc/veilio/compare/engine-v1.10.0...engine-v1.10.1) (2026-10-24)

### Fixes

* **engine:** a Go qualifier after a dot is a field, not the package ([4dde6a6](https://github.com/veilio-inc/veilio/commit/4dde6a6c2ca7894063e5ee94d06f81fc8655d55b))
* **engine:** a project's own name is never read as an import ([89e53e1](https://github.com/veilio-inc/veilio/commit/89e53e12c50972b37753b905f94f95487eae7ea0))
* **engine:** every word in a shell script counts as declared; the scale check knows exemptions ([b0dded9](https://github.com/veilio-inc/veilio/commit/b0dded97fc6d5bfce38faa041e6fc2a866838657))

## [1.10.0](https://github.com/veilio-inc/veilio/compare/engine-v1.9.0...engine-v1.10.0) (2026-10-22)

### Features

* **engine:** seal a team map, not only open one ([3efe814](https://github.com/veilio-inc/veilio/commit/3efe8142839fada57e7dc0feb6977ea10f60ae11)), closes [#112](https://github.com/veilio-inc/veilio/issues/112) [#113](https://github.com/veilio-inc/veilio/issues/113) [#114](https://github.com/veilio-inc/veilio/issues/114) [#115](https://github.com/veilio-inc/veilio/issues/115)

## [1.9.0](https://github.com/veilio-inc/veilio/compare/engine-v1.8.2...engine-v1.9.0) (2026-10-16)

### Features

* **engine:** a masked Node stack trace reads as Node wrote it ([2a2d5b0](https://github.com/veilio-inc/veilio/commit/2a2d5b03ca15fb4e3a12147493e6065d36692c6c))
* **engine:** keep Math members and Error properties readable ([bcc6106](https://github.com/veilio-inc/veilio/commit/bcc610688c3ff0c607941ade9aca1b9e049bcd4e))

### Fixes

* **engine:** __proto__ round-trips instead of becoming [object Object] ([5111210](https://github.com/veilio-inc/veilio/commit/51112106518ed7cd216ed2b80768459e62f94d8b))
* **engine:** a stray quote after a URL cannot reach the next line ([f20136e](https://github.com/veilio-inc/veilio/commit/f20136e0eceefddc5d2591d0fe2cd1c964a30f0d))
* **engine:** the // of a URL is not a comment ([17cc264](https://github.com/veilio-inc/veilio/commit/17cc26479f75797a6e2c0fa1354c640b5e7a3bd7))
* **engine:** trust a node: frame only by its location, and CRLF traces ([5ce006b](https://github.com/veilio-inc/veilio/commit/5ce006b81b997904328d7ecaa3b7846a202c9a81))

## [1.8.2](https://github.com/veilio-inc/veilio/compare/engine-v1.8.1...engine-v1.8.2) (2026-10-04)

### Fixes

* **engine:** keep length and the function built-ins readable ([5e25f26](https://github.com/veilio-inc/veilio/commit/5e25f2621f5607b7c121793b2c16d4398a56a882))

## [1.8.1](https://github.com/veilio-inc/veilio/compare/engine-v1.8.0...engine-v1.8.1) (2026-10-01)

### Fixes

* **engine:** the restore note states the disagreement, not a cause it cannot know ([ae93534](https://github.com/veilio-inc/veilio/commit/ae9353413cc0d13fd1852a13cb45d2863ae96422))

## [1.8.0](https://github.com/veilio-inc/veilio/compare/engine-v1.7.0...engine-v1.8.0) (2026-09-30)

### Features

* **engine:** report placeholders whose shape the AI changed ([1683b00](https://github.com/veilio-inc/veilio/commit/1683b00149c6c4ea08ad1e00de5f3fb613f0b80d))

## [1.7.0](https://github.com/veilio-inc/veilio/compare/engine-v1.6.2...engine-v1.7.0) (2026-09-29)

### Features

* **engine:** one restore rule - restoreLayers, and analyzeTeamNamespace (spec 028) ([5e3c14e](https://github.com/veilio-inc/veilio/commit/5e3c14e9f4b3421555cf10aa9ab6fbd4f4f6f91b))

## [1.6.2](https://github.com/veilio-inc/veilio/compare/engine-v1.6.1...engine-v1.6.2) (2026-09-26)

### Fixes

* **engine:** a whitelist rule applies to names the map already holds ([7ecee5c](https://github.com/veilio-inc/veilio/commit/7ecee5cc3d1d20694ac8edf9f91aae233da62a67))
* **engine:** license 1.1 - no use in or from Russia or Belarus, or by sanctioned persons ([cfd7518](https://github.com/veilio-inc/veilio/commit/cfd75183799c93d9fdbac3a4d25f44eeb88bb63e))
* **engine:** restore never matches a placeholder inside a longer number ([b960f21](https://github.com/veilio-inc/veilio/commit/b960f2181320a508127f06c2325fd90302d92d86))

## [1.6.1](https://github.com/veilio-inc/veilio/compare/engine-v1.6.0...engine-v1.6.1) (2026-09-24)

### Fixes

* **engine:** a value any rule reads as a credential is never masked reversibly ([#65](https://github.com/veilio-inc/veilio/issues/65)) ([a213a34](https://github.com/veilio-inc/veilio/commit/a213a34af76ac971103c6c832334c95c2ba2f41c)), closes [#58](https://github.com/veilio-inc/veilio/issues/58) [#58](https://github.com/veilio-inc/veilio/issues/58)

## [1.6.0](https://github.com/veilio-inc/veilio/compare/engine-v1.5.0...engine-v1.6.0) (2026-09-23)

### Features

* **engine:** regulated identifiers round-trip instead of being destroyed ([#58](https://github.com/veilio-inc/veilio/issues/58)) ([910fee1](https://github.com/veilio-inc/veilio/commit/910fee18afb9ca3543ddbce08161ad582469dd87))

## [1.5.0](https://github.com/veilio-inc/veilio/compare/engine-v1.4.0...engine-v1.5.0) (2026-09-04)

### Features

* **engine:** move the .veilio envelope crypto where both editions can reach it ([d185186](https://github.com/veilio-inc/veilio/commit/d18518619a853a353c4e61e27ba98c69d0502a3e))

### Fixes

* **engine:** sync to the 1.4.0 that shipped, and stop cutting versions with no diff ([7e9da1e](https://github.com/veilio-inc/veilio/commit/7e9da1e1b0e47fa62710d1067560fd93841a9cdf))

## [1.4.0](https://github.com/veilio-inc/veilio/compare/engine-v1.3.0...engine-v1.4.0) (2026-09-03)

### Features

* **engine:** single-pass substitution, restore options, wider secret coverage ([f01000d](https://github.com/veilio-inc/veilio/commit/f01000d88c25b3dffc126741dc34860bc3f9f255))

## [1.3.0](https://github.com/veilio-inc/veilio/compare/engine-v1.2.0...engine-v1.3.0) (2026-09-02)

### Features

* **engine:** count the comment prose that leaves unmasked ([08f44e7](https://github.com/veilio-inc/veilio/commit/08f44e7e90503647ad44cf8a05842d6d840edd01))
* **engine:** say when a file's language was not recognised ([0375da6](https://github.com/veilio-inc/veilio/commit/0375da60aadcd6788a9e724a3f23e873fed5e310))
* **secrets:** detect regulated identifiers by checksum, not by guessing ([a1dbc37](https://github.com/veilio-inc/veilio/commit/a1dbc37fcf75997350af4545bd41c3a5a05fa32b))
* **secrets:** make the advisory panel worth reading ([84c90b8](https://github.com/veilio-inc/veilio/commit/84c90b8d30ae81b19b7679d04b4653addf0e6e30))

### Fixes

* **engine:** stop a saved mark from making the next file unanonymizable ([8aedfd2](https://github.com/veilio-inc/veilio/commit/8aedfd2ebe56814abfe1de0b7193859dfa1631a1))

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
