# Changesets

This directory holds the release intents for **`@veilio-inc/cli`** and
**`@veilio-inc/mcp`**. Run `npm run changeset`, describe the change, and commit the
generated markdown file alongside the code it describes.

## Why the engine is not here

`@veilio-inc/engine` is released by **semantic-release**, from the conventional
commit messages, on an `engine-v*` tag — see `.releaserc.js` and
`.github/workflows/publish-engine.yml`.

It used to be named in `ignore`, and that was wrong in a way nothing could see
until the CLI became publishable. Changesets rejects a config that skips a
package while a non-skipped package depends on it:

> The package "@veilio-inc/cli" depends on the skipped package
> "@veilio-inc/engine", but "@veilio-inc/cli" is not being skipped.

While both tools were `private: true` Changesets excluded them from the workspace
entirely, so the dependency edge did not exist and the config validated. Removing
`private` from the CLI is what made it real — the first release would have failed
on a config error, which is a poor moment to discover one.

So `ignore` is empty, and what keeps Changesets from releasing the engine is
arithmetic rather than configuration: `changeset version` bumps only packages
with a changeset (plus their dependents), and `changeset publish` uploads a
package only when its manifest version is not already on the registry. The engine
has neither a changeset nor a version npm is missing.

That second half is a property of the manifest tracking npm, which is checked in
`ci.yml` and again in `publish-tools.yml` — the second time in the workflow that
actually holds the credential, and there it refuses even when npm is unreachable.

Two tools in one repository is a deliberate split, not an accident of history. The
engine's version is derived from commit messages and has been since before the CLI
existed; changing that would rewrite a working release path for no gain. The CLI and
the MCP server version together and by hand, because their releases are product
decisions rather than a function of what happened to be committed.

## The seam, and the three checks on it

The CLI and the MCP server depend on `@veilio-inc/engine` by **range**, and
Changesets does not know when semantic-release ships a new engine. So widening that
range is a manual edit — the one real cost of running two release tools — and three
checks stand where a person would otherwise have to remember.

Within Changesets' own half there is nothing to remember: `updateInternalDependencies`
bumps the MCP server's dependency on the CLI and releases it automatically, because
both are packages it owns. It is only the engine edge that is manual.

1. **The engine must not fall behind the declared range** —
   `tests/package-graph.test.ts`. npm links a workspace package only when its
   version satisfies the range, so an engine below it is silently replaced by a
   REGISTRY copy and both tool suites go green against an engine that is not in
   the tree.

2. **The declared range must rise with the engine** — same file. A caret range
   accepts a newer minor, so `^1.3.0` against engine 1.4.0 passes check 1 and
   breaks nothing here. It breaks for a user whose tree resolves 1.3.0 and whose
   CLI calls a 1.4.0 API. Pinned at minor granularity: new APIs arrive in minors,
   patches are compatible and forcing a release for each one would be churn.

3. **The engine's manifest must match what npm has** — a step in `ci.yml`, not a
   test, because it needs the registry and that suite must never make a network
   call. Checks 1 and 2 both read `packages/engine/package.json`, which since
   `@semantic-release/git` was removed is a hand-maintained copy of the published
   version. Let it go stale and both compare two old numbers and agree with
   themselves.

The upshot: after an engine release, set its version in the manifest and widen the
range in both tools, in one commit. If you forget the manifest, check 3 fails. If
you sync the manifest and forget the ranges, check 2 fails.
