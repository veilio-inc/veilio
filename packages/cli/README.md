# @veilio-inc/cli

Anonymize code before it reaches an LLM, restore it after — from a terminal, a pipe, or a pre-commit hook.

```bash
veilio scrub src/billing.ts | pbcopy     # mask, then paste anywhere
pbpaste | veilio restore                 # bring the answer back
git diff --cached | veilio scan          # refuse to commit a live key
```

Full guide - terminal, Cloud sign-in, and connecting AI assistants (Claude Code, Claude Desktop, Xcode, Cursor, VS Code): [docs/USING-THE-CLI-AND-MCP.md](../../docs/USING-THE-CLI-AND-MCP.md).

## Install

```bash
npm install -g @veilio-inc/cli     # or run it without installing:
npx @veilio-inc/cli scrub src/billing.ts
```

Requires Node 24 or newer. Signed out, there is no account, no API key, and no
network call on `scrub`, `restore`, `scan` or `map` — `packages/cli/tests/purity.test.ts`
and `offline.test.ts` walk the import graph and trap the network globals to keep
it that way. Signing in is optional. Signed in to a team, `scrub` and `restore`
also read the team's maps (below), so a teammate's placeholders mean the same
thing in your terminal; `scan` and `map` stay offline either way. To keep a
signed-in `scrub` offline, `veilio logout` first.

## Commands

| Command              | Purpose                                                               |
| -------------------- | --------------------------------------------------------------------- |
| `scrub [files...]`   | Mask identifiers, redact credentials. Reads stdin when given no file. |
| `restore [files...]` | Swap placeholders back, strip AI-generated noise. Signed in, also a teammate's placeholders — see below. Names anything it could not restore; `--strict` writes nothing if a placeholder would be left. |
| `scan [files...]`    | Detect credentials only. Never rewrites. Exits 1 on findings.         |
| `map`                | Show the symbol map (`--clear` to wipe it).                           |

## Cloud sync (Individual plan and above)

```bash
veilio login                    # email, password, and the authentication code if 2FA is on
veilio whoami                   # who you're signed in as, no request made
veilio maps list                # ids, scope and symbol counts for everything in Cloud
veilio maps pull <id>           # decrypt locally, write second — never a partial write
veilio maps push [name]         # upload the local map under a new Cloud name
veilio team unlock              # open the team key with your vault passphrase (kept 7 days)
veilio team lock                # remove the unlocked team key from this machine
veilio rules pull               # fetch your custom rules; scrub then applies them offline
veilio logout                   # revokes server-side, then removes the local credential
```

The session token lives in a single file under your home directory
(`~/.veilio/credential.json` on Linux/macOS, `%USERPROFILE%\.veilio\credential.json`
on Windows), created at mode `0600` and never written until the server has
accepted the sign-in. `0600` is the floor, not the final answer — the OS
keychain is a stronger option and a planned follow-up. A personal map is
zero-knowledge: pulling or pushing one prompts for the vault passphrase and
derives the key here, on your machine — the passphrase and the key never
leave it. A team map is sealed under the team key, which the server cannot
read either; `veilio team unlock` opens it here with your vault passphrase.

Custom rules (whitelist and replace, set in the web app) are applied by
`scrub` from a local copy that `veilio rules pull` writes to
`~/.veilio/rules.json` (`0600`). `scrub` never fetches them itself - it stays
offline - and says on every run how many rules it applied and how old the copy
is. Pull again after the rules change; `logout` removes the copy.

Three files, all `0600`, all under `~/.veilio/`: `credential.json` (the session,
removed by `logout`), `rules.json` (the rules copy) and `team-keys.json` (the
keys `team unlock` opened, kept seven days).

### Scrubbing with the team's numbering

Signed in to a team with the team key unlocked, `veilio scrub` numbers from the
team's maps, as the web app and the MCP server do: a name the team already knows
gets the team's placeholder, and a new name is numbered above the team's and
this project's highest, so it can never take a number that means something else
to a teammate. Only the team entries the output uses are kept in this project's
map. The summary says `Namespace: team`.

- **Locked or unreachable, it still masks** — from this project's map — and says
  so on stderr, with the reason, even under `--quiet`: those placeholders may
  clash with the team's.
- **Signed out, it makes no request**, exactly as before. Signed in, it waits at
  most **5 seconds** for Cloud.

### Restoring a teammate's placeholders

`veilio restore` resolves a placeholder this project's map cannot explain
against the team's maps, so a reply pasted from a teammate's agent comes back
with the real names:

- **A disputed placeholder is left, not guessed.** Where this project's store
  and the team use the same placeholder for *different* identifiers, neither
  wins and the placeholder stays in the output with a line naming it. Same for
  one this project numbered on its own while the team was out of reach — a
  wrong name restored silently is worse than a placeholder left visibly.
- **Locked, and it says so.** With no team key on this machine it tells you to
  run `veilio team unlock` rather than restoring half the text.
- **Signed out, it makes no request at all** — that restore is as offline as it
  has always been. Signed in, it waits at most **5 seconds** for Cloud, so a
  hung instance cannot stall `… | veilio restore > file`.
- **The counts are this project's.** "Restored 8 of 9" is measured against your
  own map, not against a team namespace of four hundred entries.

