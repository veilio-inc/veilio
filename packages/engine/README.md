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
C/C++, SQL. Detection falls back to TypeScript when the source is ambiguous.

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

Policy is configurable: `{ secrets: 'redact' }` (default), `'warn'`, or `'off'`.

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

- `anonymize(code, options?)` → `{ anonymized, map, identifierCount, language, secrets, comments }`
  - `options.language` — a language name or `'auto'` (default)
  - `options.secrets` — `'redact'` (default) | `'warn'` | `'off'`
  - `options.style` — `'roles'` (default) | `'plain'` for legacy `__P<n>__`
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
- `restore(text, map)` → `{ restored, strippedItems, strippedCount, report }`
  - `report` — `{ resolved, missing, unresolved }`: which placeholders came back,
    which never appeared, and which placeholder-shaped tokens the map cannot
    explain. A model that renames `__FN__1` leaves no trace in the restored text,
    so this is the only place that failure is visible.
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
- `scanSecrets(code, policy?)` → `{ findings, code }`
- `hasBlockingSecrets(findings)` / `summarizeSecrets(findings)`
- `detectLanguage(code)` / `guessLanguage(code)` → detection with a score
- `extractIdentifiers(code, language?)` → `string[]`
- `withAiPreamble(anonymized, map?)` / `AI_PREAMBLE` — a note to paste above masked
  code so a downstream AI treats the placeholders as intentional.

## License

Veilio Community License 1.0 — **free to use for any purpose, including inside
your own business commercially.** You may not resell it, host it as a service for
others, rebrand it, or republish it as a product that competes with Veilio Cloud;
for that, contact `hello@veilio.dev`. See the `LICENSE` file. This is a
source-available, community-developed license, not an OSI-approved "open source"
license.
