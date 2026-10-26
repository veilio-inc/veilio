---
'@veilio-inc/cli': patch
---

`-f` is `--force` again, as the README and `--help` say. Since 0.5.4 it set `--team` instead, so `veilio maps pull <id> -f` asked for a team map and forced nothing.
