<!--
One logical change per pull request — CONTRIBUTING's ground rules.
Delete any section that does not apply rather than leaving it empty.
-->

## What this changes, and why

<!-- The problem first. A diff shows what moved; it cannot show what was wrong. -->

## How it was checked

<!--
"Bring a test." Name the test that fails without this change, or say plainly
that there is none and why. For a behaviour change, the commands you ran and
what they printed are worth more than an assertion that they passed.
-->

## Checklist

- [ ] The commit messages are [conventional commits](https://www.conventionalcommits.org), and the scope is right — **only `engine`-scoped commits release the engine**, so a genuine engine fix without the scope ships to nobody and a UI change with it republishes over unchanged code.
- [ ] `npm run verify` and `npm test` pass locally; `npm run test --workspaces` too if this touches `packages/`.
- [ ] A changeset is included if this changes `@veilio-inc/cli` or `@veilio-inc/mcp` (`npm run changeset`). The engine does not use them — semantic-release reads its commits.
- [ ] Documentation that would now be wrong is updated in the same PR — a README, `docs/USING-THE-CLI-AND-MCP.md`, or the roadmap entry this closes.
- [ ] No runtime dependency was added to `@veilio-inc/engine`. Its purity invariants are not negotiable in a PR; see CONTRIBUTING.
- [ ] No credential, customer data or real identifier is in the diff, the tests or this description.

## Contributor License Agreement

First pull request? Include this line, with your own name and email — it is how
the CLA is agreed, and it is needed once, not per PR:

> I have read and agree to the Veilio CLA (CLA.md). Signed-off-by: Your Name <you@example.com>

Commits should also carry a DCO sign-off (`git commit -s`). See
[CONTRIBUTING.md](../CONTRIBUTING.md).
