# Changelog

## [1.13.0](https://github.com/veilio-inc/veilio/compare/engine-v1.12.1...engine-v1.13.0) (2026-10-28)

### Features

* **engine:** environment-style credentials in dotenv, YAML and shell files; fileKind and fileKindOf ([11f2d20](https://github.com/veilio-inc/veilio/commit/11f2d20af8dcf0794c7e8341968c3edbf2d5a6e4))

### Fixes

* **engine:** a quoted value stops at any assignment prefix and spans at most 16 KB ([fac9576](https://github.com/veilio-inc/veilio/commit/fac95765071500dcba72365ae6df42ae7bfcc2f9))
* **engine:** escaped and multi-line quoted values in the new rules ([f26b887](https://github.com/veilio-inc/veilio/commit/f26b88751b38431cbf86d6f664d88b41222c3ee6))
* **engine:** quoted values of any length in the new rules; an unclosed quote takes the rest of the line ([1bde3ab](https://github.com/veilio-inc/veilio/commit/1bde3ab18410bc840c1e7558d90d8c3ffadef7bc))
* **engine:** review of f26b887 - 1.12.1's grammar kept with no path; convention values judged; one-line quotes ([3b92110](https://github.com/veilio-inc/veilio/commit/3b921107ee3b4bbf467c8db31c6ab91536984a80))
* **engine:** security review of 2bc28d4 - paths read as paths, closed quotes span lines up to the next assignment, long fixed-name values in shell files ([123730b](https://github.com/veilio-inc/veilio/commit/123730b4b4321c9b60fa85347bd05f90e268699e)), closes [zebra#91](https://github.com/veilio-inc/zebra/issues/91)

### Refactoring

* **engine:** drop BARE_LONG, unused since the fixed-name rule is back on 1.12.1's grammar ([2bc28d4](https://github.com/veilio-inc/veilio/commit/2bc28d4e43f8c275664924b3a0e8f3442826c13e))

## [1.12.1](https://github.com/veilio-inc/veilio/compare/engine-v1.12.0...engine-v1.12.1) (2026-10-26)

### Fixes

* **engine:** a destroyed credential is redacted wherever else it appears, except a default word in a non-secret position ([a0a79f2](https://github.com/veilio-inc/veilio/commit/a0a79f2050c8467c66004215c2f148573af4b3eb))
* **engine:** a manual mark is refused on every credential found, whatever the policy ([7388918](https://github.com/veilio-inc/veilio/commit/738891868d66e7e0f544cadee584afb70f0aa8ad))
* **engine:** a name beside a credential is masked and mapped as usual; a name equal to a destroyed credential gets its redaction token ([f8e7293](https://github.com/veilio-inc/veilio/commit/f8e7293134eade6ce61611f053a162a0adfc1a70))
* **engine:** a redaction never splits a name or a placeholder, and runs before manual and regulated masks ([cf68dc3](https://github.com/veilio-inc/veilio/commit/cf68dc3beec72d6e30b41ac1c207a29c5dc9b2cf))
* **engine:** a weak password is never exempt by position, and a URL host is read after the last @ ([aef4054](https://github.com/veilio-inc/veilio/commit/aef4054726226ed8f169c5b6edf8eec0ad450e7e))
* **engine:** argv arrays keep 1.12.0's coverage, manual marks are refused only on destroyed credentials ([9ec44b1](https://github.com/veilio-inc/veilio/commit/9ec44b12ba6bfc89aba41cfac0ae42ad8857a647))
* **engine:** common prose words after --password are not passwords; a default-word password is redacted only where it stands ([f9ae1f8](https://github.com/veilio-inc/veilio/commit/f9ae1f86114656e12628e70e0c08554673514dcc))
* **engine:** common weak passwords keep word boundaries, and a URL host named like a default word stays ([0368c04](https://github.com/veilio-inc/veilio/commit/0368c04ab0e36daaadddb424a2604fd165401c49))
* **engine:** one --password rule in every file; credentials found in the text are dropped from an old map, and their numbers are not reused ([37b4609](https://github.com/veilio-inc/veilio/commit/37b46099d16f43ab4f0835c907b24194906b3a63))
* **engine:** only real placeholders are spared, and a regulated value that is a credential is never mapped ([b83d0a7](https://github.com/veilio-inc/veilio/commit/b83d0a7243461f2c277b688bf3d9bee4b89d95a5))
* **engine:** only tokens this call minted, and map keys, are spared by the spread ([77dd5ef](https://github.com/veilio-inc/veilio/commit/77dd5ef8c211ebd11958b14f036a08ffd426b16e))
* **engine:** spread redactions by merging every occurrence, so overlapping credentials leave no fragment ([9d42a24](https://github.com/veilio-inc/veilio/commit/9d42a24c66f8344b9db48d326b4259fb79afdcec))
* **engine:** spread redactions in one longest-first pass, and inside longer names and URLs ([07cea83](https://github.com/veilio-inc/veilio/commit/07cea83d746acac563143a7a22a782b6386b347e))

## [1.12.0](https://github.com/veilio-inc/veilio/compare/engine-v1.11.0...engine-v1.12.0) (2026-10-26)

### Features

* **engine:** passwords in a secret position are redacted whatever their strength, and only reported in test and example files ([11121ea](https://github.com/veilio-inc/veilio/commit/11121eac4d3a068939a907cea8fe1fa5ec8cb866))

### Fixes

* **engine:** --password in source and string literals is judged as a password; tighter metavar, code-root and overlap rules ([65b1014](https://github.com/veilio-inc/veilio/commit/65b101461df3979d433b5412bd86097ce0a42df7))
* **engine:** a credential never goes into the symbol map in any secrets mode; review fixes for the secret-position rules ([3efda33](https://github.com/veilio-inc/veilio/commit/3efda3379ab84c97b4ec4cd358cc33a4baca9e60))
* **engine:** a token carried as the user of a credential is redacted in every file ([f33b658](https://github.com/veilio-inc/veilio/commit/f33b658bcf24af57a060a8bd4b81465868fb2732))
* **engine:** an unknown option key such as `style` now throws instead of being stored in the symbol map ([9c765c1](https://github.com/veilio-inc/veilio/commit/9c765c11fc2073fcbec3455e07a94e2293aa2175))

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

## Notes on this file (written 2026-10-26)

These notes sit at the end on purpose. The release tool adds each new version
directly under the title, so a note at the top would end up between entries.

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
1.11.0 above were copied on 2026-10-26, word for word, from the GitHub Release
semantic-release made for each `engine-v*` tag. Each version's notes were
recovered; none is reconstructed or guessed.
