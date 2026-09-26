---
'@veilio-inc/cli': patch
'@veilio-inc/mcp': patch
---

The MCP server reads the whole team namespace in one request (`GET /api/maps/team-envelopes`) instead of one request per team map, which ran into the maps rate limit on larger teams. A failed read reports the `local` namespace rather than a team namespace silently missing maps. Instances without the endpoint are still read one map at a time.
