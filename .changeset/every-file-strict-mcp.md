---
'@veilio-inc/mcp': patch
---

The README says that `anonymize_file` and `scan_secrets` read every file strictly: a weak password in a secret position (`PGPASSWORD=Summer24`, a password flag, the password in a URL, an auth header) is redacted in test, fixture and example files too, as in the CLI and the Claude Code guard. The test that reads the home directory now sets up its own.
