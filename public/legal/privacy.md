# Veilio Community Edition — Privacy Notice

_Last updated: 2026-08-14 · Version: CE v1.2 · Applies to: the self-hosted Community Edition only._

> **Scope.** This notice covers the **Veilio Community Edition (CE)** — the self-hosted, source-available app in this repository. **Veilio Cloud** (the hosted service) is a separate service with its own [Privacy Policy](https://veilio.dev/legal/privacy). This notice does not cover Cloud.

**The Veilio project collects no personal data from the Community Edition.** It has no backend, no accounts, no analytics, and **no telemetry**. The anonymizer engine (`@veilio-inc/engine`) performs **no network requests at all** — this is enforced by an automated purity test in our CI suite (`packages/engine/tests/purity.test.ts`). Your source code, identifiers, and symbol maps **never leave your machine.**

This applies to the *page* as well as the engine: CE makes **no third-party requests of any kind** — see **Third-party requests** below.

## What stays on your device
| Data | Where | Notes |
|---|---|---|
| Symbol maps | Browser `localStorage` | Kept locally for convenience; never transmitted. |
| `.veilio` exports | Files you save to disk | Encrypted on your device with **AES-256-GCM**; key derived from your passphrase via **PBKDF2-SHA256** at **600,000 iterations** for newly written files. Files exported before that raise recorded 100,000 iterations and are still readable — each file carries the parameters it was created under. The passphrase is never stored or transmitted. |

There is nothing for us to access, export, or delete, because we never receive it. You can clear this data anytime through your browser.

## If you self-host CE for other people
If you deploy CE so others can use it, **you** are the data controller for anything your own hosting stack records (for example, web-server access logs). CE itself adds no such logging and sends nothing back to the Veilio project.

## Third-party requests
**None.** CE contacts no third-party origin at any point. Every asset it needs — including its web fonts — is served from the same origin as the app itself.

Earlier builds loaded their web fonts from **Google Fonts** (`fonts.googleapis.com` and `fonts.gstatic.com`), which disclosed your **IP address** and **User-Agent** to Google on every page load. We considered that a defect in a privacy tool rather than a feature. The fonts are now bundled with the application, and that request is gone.

Two consequences worth stating plainly:

- CE works unchanged in **air-gapped and locked-down deployments**. Nothing needs to resolve beyond your own host.
- The build enforces this rather than merely intending it. The server sends a `Content-Security-Policy` restricting the page to its own origin, so the browser itself blocks any attempt to contact another one, and an automated test fails the build if a third-party request reappears.

## Telemetry
CE sends **zero telemetry**. There is no opt-out to configure because there is nothing to opt out of.

## Minimum age
CE is not directed to children. We set a **minimum age of 16** for use of Veilio, consistent with the threshold used by Veilio Cloud.

## Cookies & local storage
CE sets no cookies and uses no advertising, analytics, or tracking technology. It stores only the strictly-necessary browser `localStorage` described above, and makes no third-party requests at all. See the [Cookie & Local Storage Notice](./cookies.md).

## Changes & contact
We post updates here and bump the version. Privacy questions: `privacy@veilio.dev` (or `support@veilio.dev`).
