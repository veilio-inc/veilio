---
'@veilio-inc/mcp': patch
---

`VEILIO_PROJECT` in the server's environment pins its project. Set it in a repository's `.mcp.json` `env`, and an agent in that repository works in that project only, whatever `veilio projects use` stored for the shared sign-in.

- The map tools, `team_status`, `projects_list` and the team namespace that `anonymize_*` and `restore_text` use all follow it. Results that name the project say "(from VEILIO_PROJECT)".
- A value naming no project your team works in, or a name two projects share, makes those tools return an error naming it. The masking tools refuse rather than mask from the local map.
- `projects_use` still stores a choice, and warns that the server's `VEILIO_PROJECT` overrides it.
- Two servers in one HOME with different values scope independently.
- The namespace is kept for the project's id, not for the value's spelling. If that project is renamed and another is given the old name while the server runs, the next `anonymize_*` or `restore_text` call after 30 s uses the new one (the check is one project listing, at most every 30 s, and only while the variable is set).
- A masking call asks which project the variable names at most every 30 s, gives the listing 3 s, and masks from the cache when Cloud does not answer. `projects_use` leaves the namespace alone while the variable overrides it, and says the choice was saved, not that the server works in it.
