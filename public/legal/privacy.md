# Privacy Policy / Polityka Prywatności — DRAFT

> ⚠️ **DRAFT skeleton — NOT legal advice.** Must be reviewed and finalized by a
> Polish radca prawny / adwokat (IT + RODO) before publication. Bracketed
> `[…]` items need founder/lawyer input. Aligned to RODO (GDPR) + Polish UODO.

_Last updated: [DATE] · Version: [v1]_

## 1. Administrator (Controller)
- Entity: **[legal name / JDG or sp. z o.o.]**, **[address]**, NIP **[…]**, REGON **[…]**.
- Contact: `privacy@veilio.dev` · `support@veilio.dev`.
- Data Protection contact / IOD: **[appoint or state "not required, rationale documented"]**.

## 2. What data we process & why (legal basis — RODO art. 6)
| Data | Purpose | Legal basis |
|---|---|---|
| Email, password hash | Account + authentication | art. 6(1)(b) contract |
| IP, user-agent, session + audit logs | Security, fraud prevention, abuse handling | art. 6(1)(f) legitimate interest |
| Subscription + billing metadata (via Stripe) | Provide paid service, invoicing | art. 6(1)(b) + (c) legal obligation (tax) |
| **Encrypted map envelopes** | Cloud sync of symbol maps | art. 6(1)(b) — **zero-knowledge: we store only ciphertext and cannot read map contents** |
| Team membership / invites | Team features | art. 6(1)(b) |
| Marketing email (if any) | Product updates | art. 6(1)(a) consent (opt-in) |

We do **not** receive or store your source code. Cloud maps are encrypted in your
browser with a passphrase only you hold; we cannot decrypt them.

## 3. Retention
| Data | Retention |
|---|---|
| Account data | Until deletion + [30] days backup window |
| Audit/security logs | [12 months], then pseudonymized/erased |
| Sessions | Until expiry/revocation |
| Invoices | [5 years] (Polish tax law) |

## 4. Recipients / Subprocessors
- **Stripe** (payments) · **Resend** (email) · **Cloudflare** (CAPTCHA/DNS) · **Hetzner** (EU hosting) · **Google / Microsoft** (SSO, only if you use SSO).
- International transfers covered by **Standard Contractual Clauses** where applicable. Hosting is in the **EU**.

## 5. Your rights (RODO art. 15–22)
Access, rectification, **erasure** (in-app: Delete account), **portability** (in-app: Export my data), restriction, objection, withdraw consent. Exercise via `privacy@veilio.dev`. You may lodge a complaint with **UODO** (ul. Stawki 2, Warszawa).

## 6. Cookies / local storage
We use **strictly-necessary** browser `localStorage` (the `veilio_token` session) and the **Cloudflare Turnstile** anti-abuse widget. No third-party advertising/tracking cookies. See [COOKIES.md](./COOKIES.md).

## 7. Security & breaches
Encryption in transit (TLS) and at rest where applicable; zero-knowledge cloud maps. In a breach affecting your rights we notify **UODO within 72h** and you where required.

## 8. Changes
We post updates here and bump the version; material changes are notified in-app.
