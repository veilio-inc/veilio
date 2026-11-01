---
"@veilio-inc/cli": minor
"@veilio-inc/mcp": minor
---

Custom rules are sealed under your own keys: personal rules under your personal-maps key, team rules under the team key, re-sealed on rotation. The server stores them but cannot read them. A rule's placeholder base is sent only as a hash when numbers are reserved. A locked vault or team key masks without rules and says so, with the number of rules skipped.
