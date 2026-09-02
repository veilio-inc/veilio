# Publishing `@veilio-inc/cli`, then `@veilio-inc/mcp`

Order is not a preference. `@veilio-inc/mcp` depends on `@veilio-inc/cli`, so the
CLI has to exist on npm before the MCP server can resolve. Changesets orders by
dependency and would publish both in one run, but the first release is worth doing
one at a time so a mistake affects one package.

Everything below assumes `main` is green and `@veilio-inc/engine@1.3.0` is
published (it is).

For the engine's own release path — semantic-release, `engine-v*` tags,
`publish-engine.yml` — see [`.changeset/README.md`](../.changeset/README.md) for
why the two live side by side, and `.releaserc.js` for the configuration. Nothing
in this document touches the engine.

---

## 0 — What is already settled, and what is not

**Settled: these publish from here.** They moved out of the closed `veilio-cloud`
repository for exactly this. Both carry the Veilio Community License 1.0 — the
same terms `packages/engine` ships under, and the only terms compatible with the
`npx @veilio-inc/cli` usage that `packages/cli/action.yml` advertises. Their
`repository`, `homepage` and `bugs` fields already point here.

**Not settled: `private: true`.** Both manifests still carry it, and
`changeset publish` skips a private package without saying anything. Removing that
field is the whole arming step, and it arms the **next** Version Packages merge
rather than the commit that removes it.

Check the scope is yours before anything else:

```bash
npm whoami
npm access list packages @veilio-inc 2>/dev/null | head
```

`@veilio` belongs to an unrelated third party. Everything here is `@veilio-inc`.

### The first publish cannot come from CI

`publish-tools.yml` uses npm OIDC trusted publishing — no stored `NPM_TOKEN`. npm
generally requires a package to **exist** before a trusted publisher can be
attached to it, and the OIDC identity is the repository, which has no right to
create a name it has never held. npm answers `404`, not `403`, which reads like a
network problem and is not one.

So each package is bootstrapped once by hand, then never again. This is the same
dance `packages/engine` went through; `veilio-cloud/docs/RELEASE_RUNBOOK.md`
records it.

---

## 1 — Publish the CLI

### 1.1 Make it publishable

Edit `packages/cli/package.json`: remove `"private": true` and the `//private`
note above it — that note documents a decision you are now taking. Leave
`publishConfig.access` alone; a scoped package needs it.

### 1.2 Prove the tarball before npm sees it

```bash
npm run build --workspace=packages/cli
npm pack --workspace=packages/cli --dry-run
```

Expect ~19 files: `dist/`, `README.md`, `LICENSE`. If `dist/` is missing, stop.
`prepublishOnly` and the tarball check in `publish-tools.yml` both exist to make
that unreachable, but a tarball with no `dist` installs cleanly and fails on first
run, which is the worst failure shape available.

```bash
head -1 packages/cli/dist/index.js     # must be: #!/usr/bin/env node
```

Then run it from the packed artifact, not from source:

```bash
npm pack --workspace=packages/cli
mkdir -p /tmp/cli-smoke && tar xzf veilio-inc-cli-*.tgz -C /tmp/cli-smoke
node /tmp/cli-smoke/package/dist/index.js --version
echo 'const secret = "AKIAIOSFODNN7EXAMPLE"' | node /tmp/cli-smoke/package/dist/index.js scan
rm -f veilio-inc-cli-*.tgz
```

`scan` must exit 1 and report the key. That exercises the engine resolving from an
installed tree, which a dry run cannot tell you.

### 1.3 Bootstrap the name by hand, once

```bash
cd packages/cli
npm publish --access public --provenance=false
cd ../..
```

`--provenance=false` is required: a local publish cannot produce an attestation.
This one release has no provenance; every release after it does.

Then register the trusted publisher on npmjs.com for `@veilio-inc/cli` — repository
`veilio-inc/veilio`, workflow `publish-tools.yml`, environment `release`.

### 1.4 Hand the rest to Changesets

```bash
npx changeset          # select @veilio-inc/cli only
```

Write the summary as a user-facing sentence, not a commit message — it becomes the
changelog entry.

```bash
git checkout -b release/cli-first-publish
git add packages/cli/package.json .changeset/
git push -u origin release/cli-first-publish
gh pr create --base main --title "build(cli): publish @veilio-inc/cli"
```

Merge it, and then:

1. `publish-tools.yml` opens a **"chore: version the CLI and MCP server"** PR that
   bumps the version and writes `packages/cli/CHANGELOG.md`. Nothing is published.
2. Review it. This is the last point at which nothing has left the building.
3. Merge it. The workflow runs again, finds no changesets, and publishes.

```bash
gh run watch $(gh run list --workflow=publish-tools.yml --limit 1 --json databaseId --jq '.[0].databaseId')
```

