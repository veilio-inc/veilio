# Veilio Community Edition — Privacy Notice

_Last updated: 2026-06-23 · Version: CE v1.0 · Applies to: the self-hosted Community Edition only._

> **Scope.** This notice covers the **Veilio Community Edition (CE)** — the self-hosted, source-available app in this repository. **Veilio Cloud** (the hosted service) is a separate service with its own [Privacy Policy](https://veilio.dev/legal/privacy). This notice does not cover Cloud.

**The Community Edition collects no personal data.** It has no backend, no accounts, no analytics, and **no telemetry**. The anonymizer engine (`@veilio-inc/engine`) performs **no network requests at all** — this is enforced by an automated purity test in our CI suite (`packages/engine/tests/purity.test.ts`). Your source code, identifiers, and symbol maps **never leave your machine.**

## What stays on your device
| Data | Where | Notes |
|---|---|---|
| Symbol maps | Browser `localStorage` | Kept locally for convenience; never transmitted. |
| `.veilio` exports | Files you save to disk | Encrypted on your device with **AES-256-GCM**; key derived from your passphrase via **PBKDF2** (100,000 iterations, SHA-256). The passphrase is never stored or transmitted. |

There is nothing for us to access, export, or delete, because we never receive it. You can clear this data anytime through your browser.

## If you self-host CE for other people
If you deploy CE so others can use it, **you** are the data controller for anything your own hosting stack records (for example, web-server access logs). CE itself adds no such logging and sends nothing back to the Veilio project.

## Telemetry
CE sends **zero telemetry**. There is no opt-out to configure because there is nothing to opt out of.

## Minimum age
CE is not directed to children. We set a **minimum age of 16** for use of Veilio, consistent with the threshold used by Veilio Cloud.

## Cookies & local storage
CE sets no cookies and uses no third-party trackers. It uses only the strictly-necessary browser `localStorage` described above. See the [Cookie Notice](./cookies.md).

## Changes & contact
We post updates here and bump the version. Privacy questions: `privacy@veilio.dev` (or `support@veilio.dev`).
