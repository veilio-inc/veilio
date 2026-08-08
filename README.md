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
docker run -p 8080:80 ghcr.io/dlugosh/veilio:latest
```

Open `http://localhost:8080`.

### Static bundle

Download the latest `veilio-v*.tar.gz` from [Releases](https://github.com/dlugosh/veilio-oss/releases), extract, and serve `dist/` with any static host (nginx, Caddy, GitHub Pages, Vercel, `python -m http.server`).

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
