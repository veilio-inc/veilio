# @dlgshi/engine

Two-way code anonymizer. Replace real identifiers in source code with role-typed
placeholder tokens (`__CLS__1`, `__FN__2`, …) **before** sending it to an LLM,
then restore them in the reply.

```ts
import { anonymize, restore } from '@dlgshi/engine'

const { anonymized, map } = anonymize('class PaymentService { charge(orderId) {} }')
// anonymized → "class __CLS__1 { __FN__1(__VAR__1) {} }"
// ...send `anonymized` to an AI, get a reply that still contains the tokens...
const { restored } = restore(aiReply, map)
```

## Ten languages, not one

The engine masks every identifier it does not recognise, so the keyword set is
load-bearing: a missing reserved word gets masked, and masking `func` or `def`
leaves output no model can read as source code. Keyword sets and comment syntax
are per-language, and the language is detected from the source:

```ts
anonymize(goSource).language                  // → 'go'
anonymize(source, { language: 'rust' })       // or force it
```

Supported: TypeScript/JavaScript, Python, Go, Java/Kotlin, C#, Rust, Ruby, PHP,
C/C++, SQL. Detection falls back to TypeScript when the source is ambiguous.

Comments are never masked — they are prose, and turning them into ciphertext is
what makes a downstream model refuse to help. That applies to `#` comments,
Python docstrings, SQL `--`, and Ruby `=begin` blocks, not just `//`.

## Credential guard

Identifier masking protects a domain model. It does nothing about the leak that
actually costs money — a live key in the payload. Worse, a credential that
happens to be identifier-shaped would otherwise be masked *reversibly*, i.e.
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

- `anonymize(code, options?)` → `{ anonymized, map, identifierCount, language, secrets }`
  - `options.language` — a language name or `'auto'` (default)
  - `options.secrets` — `'redact'` (default) | `'warn'` | `'off'`
  - `options.style` — `'roles'` (default) | `'plain'` for legacy `__P<n>__`
  - `options.existingMap` — continue numbering from a previous session
  - `options.rules` — whitelist / named-replacement rules
- `restore(text, map)` → `{ restored, strippedItems, strippedCount }`
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
