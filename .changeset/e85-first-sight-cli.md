---
'@veilio-inc/cli': patch
---

`veilio scrub` (with or without `--team`) refuses when Cloud rate-limits the read of the team's maps (429), saying to run the command again in a minute, instead of numbering new names on this machine. `veilio --help` shows a scan example that runs (`veilio scan src/*.ts`; the CLI expands no globs, so a quoted one named a file that does not exist), and `veilio team trust --help` says it needs a sign-in.
