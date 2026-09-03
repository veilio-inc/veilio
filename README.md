<p align="center">
  <img src="public/icon.svg" width="96" alt="" />
</p>

<h1 align="center">Veilio — Community Edition</h1>

<p align="center"><em>Send the problem. Keep the names.</em></p>

Two-way AI code anonymizer. Strip real identifiers (`UserAuthService.validateSessionToken`) before you paste code into an LLM, then restore them on the way back. Source code never leaves your machine: the web app runs the engine in your browser, and the terminal and agent surfaces run it in your own process.

**This is the self-hostable Community Edition.** For the hosted Cloud edition with accounts, cross-device sync, and team features, see [veilio.dev](https://veilio.dev).

## Features

- Two-way anonymize / restore in-browser via `@veilio-inc/engine`
- The same engine in a terminal (`@veilio-inc/cli`) and in coding agents (`@veilio-inc/mcp`)
- Maps saved to browser localStorage for convenience
- Export / import encrypted `.veilio` files (AES-256-GCM, passphrase-protected) for durable, portable storage
- Zero backend. Zero database. Zero secrets to manage.

## What is in this repository

| Package                                        | What it is                                                                                                                                                                                                                                                                     |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`packages/engine`](packages/engine/README.md) | The anonymizer itself — pure, zero runtime dependencies, published to npm as `@veilio-inc/engine`. Everything else wraps it.                                                                                                                                                   |
| [`packages/cli`](packages/cli/README.md)       | `veilio scrub \| pbcopy`, `restore`, and a `scan` that exits non-zero on a live credential. Pipes, pre-commit hooks, CI.                                                                                                                                                       |
| [`packages/mcp`](packages/mcp/README.md)       | An MCP server for coding agents. Its tools take a **file path**, so the server reads the file and the agent only ever sees `__CLS__1.__FN__2()` — a tool that took code as an argument would be pointless, since the real identifiers would already be in the model's context. |
| `src/`                                         | The web app in this README — React, Vite, no backend.                                                                                                                                                                                                                          |

The CLI and the MCP server share one symbol map, so you can mask inside an agent
and restore from a terminal, or the reverse. Neither makes a network call on any
local path, and each ships a test that trips if one is ever introduced.

> **Both are not on npm yet.** They live here and are tested here; the install
> instructions land in the same commit that publishes them. Until then, run them
> from a clone — `npm run build:packages`, then `node packages/cli/dist/index.js --help`.

## Run it

### Docker

```bash
docker run -p 8080:80 ghcr.io/veilio-inc/veilio:latest
```

Open `http://localhost:8080`.

Images are built for `linux/amd64` and `linux/arm64` and pushed on every merge to
`main`:

| Tag            | Points at                          |
| -------------- | ---------------------------------- |
| `latest`       | the current `main` build           |
| `sha-<short>`  | one exact commit — use this to pin |
| `1.2.3`, `1.2` | a tagged release, once one is cut  |

> **Tags beginning `sha256-` are not images.** The package listing also shows
> tags like `sha256-f4788394…`, which are the provenance attestations and SBOMs
> described below. GHCR stores those under a tag derived from the digest they
> refer to, so they sit alongside the real tags with nothing marking them as
> metadata. They carry no platform, so pulling one fails with
> `no matching manifest for linux/arm64/v8` — or for whatever platform you are
> on, since none can ever match. Pull `latest`, a `sha-<short>`, or a version.

#### Verify what you pulled

