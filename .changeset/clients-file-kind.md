---
'@veilio-inc/cli': patch
'@veilio-inc/mcp': patch
---

`veilio scrub`, `veilio scan` and the MCP server's `anonymize_file` and `scan_secrets` tell the engine each file's kind (dotenv, YAML, shell), never its path, so every file is still judged strictly. In those files a strong credential assigned to an environment-style name - `DB_PASSWORD=…`, `GITHUB_TOKEN: …`, `export STRIPE_SECRET_KEY=…` - is redacted, quoted or not, and no piece of it reaches the symbol map; a weak one is handled as the quoted `password = "…"` form is (reported and left as written, or masked as a name when short). Requires `@veilio-inc/engine` 1.13.0 or later (the `fileKind` option). Text from stdin, or passed inline, has no file kind and is read as before.
