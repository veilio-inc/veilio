# @veilio-inc/engine

Two-way code anonymizer. Replace real identifiers in source code with role-typed
placeholder tokens (`__CLS__1`, `__FN__2`, …) **before** sending it to an LLM,
then restore them in the reply.

```ts
import { anonymize, restore } from '@veilio-inc/engine'

const { anonymized, map } = anonymize('class PaymentService { charge(orderId) {} }')
// anonymized → "class __CLS__1 { __FN__1(__VAR__1) {} }"
// ...send `anonymized` to an AI, get a reply that still contains the tokens...
const { restored } = restore(aiReply, map)
```

## If you would rather not write code

Two ready-made surfaces wrap this package, in the same repository. Both run the
engine in your own process, and neither opens a network connection.

|                                       |                                                                                                                                                  |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`@veilio-inc/cli`](../cli/README.md) | `veilio scrub \| pbcopy`, `restore`, and a `scan` that exits non-zero on a live credential — for pipes, pre-commit hooks and CI.                 |
| [`@veilio-inc/mcp`](../mcp/README.md) | An MCP server for coding agents. Its tools take a **file path**, so the server reads the file and the agent only ever sees `__CLS__1.__FN__2()`. |

They share one symbol map, so you can mask inside an agent and restore from a
terminal, or the reverse.

> Neither is on npm yet. They live here, they are tested here, and the install
> instructions land in the same commit that publishes them — a README that tells
> you to install something the registry does not have is worse than one that says
> nothing.

## Ten languages, not one

The engine masks every identifier it does not recognise, so the keyword set is
load-bearing: a missing reserved word gets masked, and masking `func` or `def`
leaves output no model can read as source code. Keyword sets and comment syntax
are per-language, and the language is detected from the source:

```ts
anonymize(goSource).language // → 'go'
anonymize(source, { language: 'rust' }) // or force it
```

Supported: TypeScript/JavaScript, Python, Go, Java/Kotlin, C#, Rust, Ruby, PHP,
C/C++, SQL. Detection falls back to TypeScript when the source is ambiguous, and
says so: `languageFallback` is `true` when no marker matched, which means the
file was tokenised with rules that do not describe it and the masking is
partial. It rides on the result rather than in UI state, so the web app, the CLI
and the MCP server all see the same fact rather than each deciding whether to
mention it.

Comments are never masked — they are prose, and turning them into ciphertext is
what makes a downstream model refuse to help. That applies to `#` comments,
Python docstrings, SQL `--`, and Ruby `=begin` blocks, not just `//`.

## Credential guard

Identifier masking protects a domain model. It does nothing about the leak that
actually costs money — a live key in the payload. Worse, a credential that
happens to be identifier-shaped would otherwise be masked _reversibly_, i.e.
stored in the symbol map.

So credentials are found before masking and replaced **irreversibly**:

```ts
const { anonymized, secrets } = anonymize(code)
// anonymized → 'const k = "__REDACTED_STRIPE_KEY_1__"'
// secrets    → [{ type: 'stripe-key', severity: 'critical', line: 1,
//                 preview: 'sk_l…MNOP (31 chars)', redacted: true }]
```

The replacement never enters the map, so `restore()` cannot bring it back. AWS,
Stripe, GitHub, Slack, OpenAI, Anthropic, Google and npm keys, JWTs, bearer
tokens, PEM private keys and connection-string passwords are redacted; emails
and private IPs are reported but left in place. Findings carry a truncated
preview, never the full value — they are rendered in UIs and may be logged.

Every finding also says what actually happened to the value, in `disposition`:
`'destroy'` (redacted, unrecoverable), `'mask'` (masked reversibly — see below),
or `'report'` (left exactly as written). `redacted` remains the coarse boolean a
badge can read; `disposition` is the finer answer.

Policy is configurable: `{ secrets: 'redact' }` (default), `'warn'`, or `'off'`.
Under `'warn'` nothing is acted on: findings come back with `disposition:
'report'` and the code unchanged.

## Regulated identifiers

A bank account or card number is not a credential — it is material a regulation
cares about, and it is what this tool is most often reached for. It is also not
an identifier a grammar produced, so `const iban = "GB29…"` had its **name**
masked and its **value** passed through verbatim.

Three formats are found by arithmetic over the value — never by inference, which
would cost the zero-dependency guarantee — and masked **reversibly**, into the
same map, so the round trip returns them:

| Finding        | Placeholder  | Confirmed by           |
| -------------- | ------------ | ---------------------- |
| `iban`         | `__IBAN__n`  | IBAN mod-97 check      |
| `payment-card` | `__PAN__n`   | issuer prefix and Luhn |
| `pesel`        | `__PESEL__n` | PESEL check digit      |

```ts
const { anonymized, map } = anonymize('const acct = "GB29NWBK60161331926819"')
// anonymized → 'const __VAR__1 = "__IBAN__1"'
// restore(anonymized, map).restored → the original line, account number included
```

