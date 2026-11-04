---
'@veilio-inc/cli': patch
---

Inside Claude Code without veilio-guard, every command prints one line to stderr saying that the CLI masks only what passes through it and how to install the guard. Standard output and exit codes are unchanged; `--quiet` and `CI` silence it.
