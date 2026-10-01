---
'@veilio-inc/cli': minor
'@veilio-inc/mcp': minor
---

`veilio scrub` numbers from the team's namespace when signed in, as the web app and the MCP server do.

A staging walk found a team member's terminal giving `reverseEntry` the placeholder the team uses for `settleInvoice`: `scrub` numbered from the project's own map only. Now, signed in to a team with the key unlocked:
- a name the team knows gets the team's placeholder;
- a new name is numbered above the team's and the project's highest;
- only the team entries the output uses are kept;
- the summary says `Namespace: team`.

When the team's maps cannot be used, `scrub` says so and why, also under `--quiet`, and still masks from the project's map. That covers a locked key, Cloud being unreachable, and no answer within 5 seconds. Signed out, it makes no request, as before. The composition is shared with the MCP server's anonymize tools, so the two give identical placeholders for the same input.