Each format gets its own placeholder base rather than a shared one, because the
output's job is to be worked on by a model: "this is a bank account number" is
information it can use, where "this is a redacted something" is not. Published
test card numbers are not flagged at all — a fixture is not a leak.

Three rules bound what the reversibility can cost:

- **A credential wins.** Where a credential rule reads the same span — a
  password assignment, a connection string, a bearer token — the value is
  destroyed rather than masked, so it never reaches the map. An ambiguous
  verdict (`possible-credential`) is destroyed too: masking might write a live
  secret into the map, and reporting it would send that secret to the model
  verbatim.
- **A manual mark wins.** A value already marked by hand keeps its
  `__MANUAL__n` placeholder rather than gaining a second one.
- **They do not block a paste.** `hasBlockingSecrets` exists to stop a live
  credential reaching a model; refusing the billing code this tool was built for
  is not that.

Under `'warn'` and `'off'` these values are left in place like any other finding
— masking them is part of acting on a scan, not part of reporting one.

## Privacy & security properties

This package is the security-critical core of Veilio, and is designed to be
audited:

- **Local only.** No network calls, ever — it is a pure in-process transform.
- **No telemetry.** It reads no environment, sends no analytics.
- **Zero runtime dependencies.** Nothing is pulled in at install time.

These invariants are enforced in CI by `tests/purity.test.ts`.

> **Note (known limitation):** custom-rule patterns are compiled with `RegExp`.
> A pathological user-supplied pattern can backtrack (ReDoS). See the repo
> `SECURITY.md`. Treat rule patterns as untrusted input in hostile contexts.

## API

- `anonymize(code, options?)` → `{ anonymized, map, identifierCount, language, languageFallback, secrets, comments }`
  - `options.language` — a language name or `'auto'` (default)
  - `options.secrets` — `'redact'` (default) | `'warn'` | `'off'`
  - `options.existingMap` — continue numbering from a previous session
  - `options.rules` — whitelist / named-replacement rules
  - `options.manual` — literal strings to mask by hand (see below)
  - `comments` — `{ total, inline, characters, severity }`: how much comment
    prose left **unmasked**. Comments are prose and are deliberately not masked,
    which makes this the largest thing the engine does not do for you — reported
    rather than left to be discovered. `inline` counts blocks sitting after the
    file's first line of code; a licence header above it grades `low`, anything
    in the body grades `medium`, and it never goes higher: the engine cannot
    read the prose, so it never claims a comment _is_ sensitive. Consecutive
    line comments count as one block; blocks with no letters or digits in them,
    and placeholders standing in for terms already marked, are not counted.
  - **Throws `ManualMaskError`** when a term in `options.manual` scans as a
    credential, is already a placeholder, or is a keyword in the resolved
    language. Marks replayed from `existingMap` never throw — a mark made in one
    language must not make a file in another language impossible to anonymize.
- `restore(text, map, options?)` → `{ restored, strippedItems, strippedCount, report }`
  - `options.strip` — which AI artifacts to remove: `'all'` (default), `'none'`,
    or an explicit list of `StrippedItemType`. Worth setting: `'all'` deletes
    JSDoc, and when a model was *asked* to document its output that is
    destroying requested work rather than removing noise.
  - `report` — `{ resolved, missing, unresolved }`: which placeholders came back,
    which never appeared, and which placeholder-shaped tokens the map cannot
    explain. A model that renames `__FN__1` leaves no trace in the restored text,
    so this is the only place that failure is visible.
- `isPlaceholder(token)` → `boolean` — whether a string is a placeholder this
  engine could have produced. For validating a map that arrived from somewhere
  else before trusting its keys.
- `manualTermsIn(map)` → `string[]` — terms previously marked by hand
- `MANUAL_BASE` / `ManualMaskError` — the manual placeholder base, and the error
  thrown when a mark is refused

### Marking spans by hand

Custom rules can only rename identifiers the extractor already found. That
leaves out the two things most often needing masking: a name inside a comment,
and a bare account or case number. Both are prose as far as extraction is
concerned.

```ts
anonymize('// escalated by Kowalska, acct 88412037', {
  manual: ['Kowalska', '88412037'],
})
// → '// escalated by __MANUAL__1, acct __MANUAL__2'
```

Matching is literal, case-sensitive and longest-first, and runs before
extraction — so a marked token beats whatever role the classifier would have
given it. Marks are stored in the map under `__MANUAL__n`, which means
`restore()` reverses them with no special handling and they survive export,
import and sync without a second store. Pass `manualTermsIn(previousMap)` back
in, or just reuse the map as `existingMap`, and prior marks re-apply.

Three kinds of term are refused with a `ManualMaskError`:

- **A credential.** A manual mask is reversible and is written to the map, so
  masking a live key would persist the secret. Credentials take the one-way
  redaction path instead.
