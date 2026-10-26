---
'@veilio-inc/mcp': patch
---

`VEILIO_PROJECT` in the server's environment pins its project. Set it in a repository's `.mcp.json` `env`, and an agent in that repository works in that project only, whatever `veilio projects use` stored for the shared sign-in.

- The map tools, `team_status`, `projects_list` and the team namespace that `anonymize_*` and `restore_text` use all follow it. Results that name the project say "(from VEILIO_PROJECT)".
- A value naming no project your team works in, or a name two projects share, makes those tools return an error naming it. The masking tools refuse rather than mask from the local map.
- `projects_use` still stores a choice, and warns that the server's `VEILIO_PROJECT` overrides it.
- Two servers in one HOME with different values scope independently.
