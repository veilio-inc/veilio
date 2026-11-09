---
'@veilio-inc/cli': patch
---

A team map write that Cloud refuses because it was sealed under a team-key version this account does not hold now says so, in the CLI and in the MCP tools, instead of reporting a key change owed. `veilio team unlock`, when it sets up a team's first key, sends the fingerprint of the key it wrapped to; if that key changed meanwhile, it says so and stores nothing.
