---
'@veilio-inc/mcp': patch
---

`anonymize_text` and `anonymize_file` refuse when Cloud rate-limits the read of the team's maps (429) and the machine knows the account's team, saying to run the command again in a minute, instead of masking from the local namespace. The other fallbacks (team key locked, Cloud unreachable or failing) are unchanged.
