---
'@veilio-inc/cli': patch
---

`VEILIO_PROJECT=<name|id>` overrides the project chosen with `veilio projects use`, for that process only. A CI runner starts clean, so a pipeline can now pick its project without a stored choice.

- The order is `VEILIO_PROJECT`, then the stored choice, then none. An empty value counts as unset. The value is resolved through Cloud's own project listing and is never written down.
- A value naming no project your team works in, or a name two projects share, is refused, naming the value and `VEILIO_PROJECT`. Nothing falls back to the stored choice or the default, and no request carries another project. `scrub` and `restore` refuse too, rather than number from the local map.
- `maps list`, `whoami` and `projects` say "(from VEILIO_PROJECT)" when the variable chose the project. `projects` marks it, and still lists when the value names none. `projects use` stores the choice and warns that the variable overrides it in this shell.
- Signed out, nothing changes.