- **An existing placeholder.** Mapping one placeholder to another survives
  `anonymize` and then loses the real name on `restore`, which is a single pass.
- **A keyword in the resolved language.** Marks match literal text anywhere,
  which is the feature — and is why this case is catastrophic rather than merely
  wrong: marking `if` because you read it in a comment rewrites every `if` in the
  code and the file stops compiling.

A mark **replayed from `existingMap`** is never refused for being a keyword. A
map outlives the file it was made against — `def` is an ordinary word in a
TypeScript comment and is Python's grammar — so a stale mark is skipped, not
thrown on. It stays in the map and applies again where it is valid.

- `measureCommentExposure(code, language?)` → `CommentExposure` — the same
  measurement `anonymize` returns, for text it did not produce (after a manual
  mark is undone, say)
- `detectSecrets(code)` → `SecretFinding[]` — scan without modifying
- `scanSecrets(code, policy?)` → `{ findings, code, regulated }` — `regulated`
  holds the values handed to the masking pass; `anonymize` calls this first and
  masks them itself, so a caller doing its own masking is the only one that needs
  the field
- `REGULATED_BASES` — the placeholder base per regulated format
- `hasBlockingSecrets(findings)` / `summarizeSecrets(findings)`
- `detectLanguage(code)` / `guessLanguage(code)` → detection with a score
- `extractIdentifiers(code, language?)` → `string[]`
- `withAiPreamble(anonymized, map?)` / `AI_PREAMBLE` — a note to paste above masked
  code so a downstream AI treats the placeholders as intentional.

### Shared team namespaces

Used by the CLI and the MCP server so teammates agree on placeholders. The engine
holds one implementation because two copies can drift between the test asserting
they agree and the next commit, and the symptom would be a team silently forking
its numbering with both repositories green.

- `mergeTeamNamespace(entries)` / `TeamMapEntry` — merge team maps into one
  namespace, oldest first, so an edited map cannot steal a placeholder an older
  one already claimed
- `analyzeTeamNamespace(entries)` → `{ namespace, aliases, conflicts, highest }`
  — the same merge, plus what the merge had to decide: the placeholders two maps
  disagree about, the aliases that still restore, and the highest number per
  base so new names are minted above the team's
- `restoreLayers({ own, team })` → the one restore rule, shared by the web app,
  the CLI and the MCP server: the team's layer under this project's own, with
  `disputedIn(text)` and `locallyNumberedIn(text)` naming the placeholders that
  must be left alone rather than guessed. `disputedNote` / `locallyNumberedNote`
  render the message each caller shows
- `unwrapPrivateKey`, `deriveWrappingKey`, `importPublicKey`, `unwrapTeamKey`,
  `importTeamKey` / `exportTeamKey`, `decryptTeamMap`,
  `decryptTeamMapWithAny`, `TeamKeyError` — the **read** path for team-key
  envelopes. Minting a key, granting it to a teammate and confirming a
  teammate's key need a person present to approve them and stay in the browser:
  a client that can open maps has no business handing out access to them.

### Encrypted `.veilio` files and the vault

The crypto behind CE's export/import and Cloud's map sync lives here so both
editions run the same code — a second implementation of a format that has to
open files the first one wrote is a second thing to get subtly wrong. WebCrypto
only, no dependency added.

- `parseSymbolMap(raw)` → `SymbolMap` — validate an untrusted map before use;
  throws `InvalidMapError`
- `VeilioFile` / `KdfParams` / `parseKdfParams` — the `.veilio` envelope shape
  and its KDF parameters, `CURRENT_FILE_KDF` for what new files get and
  `LEGACY_FILE_KDF` for what older ones still open with
- `assertUsablePassphrase(value)` / `MIN_PASSPHRASE_LENGTH` / `WeakPassphraseError`
  — refuse a passphrase too weak for a file nobody can recover
- `VaultEnvelope` / `parseVaultEnvelope` / `VaultEnvelopeError`,
  `CURRENT_VAULT_KDF` / `LEGACY_VAULT_KDF`, `VAULT_SALT_BYTES`,
  `randomVaultSalt()` — the account vault a personal map is sealed under, so the
  server stores ciphertext it cannot read
- `webCryptoSubtle()`, `randomBytes(n)`, `toBase64` / `fromBase64` — the small
  platform layer the above are built on

A lost `.veilio` passphrase is not recoverable, by construction. Nothing here
holds an escrow copy and nothing in the format allows one.

## License

Veilio Community License 1.1 — **free to use for any purpose, including inside
your own business commercially.** You may not resell it, host it as a service for
others, rebrand it, or republish it as a product that competes with Veilio Cloud;
for that, contact `hello@veilio.dev`. See the `LICENSE` file. This is a
source-available, community-developed license, not an OSI-approved "open source"
license.