Every image is published with signed [SLSA](https://slsa.dev) build provenance,
so you can check it was built by this repository's workflow from this source —
rather than by someone who obtained a registry token:

```bash
gh attestation verify oci://ghcr.io/veilio-inc/veilio:latest --repo veilio-inc/veilio
```

The image also carries a BuildKit provenance attestation and an SBOM, which
answer "how was this built?" and "what is inside it?":

```bash
docker buildx imagetools inspect ghcr.io/veilio-inc/veilio:latest \
  --format '{{ json .Provenance }}'
docker buildx imagetools inspect ghcr.io/veilio-inc/veilio:latest \
  --format '{{ json .SBOM }}'
```

The Cloud CTA target is compiled into the bundle, so redirecting it needs a
rebuild rather than `docker run -e` (see [Configuration](#configuration)):

```bash
docker build -f docker/Dockerfile \
  --build-arg VITE_VEILIO_CLOUD_URL=https://cloud.example.com -t veilio .
```

### Static bundle

Use this when Docker isn't an option — locked-down or air-gapped environments,
or an existing nginx / IIS / CDN you'd rather drop files into.

Veilio has **no backend and no server-side code**: the engine runs entirely in
the browser, so "hosting" it is just serving static files. The Docker image above
is nothing more than this bundle plus a ~140-line static file server
([`docker/serve.go`](./docker/serve.go)) on an otherwise empty image — no distro,
no shell, no package manager. That is why it is 10 MB.

Download the latest `veilio-v*.tar.gz` from [Releases](https://github.com/veilio-inc/veilio/releases), extract, and serve `dist/` with any static web server.

> **One requirement: SPA fallback.** Veilio uses client-side routing, so the
> server must serve `index.html` for unknown paths. Without it, `/pricing` and
> `/legal/terms` return 404 when opened directly or refreshed — the app looks
> broken even though it isn't. The Docker image already handles this.

- **nginx** — `try_files $uri $uri/ /index.html;` (see [`docker/nginx.conf`](./docker/nginx.conf) for a complete, working config, kept as a reference for exactly this case — the image itself no longer runs nginx)
- **Caddy** — `try_files {path} /index.html`
- **Vercel / Netlify** — add a rewrite of `/*` to `/index.html`
- **`python -m http.server`** — fine for a quick look at `/`, but it has no
  fallback, so deep links will 404

**GitHub Pages needs extra work** and isn't recommended: it has no SPA fallback,
and a project page serves under `/veilio-oss/` while this build assumes root, so
assets 404 as well. Use a custom domain plus a `404.html` fallback, or pick
another host.

You can't open `dist/index.html` straight off disk — browsers refuse to load ES
modules over `file://`. Any HTTP server works; the requirement is only the
fallback above.

### Develop locally

```bash
npm install
npm run dev
```

> The anonymizer engine (`@veilio-inc/engine`) is bundled in this repo at `packages/engine` and is built automatically on `npm install` via the `postinstall` script — no extra setup or npm link needed.

This is an npm workspace, so the app, the engine, the CLI and the MCP server are
installed together by that one `npm install`. The app only needs the engine, so
`postinstall` builds only that; the two tools are built on demand:

```bash
npm run build:packages   # engine, then cli, then mcp — in dependency order
npm run test:packages    # builds first, then runs each package's own suite
npm test                 # the web app, plus the workspace-graph checks
```

Build order is not a style choice: `packages/mcp` imports `@veilio-inc/cli/store`,
which resolves through the CLI's `exports` map into `packages/cli/dist` — a
directory that exists only after a build.

## Configuration

CE has one optional setting. Vite inlines it when the bundle is compiled, so it
is a **build argument, not a runtime variable** — passing it to `docker run -e`
does nothing.

| Var                     | Default              | Purpose                                                                                        |
| ----------------------- | -------------------- | ---------------------------------------------------------------------------------------------- |
| `VITE_VEILIO_CLOUD_URL` | `https://veilio.dev` | Target of the "Team / Cloud" CTA on the Pricing page. Self-hosters typically leave this alone. |

## Roadmap

[ROADMAP.md](./ROADMAP.md) is the public plan: what the engine gets wrong today,
what is queued, and what we have decided not to build. Engine and community work
only — no commercial sequencing.

## How this relates to Cloud

The anonymizer engine (`@veilio-inc/engine`) is the same in both editions. The Cloud edition adds auth, encrypted server-side map storage, teams, and billing — none of which lives in this repo.

## License, contributing & trademarks

- **License:** [Veilio Community License 1.0](./LICENSE) — **free to use for any purpose, including personal, educational, and internal commercial use.** Self-host it, modify it, fork it, run your business on it. You may **not** sell, resell, sublicense, white-label, or operate Veilio (or its engine, or a derivative) **as a commercial hosted service or a product that competes with Veilio Cloud.** It is **source-available and community-developed, but not an OSI-approved "open source" license.** For a commercial or redistribution license, email `hello@veilio.dev`.
- **Contributing:** see [CONTRIBUTING.md](./CONTRIBUTING.md). Contributions are accepted under a [CLA](./CLA.md) so they can be used across both the Community and Cloud editions.
- **Trademarks:** the code is source-available, but the **"Veilio" name and logo are not** licensed for reuse — see [TRADEMARKS.md](./TRADEMARKS.md).
- **Security:** report vulnerabilities privately per [SECURITY.md](./SECURITY.md).

## Credits

Built on prior work in the private Veilio codebase. Source-available under the Veilio Community License 1.0 — free to use, including inside your own business; not for competing resale or hosting.
