# Veilio Constitution

Veilio replaces real identifiers in source code with role-typed placeholders before
that code is shown to an LLM, and puts them back afterwards. Everything below
follows from one promise: the code a user pastes in never leaves their machine.

These are not aspirations. Each principle names the test or file that enforces it,
because a principle nothing checks is a comment.

## Core Principles

### I. The engine is pure, and that is proven by execution

`packages/engine` declares **zero runtime dependencies** and makes no network call,
touches no filesystem, reads no environment or process global, reaches for no storage
or execution global, and never logs — a `console` call inside the engine would print a
user's real code.

Enforced by `packages/engine/tests/purity.test.ts`, which does not grep for these
things. It replaces the globals with traps and runs a full anonymize/restore cycle
against them. It also asserts *that the trap fires*, so the suite cannot pass
vacuously — a purity test that silently stopped testing anything is worse than none,
because it reports safety it is no longer checking.

A dependency added to that package is a breaking change to this promise, not a
convenience.

### II. Nothing goes off-origin

A full page load contacts nothing but its own origin, and no network request ever
carries the user's source. Fonts are vendored rather than fetched.

Enforced by `e2e/security.spec.ts` ("a full page load contacts nothing off-origin")
and `e2e/manual-masking.spec.ts` ("the page makes no network request carrying the
source"). Adding an analytics snippet, a CDN font, or an error reporter breaks the
product's only real guarantee, whatever it does for the roadmap.

### III. Placeholders may never collide with language internals

The placeholder grammar is `/^__[A-Z][A-Z0-9_]*__\d*$/` (`packages/engine/src/engine.ts`).
The uppercase-first rule exists so that `__proto__`, `constructor` and `prototype`
can never be produced or accepted as placeholders — a map keyed on those would let a
restored file mutate the object it is being restored through.

Widening this pattern requires demonstrating that the three names above are still
refused.

### IV. Key-derivation parameters are recorded, never edited

Every encrypted artifact carries the KDF parameters it was created under
(`src/lib/kdf.ts`). `CURRENT_*` values may be raised freely; `LEGACY_*` values are
historical fact and must never be edited to track them.

Raising a hardcoded constant re-derives a *different* key from the same passphrase and
silently orphans every artifact encrypted under the old one. Recording the parameters
is what makes a cost increase a migration rather than data loss.

Untrusted parameters are bounded, not believed: an imported file's iteration count
drives a loop in the reader's browser.

### V. Authenticated is not trusted

A decrypted `.veilio` file proves its author knew the passphrase. In a team workflow
that is the whole point — so it proves a colleague wrote it, not that its contents are
safe. Its values are substituted into restored source that a human then pastes into an
editor.

Every imported map is validated on the way in (`src/lib/importedMap.ts`), and every
href taken out of a rendered document is allow-listed rather than trusted
(`src/lib/safeHref.ts`) — normalised the way a browser would first, because the URL
parser strips characters before it looks for a scheme, and testing the raw string is
the bypass.

### VI. Comments carry the reason, not the mechanism

The code says what happens. A comment that repeats it is noise. Comments here record
why a thing is the way it is, what was tried, and what breaks if it changes — the
context that is otherwise lost the moment the author forgets.

A constant with a security consequence states that consequence. A workaround states
what it works around and when it can be removed.

## Additional Constraints

**Open-core boundary.** This repository is the Community Edition, source-available
under the Veilio Community License. The proprietary Cloud edition lives elsewhere.
Cloud implementation detail must not appear in this repository's issues, code or
history — including in a comment explaining why something is absent.

**The engine is published.** `@veilio-inc/engine` ships `.d.ts` to npm consumers.
Changes to its public surface are versioned deliberately, and toolchain changes that
alter emitted declarations are their own reviewed change, never a passenger on
something else.

**Supply chain.** GitHub Actions are pinned to full commit SHAs with the resolved tag
in a trailing comment; base images are pinned by digest. Pinning alone is an
unpatched dependency with better provenance, so Dependabot is configured to propose
the moves — the two halves only work together.

## Development Workflow

**Every change is verified before it is claimed.** Typecheck, lint, the unit suites,
a production build, and the Playwright specs. Reporting a result that was not observed
is the one unrecoverable error, because it poisons every later decision.

**A test that cannot fail is not evidence.** When a change adds a guard, show the
guard failing without it. The `safeHref` port was verified by reverting the call site
and watching the new specs fail on a rendered `javascript:` href; the purity suite
asserts its own trap fires. Green is not the goal — *would have been red* is.

**Dependency updates move as coherent sets.** A bump that leaves a peer behind, or a
manifest whose lockfile was not regenerated alongside it, is closed rather than
merged. If two automated PRs are two halves of one change, they are replaced by one
hand-made change.

**No AI attribution.** Commit messages and PR descriptions carry no co-author trailer,
no generated-with line, and no assistant's name.

## Governance

This constitution supersedes convenience. A change that violates a principle here is
not blocked outright, but it must say which principle, why, and what replaces the
guarantee that principle was providing — in the pull request, not in a follow-up.

Amendments are made in a pull request of their own, never bundled with the change that
motivated them. The version below follows semantic versioning: MAJOR for removing or
redefining a principle, MINOR for adding one, PATCH for wording that does not change
what is required.

**Version**: 1.0.0 | **Ratified**: 2026-08-16 | **Last Amended**: 2026-08-16
