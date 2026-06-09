# Security Policy

## Reporting a vulnerability

Please report security issues **privately** — do not open a public issue for
anything exploitable.

- Preferred: GitHub **Private vulnerability reporting** (this repo → **Security**
  tab → *Report a vulnerability*).
- Or email: `security@veilio.dev`  <!-- TODO: confirm/replace with the real inbox -->

We aim to acknowledge within 72 hours and to ship fixes for confirmed issues in
the anonymization engine promptly, since it is the privacy-critical core.

## Scope and known limitations

### `@dlgshi/engine` privacy invariants
The engine is a pure, local transform: **no network, no telemetry, no
environment reads, zero runtime dependencies.** These are enforced in CI
(`packages/engine/tests/purity.test.ts`). A change that violates them should be
treated as a security regression.

### Known limitation — ReDoS via custom-rule patterns
Custom rules compile **user-supplied** regular expressions
(`new RegExp(rule.pattern)`). A pathological pattern can cause catastrophic
backtracking (ReDoS) and hang the thread that runs it. Today the engine guards
patterns for *validity* (try/catch) but **not** for *complexity*.

- In the first-party apps the pattern author is the authenticated user editing
  their own rules, so the blast radius is self-inflicted.
- If you embed `@dlgshi/engine` somewhere that compiles **untrusted** rule
  patterns, treat them as hostile input (length-cap them, run on a worker with a
  timeout, or pre-validate with a non-backtracking matcher such as RE2).

A hardening follow-up (bounded execution for rule patterns) is tracked separately.

### Anonymization is best-effort
The engine reduces, but cannot guarantee elimination of, identifying information
(e.g. identifiers embedded in unusual string formats). Always review anonymized
output before sharing it.