### 1.5 Verify from outside

```bash
npm view @veilio-inc/cli version
npx --yes @veilio-inc/cli@latest --version
npx --yes @veilio-inc/cli@latest scan <<< 'const k = "AKIAIOSFODNN7EXAMPLE"'
```

`npx` is the real test: it resolves the package, its `bin` and `@veilio-inc/engine`
from the registry rather than from your workspace.

---

## 2 — Publish the MCP server

Only once `npm view @veilio-inc/cli version` returns a real version.

### 2.1 Point it at the published CLI

`packages/mcp/package.json` depends on `"@veilio-inc/cli": "^0.1.0"`. If the CLI
published as something else, that range matches nothing on npm and the install
fails for everyone:

```bash
npm view @veilio-inc/cli version
```

Set the range to what actually shipped, remove `"private": true` and the
`//private` note.

`updateInternalDependencies: "patch"` keeps this in step on _later_ releases. It
cannot help here, because there was no published version to bump from.

### 2.2 Prove it resolves against the registry

This is the step that catches the failure unique to this package — the CLI
dependency resolving from your workspace in testing and from npm in reality:

```bash
npm run build --workspace=packages/mcp
npm pack --workspace=packages/mcp
mkdir -p /tmp/mcp-smoke && cd /tmp/mcp-smoke && npm init -y >/dev/null
npm i "$OLDPWD"/veilio-inc-mcp-*.tgz
node -e "console.log(require.resolve('@veilio-inc/cli/store'))"
cd - && rm -f veilio-inc-mcp-*.tgz
```

If `@veilio-inc/cli/store` does not resolve, the CLI's `exports` map is wrong and
the MCP server fails at import time inside somebody else's agent.

Then speak protocol to it over stdio:

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
  | node /tmp/mcp-smoke/node_modules/@veilio-inc/mcp/dist/index.js
```

Expect an `initialize` result naming the server. A crash here is a packaging
problem, not a protocol one.

### 2.3 Bootstrap and ship

Same shape as 1.3–1.5, selecting `@veilio-inc/mcp`: hand-publish once with
`--provenance=false`, register the trusted publisher, then changeset → PR → merge
→ review the version PR → merge.

### 2.4 Verify as a user would

```bash
npm view @veilio-inc/mcp version
npx --yes @veilio-inc/mcp@latest --help 2>&1 | head
```

Then wire it into a real client. In Claude Code:

```json
{
  "mcpServers": {
    "veilio": { "command": "npx", "args": ["-y", "@veilio-inc/mcp@latest"] }
  }
}
```

Ask it to anonymize a file and confirm the response carries the placeholders and
the comment-exposure note.

---

## What the pipeline actually does

```
push to main
  └─ publish-tools.yml            (environment: release — manual approval)
       ├─ npm ci                                  → postinstall builds the engine
       ├─ build:packages → typecheck → test       → all three packages
       ├─ npm pack --dry-run per tool             → allowlist + "dist is not empty"
       └─ changesets/action@v1
            ├─ changesets present, no version PR open → opens the version PR
            └─ version PR just merged                → npm run release → changeset publish
```

`changeset publish` runs `npm publish` per package, which triggers each package's
own `prepublishOnly`: clean, typecheck, test, build. A failing test stops that
package's publish.

**The action is held at v1 deliberately.** v2 requires Changesets CLI v3 and
renames every input. A Dependabot PR raising it should be closed, not merged —
this workflow only runs on push to `main`, so CI cannot catch the break.

---

## If it goes wrong

**Published the wrong thing.** `npm unpublish` is allowed only within 72 hours and
only if nothing depends on it. Prefer `npm deprecate` and publish a fix:

```bash
npm deprecate @veilio-inc/cli@0.2.0 "Broken packaging; use 0.2.1"
```

**The version PR never appears.** No changeset was committed, or the packages are
still `private: true`. `npx changeset status` says which.

**Published an empty tarball.** `prepublishOnly` was skipped — some CI paths pass
`--ignore-scripts`. Republish a patch; the packing checks in 1.2 and in
`publish-tools.yml` exist to keep this unreachable.

**The MCP server installs but cannot import the CLI.** That is the `exports` map,
not the dependency range. Check that `packages/cli/package.json` exports `./store`.

**`npm ci` warns `EBADENGINE`.** The root declares `>=22.19.0` (the app's floor,
and the version `publish-engine.yml` deliberately runs); both tools declare `>=24`.
Under Node 22 npm warns and installs. The warning is accurate — do not publish the
tools from a runtime they do not claim.

---

## Still to decide before the first flip

- **Version.** Both are `0.1.0`. `0.x` says the interface can still move, which is
  honest for a first release; `1.0.0` says it will not.
- **README.** Both ship in the tarball and become the npm landing page. Read them
  as a stranger would, before a stranger does.
