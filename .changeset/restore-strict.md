---
'@veilio-inc/cli': minor
'@veilio-inc/mcp': minor
---

Name the placeholders the AI changed the shape of, and let a pipeline or an agent refuse a restore that would leave any placeholder behind.

- A placeholder whose case or underscores the model changed (`__fn__1`, `_FN__1`) was passed through without a word; no map can restore it. `veilio restore` now names it on stderr (also under `--quiet`), and `restore_text` names it in a WARNING line. The rule is the engine's (`report.altered`, engine 1.8.0), so the web app says the same.
- `veilio restore --strict`: if a placeholder would be left in the text (invented, altered, disputed between the team's maps, numbered locally), nothing is written to stdout, they are named, and it exits 1. A credential redacted on purpose never fails it.
- `restore_text { strict: true }`: the same rule; an error result carrying the report and no text.

Needs `@veilio-inc/engine` 1.8.0 or later (the floor is raised when the engine is published).
