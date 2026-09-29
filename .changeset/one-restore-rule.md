---
'@veilio-inc/cli': patch
'@veilio-inc/mcp': patch
---

One restore rule for the web app, the CLI and the MCP server.

Requires `@veilio-inc/engine` 1.7.0 (`restoreLayers`, `analyzeTeamNamespace`), released by semantic-release from the engine commit.

- **cli:** `veilio restore` now restores a teammate's placeholders from the team's maps.
  - A disputed or locally numbered placeholder is left and named, never guessed.
  - With the team key locked, it says to run `veilio team unlock`.
  - Signed out, it makes no network request. Signed in, it waits for Cloud for 5 seconds at most.
  - The counts are measured against this project's map.
- **mcp:**
  - `restore_text` follows the same rule, and aliases now restore.
  - A locked or unreadable team gives an error result that says why, and the namespace line says why it is `local`.
  - A `veilio team unlock` run after the server started is picked up without a restart.
  - Anonymizing after a lapse uses the team's placeholders instead of the ones the project numbered during the lapse, which teammates would have restored to a different identifier.
