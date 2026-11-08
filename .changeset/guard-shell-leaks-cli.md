---
'@veilio-inc/cli': patch
---

`veilio scan` and `veilio scrub` show a credential's preview as its last four characters and its length (`…vJKx (39 chars)`; `•••• (9 chars)` for 12 characters or fewer), never its first characters.
