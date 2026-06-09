# @dlgshi/engine

Two-way code anonymizer. Replace real identifiers in source code with
placeholder tokens (`__P1__`, `__P2__`, …) **before** sending it to an LLM, then
restore them in the reply.

```ts
import { anonymize, restore } from '@dlgshi/engine'

const { anonymized, map } = anonymize('class PaymentService { charge(orderId) {} }')
// anonymized → "class __P1__ { __P2__(__P3__) {} }"
// ...send `anonymized` to an AI, get a reply that still contains the tokens...
const { restored } = restore(aiReply, map)
```

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

- `anonymize(code, options?)` → `{ anonymized, map, identifierCount }`
- `restore(text, map)` → `{ restored, strippedItems, strippedCount }`
- `extractIdentifiers(code)` → `string[]`
- `withAiPreamble(anonymized)` / `AI_PREAMBLE` — a note to paste above masked code
  so a downstream AI treats the placeholders as intentional.

## License

MIT
