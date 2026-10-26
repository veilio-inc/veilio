---
'@veilio-inc/cli': patch
---

Each command now refuses a flag that is not its own, instead of ignoring it. Given `--days 3`, `scrub` used to run, and `--days` did nothing. Now it exits 2 with `unknown option --days. Options for scrub: …`, naming the options `scrub` does take. A script that passed a flag to a command that never used it will now stop at that flag. Remove the flag, or move it to the command it belongs to. `--help` and `--version` still work with any command. `--instance` belongs to `login` only, which is the only command that reads it.

`veilio --help` lists, under each option, the commands it belongs to. One table in the CLI drives both that list and the check, so the two cannot disagree.
