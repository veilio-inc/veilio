# Veilio Community Edition — Cookie & Local Storage Notice

_Last updated: 2026-06-23 · Version: CE v1.0 · Applies to: the self-hosted Community Edition only._

> **Scope.** This notice covers the **Veilio Community Edition (CE)**. **Veilio Cloud** (the hosted service, which uses a session token and an anti-abuse widget) has its own [Cookie Policy](https://veilio.dev/legal/cookies). This notice does not cover Cloud.

**The Community Edition sets no cookies and uses no third-party advertising or tracking technology.** It uses only strictly-necessary browser storage to make the tool work:

| Item | Type | Purpose | Consent |
|---|---|---|---|
| Symbol maps | `localStorage` | Keeps your anonymization maps on your device between sessions | Strictly necessary — no consent required |
| Vault key (optional) | in-memory / `sessionStorage` | Holds a `.veilio` passphrase-derived key only while you keep a tab open, if you choose to | Strictly necessary for the feature you enabled |

Because CE uses only strictly-necessary, first-party storage and contacts no servers, a consent banner is not required. You can clear this data anytime through your browser; doing so removes any locally stored maps and forgets any opted-in vault key.

_Questions: `support@veilio.dev`._