The map commands are clients of `GET /api/maps`, `GET /api/maps/:id` and
`POST /api/maps` — the exact same routes the browser uses, behind the exact
same entitlement check. There is no CLI-shaped API and nothing here can reach
a plan feature the web app couldn't.

## Options

```
-l, --language <lang>   auto (default), typescript, python, go, java, csharp,
                        rust, ruby, php, c, sql
-s, --secrets <policy>  redact (default) | warn | off
-p, --preamble          Prepend the downstream-AI note and placeholder legend
-m, --map <path>        Use a specific map file
    --json              Machine-readable output (scan, map)
    --strict            scan: also fail on advisory findings. restore: write
                        nothing and exit 1 if a placeholder would be left
    --keep-docs         restore: keep JSDoc blocks the model wrote
-f, --force             Allow a map write that would drop existing entries
-q, --quiet             Suppress the all-clear summary (findings always show)
    --instance <url>    login: the Veilio instance to sign in to. Defaults to
                        the public Cloud; https required (localhost excepted)
-h, --help              Show this help
-v, --version           Show the version
```

`restore --strict` is for pipelines that write the restored text somewhere: if a
placeholder would be left in it — one the AI invented, one whose shape it changed
(`__fn__1`), one the team's maps disagree on, or one the team's maps could not be
read for — nothing goes to stdout and it exits 1. Without it, restore writes the
text, placeholders and all, names each one on stderr and exits 0. A credential
redacted on purpose is not a placeholder and never fails it.

`--keep-docs` is worth knowing about: the default strip removes JSDoc along with
the narration and TODOs, which is wrong when the model was *asked* to document
its output. `--quiet` suppresses the all-clear only — a finding still prints,
because the text on stdout is what you are about to paste somewhere.

## Piping

Transformed code goes to **stdout**; summaries, warnings and errors go to **stderr**. That split is what makes the CLI composable — the summary stays visible without corrupting the pipe.

### On Windows

`pbcopy` and `pbpaste` are macOS. In PowerShell, first make pipes UTF-8 in both
directions for the session (or put the line in your `$PROFILE`):

```powershell
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new()
veilio scrub src\billing.ts | Set-Clipboard
Get-Clipboard -Raw | veilio restore
```

Without that line, how a pipe treats non-ASCII text depends on the PowerShell
version and the console's code page: Windows PowerShell 5.1 sends text piped
into Veilio as ASCII, so `Get-Content file | veilio scrub` turns every `ż` into
`?` before Veilio sees it, and restore cannot bring it back. Text piped out of
Veilio is read with the console's code page, which may not be UTF-8. Passing
files as arguments (`veilio scrub file`, `veilio restore answer.txt`) avoids
the first problem; the line above avoids both. In 5.1, `>` also writes UTF-16,
so write files from PowerShell 7 (`pwsh`).

## Exit codes

| Code | Meaning                                |
| ---- | -------------------------------------- |
| 0    | Clean                                  |
| 1    | Findings that should stop the pipeline: a credential (`scan`), or a placeholder `restore --strict` would have left |
| 2    | Usage or IO error                      |

As a pre-commit hook:

```bash
#!/bin/sh
git diff --cached | veilio scan || {
  echo "Commit blocked: credentials detected." >&2
  exit 1
}
```

## The symbol map

`scrub` writes `.veilio/map.json` at the project root and `restore` reads it, so placeholders stay stable across runs and across a whole session. The store is created `0600` with its own `.gitignore` — it holds the real identifier names, so committing it would undo the anonymization for anyone reading the repo.

Redacted credentials are **not** in the map. `restore` cannot bring them back, by construction.

## In CI

### GitHub Action

```yaml
- uses: veilio-inc/veilio/packages/cli@v0.1.0
  with:
    strict: false # also fail on emails / private IPs
    sarif: veilio.sarif # optional: upload to code scanning
```

**This example does not work yet, and needs a tag that does not exist.** The
`@v0.1.0` ref is a git tag on this repository, and the tags here are `engine-v*`
(cut by semantic-release for the engine) and `@veilio-inc/cli@*` /
`@veilio-inc/mcp@*` (cut by Changesets when the tools release) — neither shape
matches. The Action's own script runs `npx --yes @veilio-inc/cli@<version>`,
which is satisfied now that the CLI is published; what is left is a `v*.*.*` tag
someone has to cut, and note that `v*.*.*` is also what triggers the Community
Edition release workflow, so the two are not independent.

Scans the **pull-request diff** by default, not the whole tree. A repo adopting
this mid-life almost always has a historical finding somewhere; blocking every PR
on that is how a security check gets switched off in week one. Pass `paths:` to
scan a fixed set instead.

Findings land in the job summary and, with `sarif:`, in GitHub code scanning.
Reports carry truncated previews only — a stored, shareable artifact must never
contain the credential it is reporting.

### Pre-commit

Via the [pre-commit framework](https://pre-commit.com):

```yaml
repos:
  - repo: https://github.com/veilio-inc/veilio
    rev: v0.1.0
    hooks:
      - id: veilio-scan
```

Or a plain git hook:

```bash
cp packages/cli/hooks/pre-commit .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit
```

It scans the **staged** diff — what you are about to commit is what matters, and
a finding in an unstaged scratch file shouldn't block you. `--no-verify`
overrides, as usual.
