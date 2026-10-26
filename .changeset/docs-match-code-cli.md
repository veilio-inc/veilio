---
'@veilio-inc/cli': patch
---

`veilio --help` lists `--device` for `login`. It also says that `scan` exits 1 on a credential, and on any finding with `--strict`. Before, it said "when it finds something", but an email or a private IP exits 0 without `--strict`. The README now says the same. It lists the `DELETE /api/maps/:id` route that `maps rm` uses, and says that the pre-commit framework hook is not supported yet: the repository has no `.pre-commit-hooks.yaml` and no `v*` tag.
