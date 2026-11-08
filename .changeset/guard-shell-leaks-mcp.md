---
'@veilio-inc/mcp': minor
---

`restore_text` is off unless you start the server with `VEILIO_MCP_RESTORE=1` in its configuration. When the agent calls it, the restored text - the real names - is in the agent's context from then on, and an instruction hidden in a file the agent reads could ask for it. To restore an answer without that, run `veilio restore` in a terminal. With the variable set, the server says so on start (stderr).

`anonymize_file` and `scan_secrets` refuse a file on Veilio's raw-only list (.env, private keys, credential stores, .veilio/) - as written, through a link, or under a Windows stream or short name - and the server's own map, aliases and reservations files wherever they live. A credential preview shows only the last four characters and the length (`…vJKx (39 chars)`; `•••• (9 chars)` for 12 characters or fewer).
