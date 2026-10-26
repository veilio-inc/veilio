---
'@veilio-inc/mcp': minor
---

Map, team and project tools for a signed-in agent (spec 052): `maps_list`, `maps_pull`, `maps_create`, `maps_update`, `maps_remove`, `team_status`, `projects_list` and `projects_use`. Each runs the `veilio` CLI's own code and refuses in the same words.

- With no sign-in, as in the Community Edition, the server lists only its five offline tools, exactly as before.
- Removing a map, or an update that drops entries, is off unless the server is started with `VEILIO_MCP_DESTRUCTIVE=1`. Even then, a removal must repeat the map's exact name.
- Personal maps open with the key `veilio vault unlock` keeps. The server never asks for or receives a passphrase.
- No result contains a passphrase, a key, a wrapped key or an encrypted map. A clash names placeholders, never the real names behind them.
- The team namespace reloads when the project changes, or after a team map is written through the server.
