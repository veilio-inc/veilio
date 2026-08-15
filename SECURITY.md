# Security Policy

## Reporting a vulnerability

Please report security issues **privately** — do not open a public issue for
anything exploitable.

- Preferred: GitHub **Private vulnerability reporting** (this repo → **Security**
  tab → *Report a vulnerability*).
- Or email: `security@veilio.dev` 

We aim to acknowledge within 72 hours and to ship fixes for confirmed issues in
the anonymization engine promptly, since it is the privacy-critical core.

## Scope and known limitations

### `@veilio-inc/engine` privacy invariants
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
- If you embed `@veilio-inc/engine` somewhere that compiles **untrusted** rule
  patterns, treat them as hostile input (length-cap them, run on a worker with a
  timeout, or pre-validate with a non-backtracking matcher such as RE2).

A hardening follow-up (bounded execution for rule patterns) is tracked separately.

### Imported symbol maps are authenticated, not trusted
A `.veilio` file is encrypted with AES-256-GCM, so decrypting one proves the
author knew the passphrase. Sharing maps with colleagues is the point of the
format, so that proves the author was someone you gave the passphrase to — **not
that the contents are what you expect.** Everything in a map is substituted into
restored source, which you then read and often paste into an editor.

On import the app validates the decrypted map before it reaches a restore
(`src/lib/importedMap.ts`): keys must be placeholder-shaped, values must be
strings, and both the entry count and value length are bounded. This makes a
malformed or hostile file fail loudly at the boundary instead of quietly
deforming a restore, and it is what refuses prototype-pollution keys such as
`__proto__`.

It does **not** make an imported map safe. A well-formed map from someone else
can still map `__FN__1` to text you did not write. Import maps only from people
you would accept a patch from, and read restored output before running it.

### Export passphrases have a floor, not a strength guarantee
A `.veilio` file is the one artifact designed to leave the machine, so once it
has, its passphrase is attacked offline at whatever rate the attacker's hardware
allows. New exports are derived with PBKDF2-HMAC-SHA256 at 600,000 iterations
(recorded per-file, so the cost can be raised without orphaning old files), and
exports require a passphrase of at least 12 characters that is not a trivially
guessable pattern.

That is a floor. It rejects choices that are bad by construction; it cannot tell
that an otherwise-valid passphrase is a poor one, and the app deliberately shows
no strength score rather than implying approval it cannot give.

The floor is **not** applied on import: a file written by an older build may be
protected by a passphrase that would now be rejected, and refusing to open it
would be data loss.

### Anonymization is best-effort
The engine reduces, but cannot guarantee elimination of, identifying information
(e.g. identifiers embedded in unusual string formats). Always review anonymized
output before sharing it.
