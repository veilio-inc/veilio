# Veilio — Community Edition

Two-way AI code anonymizer. Strip real identifiers (`UserAuthService.validateSessionToken`) before you paste code into an LLM, then restore them on the way back. The engine runs entirely in your browser — source code never leaves your machine.

**This is the self-hostable Community Edition.** For the hosted Cloud edition with accounts, cross-device sync, and team features, see [veilio.dev](https://veilio.dev).

## Features

- Two-way anonymize / restore in-browser via `@dlgshi/engine`
- Maps saved to browser localStorage for convenience
- Export / import encrypted `.veilio` files (AES-256-GCM, passphrase-protected) for durable, portable storage
- Zero backend. Zero database. Zero secrets to manage.

## Run it

### Docker

```bash
docker run -p 8080:80 ghcr.io/dlgshi/veilio-oss:latest
```

Open `http://localhost:8080`.

### Static bundle

Use this when Docker isn't an option — locked-down or air-gapped environments,
or an existing nginx / IIS / CDN you'd rather drop files into.

Veilio has **no backend and no server-side code**: the engine runs entirely in
the browser, so "hosting" it is just serving static files. The Docker image above
is nothing more than nginx serving exactly this bundle.

Download the latest `veilio-v*.tar.gz` from [Releases](https://github.com/DlgSHi/veilio-oss/releases), extract, and serve `dist/` with any static web server.

> **One requirement: SPA fallback.** Veilio uses client-side routing, so the
> server must serve `index.html` for unknown paths. Without it, `/pricing` and
> `/legal/terms` return 404 when opened directly or refreshed — the app looks
> broken even though it isn't. The Docker image already handles this.

- **nginx** — `try_files $uri $uri/ /index.html;` (see [`docker/nginx.conf`](./docker/nginx.conf) for a complete, working config)
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

> The anonymizer engine (`@dlgshi/engine`) is bundled in this repo at `packages/engine` and is built automatically on `npm install` via the `postinstall` script — no extra setup or npm link needed.

## Configuration

CE has one optional env var:

| Var | Default | Purpose |
|---|---|---|
| `VITE_Veilio_CLOUD_URL` | `https://veilio.dev` | Target of the "Team / Cloud" CTA on the Pricing page. Self-hosters typically leave this alone. |

## How this relates to Cloud

The anonymizer engine (`@dlgshi/engine`) is the same in both editions. The Cloud edition adds auth, encrypted server-side map storage, teams, and billing — none of which lives in this repo.

## License, contributing & trademarks

- **License:** [Veilio Community License 1.0](./LICENSE) — **free to use for any purpose, including personal, educational, and internal commercial use.** Self-host it, modify it, fork it, run your business on it. You may **not** sell, resell, sublicense, white-label, or operate Veilio (or its engine, or a derivative) **as a commercial hosted service or a product that competes with Veilio Cloud.** It is **source-available and community-developed, but not an OSI-approved "open source" license.** For a commercial or redistribution license, email `hello@veilio.dev`.
- **Contributing:** see [CONTRIBUTING.md](./CONTRIBUTING.md). Contributions are accepted under a [CLA](./CLA.md) so they can be used across both the Community and Cloud editions.
- **Trademarks:** the code is source-available, but the **"Veilio" name and logo are not** licensed for reuse — see [TRADEMARKS.md](./TRADEMARKS.md).
- **Security:** report vulnerabilities privately per [SECURITY.md](./SECURITY.md).

## Credits

Built on prior work by Igor Dlugosh in the (private) Veilio codebase. Source-available under the Veilio Community License 1.0 — free to use, including inside your own business; not for competing resale or hosting.
