---
'@veilio-inc/cli': minor
---

**Breaking:** a flag a command doesn't use now stops with exit 2; it used to be ignored. Given `--days 3`, `scrub` used to run, and `--days` did nothing. Now it stops with `--days is not an option for scrub. Options for scrub: …`, naming the options `scrub` does take. A script that passed a flag to a command that never read it stops at that flag. Remove the flag, or move it to the command it belongs to.

- An unknown flag on a command uses the same wording: `unknown option --dayz. Options for scrub: …`. A line with no command keeps the general `unknown flag` form.
- `--help` or `-h` anywhere on the line wins. It prints that command's help and exits 0, even after a flag the command does not take. A group with no action (`maps --help`) shows all its actions.
- Flags may come before the command, and are checked against it: `-q` before `scrub` is the same as `-q` after it. A line of flags with no command prints the general help and exits 2, unless the flags are only `--help` or `--version`.
- `--instance` belongs to `login`, the only command that reads it. `--help` and `--version` work with any command.
- `veilio --help` lists, under each option, the commands it belongs to, and keeps the notes on `--days` (7 days by default), `--device` (required for an SSO-bound account) and `--team` (for a map you intend to publish). One table in the CLI drives the commands, the parser check and the help, so they cannot disagree.
