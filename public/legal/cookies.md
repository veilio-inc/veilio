# Veilio Community Edition — Cookie & Local Storage Notice

_Last updated: 2026-08-14 · Document version 1.2 · Applies to: the self-hosted Community Edition only._

> **Scope.** This notice covers the **Veilio Community Edition (CE)**. **Veilio Cloud** (the hosted service, which uses a session token and an anti-abuse widget) has its own [Cookie Policy](https://veilio.dev/legal/cookies). This notice does not cover Cloud.

**The Community Edition sets no cookies and uses no advertising, analytics, or tracking technology.** It uses exactly one item of browser storage, and it is strictly necessary:

| Item | Type | Purpose | Consent |
|---|---|---|---|
| Symbol maps | `localStorage` | Keeps your anonymization maps on your device between sessions | Strictly necessary — no consent required |

Passphrases and the keys derived from them are held in memory for the duration of an operation and are never written to any browser storage.

Because CE stores only strictly-necessary, first-party data and sets no cookies, a consent banner is not required for that storage. You can clear it anytime through your browser; doing so removes any locally stored maps.

## Third-party requests
**None.** CE loads every asset, including its web fonts, from its own origin, so no third party can set storage or observe your visit. Earlier builds loaded fonts from Google Fonts; that request has been removed. The [Privacy Notice](./privacy.md) covers this in full.

_Questions: `support@veilio.dev`._
