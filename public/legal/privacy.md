# Veilio Community Edition — Privacy Notice

_Last updated: 2026-08-12 · Version: CE v1.1 · Applies to: the self-hosted Community Edition only._

> **Scope.** This notice covers the **Veilio Community Edition (CE)** — the self-hosted, source-available app in this repository. **Veilio Cloud** (the hosted service) is a separate service with its own [Privacy Policy](https://veilio.dev/legal/privacy). This notice does not cover Cloud.

**The Veilio project collects no personal data from the Community Edition.** It has no backend, no accounts, no analytics, and **no telemetry**. The anonymizer engine (`@veilio-inc/engine`) performs **no network requests at all** — this is enforced by an automated purity test in our CI suite (`packages/engine/tests/purity.test.ts`). Your source code, identifiers, and symbol maps **never leave your machine.**

One exception applies to the *page*, not the engine — see **Third-party requests** below.

## What stays on your device
| Data | Where | Notes |
|---|---|---|
| Symbol maps | Browser `localStorage` | Kept locally for convenience; never transmitted. |
| `.veilio` exports | Files you save to disk | Encrypted on your device with **AES-256-GCM**; key derived from your passphrase via **PBKDF2-SHA256** at **600,000 iterations** for newly written files. Files exported before that raise recorded 100,000 iterations and are still readable — each file carries the parameters it was created under. The passphrase is never stored or transmitted. |

There is nothing for us to access, export, or delete, because we never receive it. You can clear this data anytime through your browser.

## If you self-host CE for other people
If you deploy CE so others can use it, **you** are the data controller for anything your own hosting stack records (for example, web-server access logs). CE itself adds no such logging and sends nothing back to the Veilio project.

## Third-party requests
The current build loads its web fonts from **Google Fonts** (`fonts.googleapis.com` and `fonts.gstatic.com`). That request is made by your browser when the page loads, and it discloses your **IP address** and **User-Agent** to Google — not to us, and not any of your code, identifiers, or maps, which never leave your machine.

We consider this a defect in a privacy tool rather than a feature, and self-hosting the fonts is tracked as a fix. Until then, two things are true and worth stating plainly:

- If you self-host CE and need **no third-party requests at all** — an air-gapped or locked-down deployment — remove the `fonts.googleapis.com` / `fonts.gstatic.com` `<link>` tags from `index.html` and rebuild. The app is fully functional without them; only the typography changes.
- Nothing you type into Veilio is part of that request.

## Telemetry
CE sends **zero telemetry**. There is no opt-out to configure because there is nothing to opt out of.

## Minimum age
CE is not directed to children. We set a **minimum age of 16** for use of Veilio, consistent with the threshold used by Veilio Cloud.

## Cookies & local storage
CE sets no cookies and uses no advertising, analytics, or tracking technology. It stores only the strictly-necessary browser `localStorage` described above; the sole third-party request it makes is the font load described above. See the [Cookie & Local Storage Notice](./cookies.md).

## Changes & contact
We post updates here and bump the version. Privacy questions: `privacy@veilio.dev` (or `support@veilio.dev`).
