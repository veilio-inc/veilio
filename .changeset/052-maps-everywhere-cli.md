---
'@veilio-inc/cli': minor
---

Maps everywhere, from the terminal (spec 052).

- `veilio maps update <id>` replaces a Cloud map's entries with the local map's, in place. The id, name and project stay the same, and there is still one map. It is refused, with the reason and the fix, when it would drop entries (unless `--allow-drop`), when a placeholder clashes with another of the team's maps, when the map is a teammate's, when the team owes a key change, or when the map changed in Cloud since it was read.
- `veilio projects` and `veilio projects use <name|id>` choose the project this sign-in works in. Team maps, pushes, updates and `scrub --team` then use only that project. The choice is kept with the sign-in, so the MCP server uses it too.
- `veilio vault unlock [--days N]` and `veilio vault lock` keep a personal-maps key on this machine: a key that opens personal maps and nothing else. The passphrase and the vault key are never kept. The first unlock creates the key and re-seals older personal maps under it. `logout` removes it.
- A refusal caused by a team map that cannot be opened now names that map.
- Every refusal names its reason and what resolves it. The words come from one table, which the MCP server shares.
- New: `@veilio-inc/cli/client`, the Cloud operations the MCP server's tools use.
- With no sign-in, `scrub`, `restore`, `scan` and `map` behave exactly as before, byte for byte.
