---
'@veilio-inc/mcp': patch
---

The README says when the server reads the team namespace again: after `veilio team unlock`, after a team map is created or updated or any map is removed through the server, after `projects_use` changes the project, and, with `VEILIO_PROJECT` set, when that name points to another project. It also says the server has two runtime dependencies, the engine and the CLI, both from this repository, and none from third parties. Before, it said "zero runtime dependencies".
