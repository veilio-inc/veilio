---
'@veilio-inc/cli': patch
---

The README says that `scrub` and `scan` read every file strictly: a weak password in a secret position (`PGPASSWORD=Summer24`, a password flag, the password in a URL, an auth header) is redacted in test, fixture and example files too, as in the MCP server and the Claude Code guard. Tests that read the home directory now set up their own, so `npm test` passes on a machine where someone is signed in.
