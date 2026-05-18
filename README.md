# SCRUBR — Community Edition

Two-way AI code anonymizer. Strip real identifiers (`UserAuthService.validateSessionToken`) before you paste code into an LLM, then restore them on the way back. The engine runs entirely in your browser — source code never leaves your machine.

**This is the self-hostable Community Edition.** For the hosted Cloud edition with accounts, cross-device sync, and team features, see [scrubr.app](https://scrubr.app).

## Features

- Two-way anonymize / restore in-browser via `@scrubr/shared`
- Maps saved to browser localStorage for convenience
- Export / import encrypted `.scrubr` files (AES-256-GCM, passphrase-protected) for durable, portable storage
- Zero backend. Zero database. Zero secrets to manage.

## Run it

### Docker

```bash
docker run -p 8080:80 ghcr.io/dlugosh/scrubr:latest
```

Open `http://localhost:8080`.

### Static bundle

Download the latest `scrubr-v*.tar.gz` from [Releases](https://github.com/dlugosh/scrubr-oss/releases), extract, and serve `dist/` with any static host (nginx, Caddy, GitHub Pages, Vercel, `python -m http.server`).

### Develop locally

```bash
npm install
npm run dev
```

> **Prerequisite:** `@scrubr/shared` must be available on npm. Until then, see [docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md) for local-link instructions.

## Configuration

CE has one optional env var:

| Var | Default | Purpose |
|---|---|---|
| `VITE_SCRUBR_CLOUD_URL` | `https://scrubr.app` | Target of the "Team / Cloud" CTA on the Pricing page. Self-hosters typically leave this alone. |

## How this relates to Cloud

The anonymizer engine (`@scrubr/shared` on npm) is the same in both editions. The Cloud edition adds auth, encrypted server-side map storage, teams, and billing — none of which lives in this repo.

## Credits

Built on prior work by Igor Dlugosh in the (private) SCRUBR codebase. MIT licensed — use, modify, distribute freely.
