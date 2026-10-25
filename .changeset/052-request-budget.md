---
'@veilio-inc/cli': patch
'@veilio-inc/mcp': patch
---

Fewer requests per command, so a scripted run or an agent no longer hits Cloud's maps rate limit. A team push or update now reads the listing once and the team's maps once, and gets the map being updated from that same read rather than downloading it again: three requests, down from five. A rate-limited answer (429) is no longer retried, because a retry only counts against the same limit. The MCP server reads the team namespace once per project, and again only after a team write or a change of project. Tests pin a request budget for each command against the built binary, over real HTTP.
