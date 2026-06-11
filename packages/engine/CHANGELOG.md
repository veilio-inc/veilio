# Changelog

## 1.0.0

First release of `@dlgshi/engine`. This package supersedes the previously
published `@veilio/shared` 0.1.0 as the canonical, engine-only anonymizer.

### Added

- Stdlib builtins skiplist (~70 common method/global names such as `map`,
  `push`, `filter`, `then`, `parse`) — these are no longer masked, so
  anonymized output stays readable to the downstream AI.
- Comment-aware masking: comments are tokenized separately so prose is not
  scrambled into placeholders.
- `AI_PREAMBLE` / `withAiPreamble(anonymized)` — a note to paste above masked
  code so a downstream AI treats the placeholders as intentional.
- `anonymize(code, options)` accepts an `AnonymizeOptions` object (custom
  rules, existing map). The legacy `anonymize(code, existingMap)` call shape
  is still accepted for backward compatibility.
- Purity test suite (`tests/purity.test.ts`): no network, no env access,
  zero runtime dependencies — enforced in CI.

### Removed (migrating from `@veilio/shared` 0.1.0)

- `PLAN_LIMITS` and all Cloud product types (`Plan`, `User`, `Team`, …) are
  not part of this package. They were application concerns, not engine
  concerns; consumers should define them in their own app layer.

### Migration

Replace imports of `@veilio/shared` engine symbols with `@dlgshi/engine`:

```ts
import { anonymize, restore, withAiPreamble } from '@dlgshi/engine'
import type { SymbolMap, StrippedItem, CustomRule } from '@dlgshi/engine'
```

Persisted symbol maps from 0.1.0 remain fully compatible: `restore()`
resolves existing placeholders unchanged, and re-anonymizing with an
existing map never re-masks builtins (they simply stop being added).
