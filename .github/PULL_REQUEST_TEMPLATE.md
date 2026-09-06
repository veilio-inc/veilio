## What / why

<!-- What this changes and why. Link the issue it addresses, if any. -->

Closes #

## CLA sign-off

Required on your first pull request (see CONTRIBUTING.md). Copy this line into
this description, filled in:

> I have read and agree to the Veilio CLA (CLA.md). Signed-off-by: Your Name <you@example.com>

## Checklist

- [ ] Commit subject follows [Conventional Commits](https://www.conventionalcommits.org) (`fix(engine): …`, `feat(ui): …`, etc.)
- [ ] **Scope is correct** — only `(engine)`-scoped commits publish a new engine
      version. A genuine fix to `packages/engine` written *without* that scope
      ships to nobody; an unrelated change written *with* it republishes the
      engine over unchanged code and claims a feature it never gained.
- [ ] A test is included — for this project a test *is* the argument, not a nice-to-have.
- [ ] Ran locally: `npm run typecheck && npm run lint && npm run format:check && npm test`
- [ ] If this touches `packages/engine`: no new runtime dependency was added.
      The engine is a pure, zero-runtime-dependency transform
      (`packages/engine/tests/purity.test.ts` enforces this in CI); if your
      change seems to need one, open an issue first rather than adding it here.
- [ ] Commits are signed off (`git commit -s`), per the DCO.
