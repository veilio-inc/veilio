# Cookie & Local Storage Notice — DRAFT

> ⚠️ **DRAFT skeleton — NOT legal advice.** Finalize with a Polish radca prawny
> (Prawo telekomunikacyjne / ePrivacy).

_Last updated: [DATE]_

Veilio uses **no third-party advertising or tracking cookies.** We use only:

| Item | Type | Purpose | Consent |
|---|---|---|---|
| `veilio_token` | localStorage | Keeps you signed in (session JWT) | Strictly necessary — no consent required |
| Cloudflare **Turnstile** | script/cookie | Bot/abuse protection on sign-up & sign-in | Strictly necessary (security) |
| Vault key (optional) | in-memory / sessionStorage (only if you opt into "remember this tab") | Decrypt cloud maps client-side | Strictly necessary for the feature you enabled |

Because we only use strictly-necessary storage, a consent banner is generally
not required — **[lawyer to confirm given Turnstile]**. If we later add
analytics or marketing, we will add a consent mechanism first.

You can clear this data anytime via your browser; clearing it signs you out and
forgets an opted-in vault key.
