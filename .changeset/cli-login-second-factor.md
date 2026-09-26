---
'@veilio-inc/cli': patch
---

`veilio login` now works on an account with two-factor authentication: it asks for the authentication code (or a recovery code) and completes the sign-in. Before, it stored the short-lived challenge instead of a session and then reported the password as wrong.
