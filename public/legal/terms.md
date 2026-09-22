# Veilio Community Edition — Terms of Use

_Last updated: 2026-09-22 · Document version 1.2 · Applies to: the self-hosted Community Edition only._

> **Scope.** These terms govern the **Veilio Community Edition (CE)** — the self-hosted, source-available app in this repository, free to use for any purpose including commercial. **Veilio Cloud** (the hosted service at veilio.dev, with accounts, sync, teams, and billing) has its own separate [Terms of Service](https://veilio.dev/legal/terms), which do not apply to CE — and these CE terms do not apply to Cloud.

Veilio CE is **source-available, community-developed** software licensed under the **Veilio Community License 1.0** (see the `LICENSE` file): **free to use for any purpose, including personal, educational, and internal commercial use** — an organization may deploy CE on its own infrastructure and run its business on it without a commercial license. What it does **not** permit, without prior written permission, is selling, reselling, sublicensing, white-labeling, or commercially redistributing CE — or its engine, or any derivative — as a standalone product, or operating it as a **commercial hosted service** for third parties, or basing a product on it that competes with Veilio Cloud. For a commercial or redistribution license, contact `hello@veilio.dev`. These Terms supplement — and do not replace or limit — the Veilio Community License. If anything here conflicts with that license about the software grant itself, the **Veilio Community License controls**.

## 1. What CE is
CE is a **best-effort** code-anonymization tool that runs **entirely in your browser**. It replaces source-code identifiers with role-typed placeholder tokens (e.g. `__CLS__1`, `__FN__2`, `__VAR__3`) and restores them. **It does not guarantee that all sensitive data, secrets, or personal data are removed.** You are responsible for reviewing anonymized output before sharing it with any third party, including AI tools.

## 2. No accounts, no data collection
CE has no backend, no accounts, no analytics, and **no telemetry**. It collects, transmits, and stores **no data** about you. Symbol maps live only in your browser's `localStorage`; `.veilio` exports are encrypted on your device. **If you lose a `.veilio` passphrase, that file is permanently unrecoverable** — no one, including the authors, can recover it. See the [Privacy Notice](./privacy.md).

## 3. Your responsibilities
You run your own instance. You are responsible for the code and data you process with CE, for complying with all laws that apply to you, and for any deployment you expose to other people (including any logging your own hosting stack performs). CE is not directed to children; the minimum age for use is **16**, as stated in the [Privacy Notice](./privacy.md).

## 4. License, redistribution & trademarks
The Veilio Community License lets you use, study, modify, and fork the **code** for any purpose, including inside your own business, and share it non-commercially; it does not let you sell it, host it as a commercial service for others, or base a competing product on it. It does **not** grant any right to the **"Veilio" name or logo** (§11 of the license says so expressly). You may not use the Veilio name or logo in a way that implies endorsement by, or affiliation with, the Veilio project, and you must not present a modified version as the official Veilio. See the [Trademark Policy](https://github.com/veilio-inc/veilio/blob/main/TRADEMARKS.md).

## 5. Acceptable use
CE is a **local tool that runs entirely in your browser** — there is no Veilio-operated service to abuse, and we host nothing on your behalf. This section therefore governs how you may **use and redistribute CE**. Using or redistributing it, you agree **not** to:

- **Break the law** — use CE to process, store, or transmit content that is illegal where you operate (including CSAM, terrorist content, or stolen data).
- **Infringe rights** — use CE with code or data you have no right to use, or to violate third-party intellectual property, trade secrets, or privacy.
- **Misrepresent the tool** — present CE's best-effort anonymization as a guarantee of safety, compliance, or complete removal of sensitive data, or imply that the Veilio project has reviewed or endorsed your output.
- **Resell or repackage it** — sell, resell, sublicense, rebrand, or republish CE or its engine as a standalone product or service that competes with Veilio. (Using CE in your own projects, including commercial ones, is fine.) For a competing-use or redistribution license, contact `hello@veilio.dev`.
- **Misuse the brand** — redistribute a modified build as the official "Veilio", or otherwise use the Veilio name or logo in violation of the [Trademark Policy](https://github.com/veilio-inc/veilio/blob/main/TRADEMARKS.md).
- **Weaponize anonymization** — deliberately use identifier obfuscation to bypass another party's security, data-loss-prevention, or detection controls for malicious ends.

**5.1 No monitoring.** Because CE runs only on your own machine, the Veilio project does not — and cannot — monitor, access, or review your use of it.

**5.2 Enforcement.** CE is source-available software (Veilio Community License 1.0), so there is no account for us to suspend. We may, however, enforce the license, trademark, and intellectual-property terms above, and we will cooperate with lawful requests from law enforcement or regulators where required.

**5.3 Reporting.** Report abuse of the Veilio name or genuine safety concerns to `abuse@veilio.dev`. Security vulnerabilities: see [SECURITY.md](https://github.com/veilio-inc/veilio/blob/main/SECURITY.md).

> For the hosted **Veilio Cloud** service, acceptable use is **§9 of the Cloud [Terms of Service](https://veilio.dev/legal/terms)**, which additionally governs accounts, messaging, rate limits and shared infrastructure.

## 6. Warranty disclaimer & limitation of liability
CE is provided **"AS IS", without warranty of any kind**, to the maximum extent permitted by applicable law. There is **no warranty that anonymization is complete, accurate, or error-free.** To the maximum extent permitted by applicable law, the authors and copyright holders are **not liable** for any claim, damage, loss, or other liability — including any sensitive data exposed despite anonymization — arising from or in connection with CE or its use.

## 7. Changes
We may update these Terms; the version and date above reflect the current text. Material changes will be reflected by a version bump in this file.

_Questions: `support@veilio.dev`._
