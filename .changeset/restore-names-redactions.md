---
'@veilio-inc/cli': minor
'@veilio-inc/mcp': minor
---

`restore` and `restore_text` now name every redaction left in the text (`__REDACTED_CREDENTIAL_1__`): a redacted value is gone for good, so the restored text is not the original file and must not be written over it. `--strict` (and `strict` in `restore_text`) now withholds such text.
