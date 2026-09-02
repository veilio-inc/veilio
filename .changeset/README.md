# Changesets

This directory holds the release intents for **`@veilio-inc/cli`** and
**`@veilio-inc/mcp`**. Run `npm run changeset`, describe the change, and commit the
generated markdown file alongside the code it describes.

## Why the engine is not here

`@veilio-inc/engine` is released by **semantic-release**, from the conventional
commit messages, on an `engine-v*` tag — see `.releaserc.js` and
`.github/workflows/publish-engine.yml`. It is named in `ignore` above so Changesets
never proposes a version for it.

Two tools in one repository is a deliberate split, not an accident of history. The
engine's version is derived from commit messages and has been since before the CLI
existed; changing that would rewrite a working release path for no gain. The CLI and
the MCP server version together and by hand, because their releases are product
decisions rather than a function of what happened to be committed.

The seam to watch is the dependency edge: the CLI and the MCP server depend on
`@veilio-inc/engine` by **range**, and Changesets will not bump that range when
semantic-release ships a new engine. Widening it after an engine release is a manual
edit, and `packages/*/tests` has a check that the range the tools declare is one the
workspace engine actually satisfies.
