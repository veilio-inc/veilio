# @veilio-inc/cli

Anonymize code before it reaches an LLM, restore it after — from a terminal, a pipe, or a pre-commit hook.

> **Veilio is a set: install the guard, the CLI and the MCP server together.** Each does one job, and all three share one map (`.veilio/map.json`).
>
> - **[veilio-guard](../../plugins/veilio-guard/README.md)** keeps your names from the model while a coding agent works: it masks everything the agent reads - files, command output, search results and your prompts. Claude Code today; other agents are in progress.
> - **The CLI (this package)** does what the guard cannot, because the guard makes no network call: `veilio scrub` builds the map before the first session, `veilio maps pull` brings in your team's map and its numbers, `veilio rules pull` your custom rules, `veilio restore` brings back the names in an answer, and `veilio scan` stops a live key in a commit or in CI.
> - **[The MCP server](../mcp/README.md) (`@veilio-inc/mcp`)** gives the agent tools of its own: read a file masked, restore an answer, scan for secrets. In an agent the guard does not cover yet, it is the way in - with the agent's own file and shell tools turned off.
>
> **Without the guard, the CLI and the MCP server protect only what passes through them.** An agent that reads files and test output with its own tools sends them to the model as written: in our benchmark (spec 067, run 3), project names reached the model in 93-95 of 96 sessions with the MCP server or the CLI alone, and in 0 of 96 with the guard.

```bash
veilio scrub src/billing.ts | pbcopy     # mask, then paste anywhere
pbpaste | veilio restore                 # bring the answer back
veilio scan .env config.yml             # refuse to commit a live key
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

| Command              | Purpose                                                                                                                                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scrub [files...]`   | Mask identifiers, redact credentials. Reads stdin when given no file.                                                                                                                                   |
| `restore [files...]` | Swap placeholders back, strip AI-generated noise. Signed in, also a teammate's placeholders — see below. Names anything it could not restore, a redacted value included; `--strict` writes nothing if a placeholder or a redaction would be left. |
| `scan [files...]`    | Detect credentials only. Never rewrites. Exits 1 on a credential; with `--strict`, on any finding.                                                                                                      |
| `map`                | Show the symbol map (`--clear` to wipe it).                                                                                                                                                             |

## Cloud sync (Individual plan and above)

```bash
veilio login                    # email, password, and the authentication code if 2FA is on
veilio login --device           # approve in a browser instead; no password typed here
veilio whoami                   # who you're signed in as, no request made
veilio maps list                # ids, scope and symbol counts for everything in Cloud
veilio maps pull <id>           # decrypt locally, write second — never a partial write
veilio maps push [name]         # upload the local map under a new Cloud name
veilio maps push --team [name]  # publish it as the team's shared map instead
veilio maps update <id>         # replace a Cloud map's entries with the local map's, in place
veilio maps rm <id>             # remove a map from Cloud
veilio projects                 # the projects your team works in; * marks the one in use
veilio projects use <name>      # work in that project (kept with the sign-in)
veilio team unlock              # open the team key with your vault passphrase (kept 7 days)
veilio team lock                # remove the unlocked team key, and the team rules, from this machine
veilio vault unlock             # keep the personal-maps key here (7 days), for the MCP server
veilio vault lock               # remove it, and the personal rules, from this machine
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

**Updating a map in place.** `veilio maps update <id>` replaces a Cloud map's
entries with the local map's and keeps its id, name and project, so refreshing a
map never leaves a second copy behind. Before anything is sent it refuses, and
says why:

- an update that would **drop entries** the Cloud map holds (a placeholder the
  local map lacks, or gives another name), with the count, unless you pass
  `--allow-drop` - text masked under the old meaning still depends on it;
- for a team map, a placeholder that **another team map** gives a different
  name - publishing it would leave it unrestorable for every member;
- a **teammate's map** - only its publisher updates or removes it.

The server refuses the rest: a team that owes a key change, and a map that
changed in Cloud since it was read (two writers never silently overwrite each
other). A team map is sealed with the team's current key; a personal map with
the personal-maps key.

**Projects.** A team map belongs to one project. `veilio projects use <name>`
chooses the one this sign-in works in: listing, pushing, updating and
`scrub --team` then use that project's team maps only, and the MCP server uses
the same choice. With none chosen, team maps of every project are used.

**`VEILIO_PROJECT`.** Set to a project's name or id, it overrides the stored
choice for that process only, and is never written down. That is what a CI job
needs: a runner starts clean, with no `projects use` behind it.

```sh
VEILIO_PROJECT=billing veilio scrub src/ledger.ts
```

The order is `VEILIO_PROJECT`, then the stored choice, then none. An empty
value counts as unset. A value that names no project your team works in, or a
name two projects share, is refused, naming the value: nothing falls back to
the stored choice or the default, and `scrub` and `restore` refuse rather than
number from the local map. Lines that name the project say so, as in "team maps
of project billing (from VEILIO_PROJECT)". `veilio projects` marks the one the
variable picked, and `veilio projects use` still stores a choice, but warns that
the variable overrides it in that shell. Signed out, it changes nothing.

**The personal-maps key.** `veilio vault unlock` asks for the vault passphrase
once and keeps, on this machine, only a key that opens personal maps - not the
passphrase, not the vault key, which also unlocks your team keys. The first time,
it creates that key and stores it in Cloud wrapped under your vault key, where
the server cannot read it; it also re-seals older personal maps under it. Then
`maps pull`, `push` and `update` - and the MCP server - open personal maps
without a passphrase. Without it, the CLI asks for the passphrase as before.

Custom rules (whitelist and replace, set in the web app) are applied by
`scrub` from a local copy that `veilio rules pull` writes to
`~/.veilio/rules.json` (`0600`). `scrub` never fetches them itself - it stays
offline - and says on every run how many rules it applied and how old the copy
is. Pull again after the rules change; `logout` removes the copy.

Cloud holds the rules sealed under your keys, so it cannot read them: personal
rules under your personal-maps key, team rules under your team key. `rules pull`
opens them on this machine, so it needs `veilio vault unlock` for personal rules
and `veilio team unlock` for team rules. A rule it cannot open is skipped, never
an error: `scrub` still masks, with the built-in engine and the rules that did
open, and both commands say what was skipped and how to fix it, one sentence per
cause (on every `scrub`, `--quiet` included).

The opened rules last only as long as the key they were opened with.
`veilio vault lock` removes the personal rules from `rules.json`, and
`veilio team lock` the team rules, until the next unlock and `rules pull`; both
say how many they removed, and the copy counts them as vault locked or team key
locked. A key that expires, or is deleted by hand, has the same effect without
a lock: `scrub` and the MCP server apply a cached rule only while its key is
still on this machine, unexpired and for this account. A `rules pull` while
locked does not bring them back:

```
2 custom rules not applied: vault locked - run `veilio vault unlock`, then `veilio rules pull`.
1 custom rule not applied: team key locked - run `veilio team unlock`, then `veilio rules pull`.
1 custom rule not applied: could not be opened with the keys on this machine, and skipped.
1 custom rule not applied: refused as unsafe to apply (an engine placeholder or a pattern rules do not support), and skipped.
```

When some rules applied and others did not, `scrub` says both in one line:

```
veilio: applied 1 custom rule pulled just now; 2 not applied: vault locked - run `veilio vault unlock`, then `veilio rules pull`.
```

Under `--quiet` it prints only what was not applied, in the sentences above.

"Could not be opened" is a rule sealed under a team-key version this machine
does not hold (run `veilio team unlock` again after a rotation) or a damaged
one. "Refused" is a rule no tool applies, whoever wrote it: a replace
placeholder that reuses an engine base such as `__FN__`, a pattern the rule
matcher does not support (a backreference, lookaround, `\b`, or a bound over
50), or a sealed body moved to another rule's row.

One `scrub` of one input spends a bounded amount of matching work on custom
rules, all rules and names together. Rules that would take more stop matching
part-way - the names after that point are masked as usual, none kept readable
or given a rule's placeholder - and `scrub` says so, under `--quiet` too:

```
veilio: custom rules stopped matching: too much work. Names after that point were masked as usual, and no rule kept one readable or gave it a rule placeholder.
```

Four files, all `0600`, all under `~/.veilio/`: `credential.json` (the session
and the chosen project, removed by `logout`), `rules.json` (the rules copy),
`team-keys.json` (the keys `team unlock` opened, kept seven days) and
`personal-maps-key.json` (the key `vault unlock` opened, kept seven days). `logout`
removes all of them.

### Scrubbing with the team's numbering

Signed in to a team with the team key unlocked, `veilio scrub` numbers from the
team's maps, as the web app and the MCP server do: a name the team already knows
gets the team's placeholder, and a new name is numbered inside this checkout's
block of team numbers (`.veilio/reserved.json`, below) - or, with no usable
block, in this checkout's local family `__LOCAL_<TAG>_<KIND>__n` - so it can
never take a number that means something else to a teammate. It is never
numbered above the team's highest: that is where the next teammate's block
starts. Only the team entries the output uses are kept in this project's map.
The summary says `Namespace: team`. `scrub` only reads `reserved.json`; it never
reserves, except with `--team`.

- **Locked or unreachable, it still masks** — from this project's map — and says
  so on stderr, with the reason, even under `--quiet`. It is still a team, so
  new names go into the local family (`__LOCAL_<TAG>_…`), never above the
  map. The team comes from the team unlock, else from `~/.veilio/team.json`
  (the team this account was last seen in, written by any command that lists
  it and removed by `veilio logout`); with no `reserved.json` yet, scrub writes
  one holding a fresh tag. With no team ever seen, new names still go into a
  local family, under a tag for that run only.
- **Signed out, it makes no request**, exactly as before. Signed in, it waits at
  most **5 seconds** for Cloud.

### Team numbers for the guard

The Claude Code guard makes no request, so it cannot ask the team for a number
each time it masks a new name. Instead, `veilio maps pull` of a team map (and
`veilio team unlock` in a project that already has a map) reserves a **block**
of the team's numbers for you - 500 per kind - and keeps it in
`.veilio/reserved.json`. The guard numbers new names inside it, so two members
working at the same time never give one placeholder two meanings. A pull takes
a new block whenever a teammate's newer numbers sit above yours.

A reservation sends Cloud a kind, a count and a floor - never a name. The
engine's own kinds (`__VAR__`, `__FN__`, `__CLS__`, ...) go as they are; a
custom replace rule's placeholder (`__ACME_ACQUISITION_TARGET__`) names what
the team considers sensitive, so it is sent as `__H_<16 hex>__`, an HMAC of it
under the newest team key, and read back locally. Teammates holding the same
key send the same hash. Cloud counts each hash on its own, so a rule's kind is
floored above the team's reservations of it under its hash with every team key
version this machine holds (read from the team's reservations, which are only
ever asked for by hash): after a key rotation new numbers stay above the old
hash's while the old key is still held; without it, the floor is the map's.
Without the team key unlocked, or without that listing (an older instance),
numbers for a rule's kind are not reserved at all.

Only numbers Cloud issued count toward a floor. A number in a map that no run
of the team's reservations holds - one numbered on this machine, or planted -
is checked against the team's listing of its kind (`?bases=`, with each kind's
highest number) and floors nothing; for a kind never reserved yet, a map's
numbers floor its first run up to 10000. A pull says how many such numbers the
map held, and restore leaves one above the highest number Cloud has issued for
its kind. (A map from before team numbering with numbers above 10000, in a kind
never reserved, therefore floors nothing; such teams existed only on staging.)
Every reservation asks for an answer per kind: a kind Cloud refuses is numbered
on this machine (`__LOCAL_…`), with the refusal shown, and the others are
reserved. An older Cloud that refuses the whole call names the kinds it
refuses, and is asked again without them.

If no block can be reserved - the day's limit, offline, the plan, a server
error - the pull (or the unlock) still succeeds, exits 0, and says so on its
normal output, with the reason and, for the day's limit, when the next block is
possible:

```
veilio: could not reserve team numbers: this account's daily limit for this team is reached; the next block is possible at 09:14 (local time). New names are numbered on this machine as __LOCAL_K7Q2XA_… until a block is held; your next publish gives them team numbers.
```

`reserved.json` is still written, with the reason, and a signed-in
`veilio scrub` repeats the sentence on stderr - even under `--quiet` - for as
long as it holds. Until a block is held, the guard, a signed-in
`veilio scrub` and the MCP server number new names in this checkout's **local
family**, `__LOCAL_<TAG>_<KIND>__n` (`__LOCAL_K7Q2XA_VAR__3`). The tag is six
characters drawn for this checkout, so two checkouts never mint the same
string:

- **This machine restores them**, from its map.
- **A teammate's restore leaves them as written** and names them: only the
  checkout that numbered one knows what it means.
- **The next team publish renumbers them** into reserved team numbers, keeps
  the old placeholders in `.veilio/aliases.json` (they still restore here),
  and draws a new tag.
- **No team map ever holds one.** A team map is sealed on your machine, so the
  check is here too: a publish that would still seal one is refused, naming
  them, and a reader drops one it finds - `maps pull` of a team map leaves
  them out of `map.json` and says how many.

### Restoring a teammate's placeholders

`veilio restore` resolves a placeholder this project's map cannot explain
against the team's maps, so a reply pasted from a teammate's agent comes back
with the real names:

- **A disputed placeholder is left, not guessed.** Where this project's store
  and the team use the same placeholder for _different_ identifiers, neither
  wins and the placeholder stays in the output with a line naming it. Same for
  one this project numbered on its own while the team was out of reach — a
  wrong name restored silently is worse than a placeholder left visibly.
- **Another checkout's local placeholder is left.** `__LOCAL_<TAG>_…` was
  numbered on a checkout that held no team numbers; only that checkout restores
  it, so it stays in the output, is named, and counts as left for `--strict`.
  Your own restore still reads it, through `.veilio/aliases.json` once a publish
  renumbered it.
- **Locked, and it says so.** With no team key on this machine it tells you to
  run `veilio team unlock` rather than restoring half the text.
- **Signed out, it makes no request at all** — that restore is as offline as it
  has always been. Signed in, it waits at most **5 seconds** for Cloud, so a
  hung instance cannot stall `… | veilio restore > file`.
- **The counts are this project's.** "Restored 8 of 9" is measured against your
  own map, not against a team namespace of four hundred entries.

The map commands are clients of `GET /api/maps`, `GET /api/maps/:id`,
`POST /api/maps`, `PATCH /api/maps/:id` and `DELETE /api/maps/:id` — the exact
same routes the browser uses, behind the exact same entitlement check. There is no CLI-shaped API and nothing here can reach
a plan feature the web app couldn't.

## Options

```
-l, --language <lang>   auto (default), typescript, python, go, java, csharp,
                        rust, ruby, php, c, sql
                        For: scrub
-s, --secrets <policy>  redact (default) | warn | off
                        For: scrub
-p, --preamble          Prepend the downstream-AI note and placeholder legend
                        For: scrub
-m, --map <path>        Use a specific map file
                        For: scrub, restore, map, maps pull, maps push, maps
                        update, team unlock
    --json              Machine-readable output
                        For: scan, map
    --blobs <listing>   scan the files a `git diff --raw --no-abbrev` listing
                        names, their content read from `git cat-file --batch`
                        on stdin (used by the pre-commit hook and the GitHub
                        Action)
                        For: scan
    --name <path>       scan stdin as if it were the file <path> (its file
                        type decides the rules; used by the pre-commit hook)
                        For: scan
    --strict            scan: also fail on advisory findings. restore: write
                        nothing and exit 1 if a placeholder or a redaction
                        would be left
                        For: scan, restore
    --keep-docs         Keep JSDoc blocks the model wrote
                        For: restore
    --clear             Wipe the symbol map
                        For: map
-f, --force             Allow a map write that would drop existing entries
                        For: scrub, maps pull
    --team              scrub: number new placeholders out of the team's
                        shared allocation, for a map you intend to publish.
                        maps push: publish as the team's shared map
                        For: scrub, maps push
    --days <n>          Keep the key for n days (1 to 30; 7 by default)
                        For: team unlock, vault unlock
    --allow-drop        Allow dropping entries the Cloud map has and the local
                        map does not
                        For: maps update
-q, --quiet             Suppress the all-clear summary (findings always show)
                        For: scrub, restore, scan
    --device            Sign in through a browser instead of typing a password
                        here. Required for an SSO-bound account, and used
                        automatically when the instance asks for a CAPTCHA
                        For: login
    --instance <url>    The Veilio instance to sign in to. Defaults to the
                        public Cloud; https required (localhost excepted)
                        For: login
-h, --help              Show this help
-v, --version           Show the version
```

Each command takes only the options listed for it. A flag on a command it
does not belong to is refused with exit code 2, and the error lists the
options that command does take. Given `--days 3`, `scrub` stops with
`--days is not an option for scrub. Options for scrub: …`. Flags may come
before the command and are checked against it. `--help` anywhere on the line
shows that command's help and exits 0; `--help` and `--version` work with any
command.

`restore --strict` is for pipelines that write the restored text somewhere: if a
placeholder would be left in it — one the AI invented, one whose shape it changed
(`__fn__1`), one the team's maps disagree on, or one the team's maps could not be
read for — nothing goes to stdout and it exits 1. Without it, restore writes the
text, placeholders and all, names each one on stderr and exits 0. A value
redacted one-way (`__REDACTED_CREDENTIAL_1__`) cannot be restored, so the text is
not the original file: restore names it every time, and `--strict` refuses it.

`--keep-docs` is worth knowing about: the default strip removes JSDoc along with
the narration and TODOs, which is wrong when the model was _asked_ to document
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

## When Veilio says the guard is missing

Run inside Claude Code (Claude Code sets `CLAUDECODE` for the commands it runs) on a machine where veilio-guard is not installed, every command prints one line to stderr:

```text
veilio: veilio-guard is not installed. In Claude Code the CLI and MCP mask only what passes through them; the agent's own reads reach the model as written. Install it: /plugin install veilio-guard@veilio
```

Standard output and the exit code are never changed, so pipes keep working. The line goes away once the guard is installed (the CLI reads Claude Code's plugin list, `~/.claude/plugins/installed_plugins.json`, and nothing else), and never shows under `--quiet`, with `CI` set, or outside Claude Code. A guard enforced only through your organisation's managed settings may not appear in that list; use `--quiet` there.

## Exit codes

| Code | Meaning                                                                                                            |
| ---- | ------------------------------------------------------------------------------------------------------------------ |
| 0    | Clean                                                                                                              |
| 1    | Findings that should stop the pipeline: a credential (`scan`), a placeholder or redaction `restore --strict` would have left, or a map the CLI refuses to use (see [The symbol map](#the-symbol-map)) |
| 2    | Usage or IO error                                                                                                  |

As a pre-commit hook, use the one this package ships ([Pre-commit](#pre-commit)).
It scans each staged file under its own name; a diff piped into `veilio scan`
has no file name, so the `.env`, YAML and shell rules cannot apply to it.

## What is masked

Distinctive names - `quaywardThrottle`, `SkerryTariff`, `berth_quorum`, an invented
`tarnwick` - become placeholders. A name that is a single common English word
(`total`, `ledger`, `invoice`), shared vocabulary every codebase has (`src`,
`util`, `com`, `java`) or a toolchain's name (`vitest`, `junit`, `mvn`) is left as
written as a name or a path segment: it is nobody's secret, and masking it made
paths and test output unreadable. A codename that is an ordinary word (`phoenix`)
is therefore readable as a name; a custom replace rule (`veilio rules pull`) keeps
it masked. In a value - a string literal, a config value, XML text - every word is
masked. A value whose key contains a credential word (`password: sunshine`,
`DB_PASSWORD_PROD="sunshine"`, `const DB_PASS = "Summer2024!"`) is redacted one-way,
whole, under the default `--secrets redact`, so the map never holds it. Credentials
are redacted whatever they are called.

## The symbol map

`scrub` writes `.veilio/map.json` at the project root and `restore` reads it, so placeholders stay stable across runs and across a whole session. The store is created `0600` with its own `.gitignore` — it holds the real identifier names, so committing it would undo the anonymization for anyone reading the repo.

Redacted credentials are **not** in the map. `restore` cannot bring them back, by construction.

The map is yours only if you made it, so the CLI refuses (exit 1) to read or write a store:

- that git tracks: a `.veilio/map.json` or `.veilio/aliases.json` a repository committed is not yours to restore from. Remove it from git (`git rm --cached`), then scrub again to build your own. The CLI reads the git index itself and runs no git command.
- through a link: `.veilio/`, `map.json`, `aliases.json` and `reserved.json` are read and written only where they appear to be.
- that belongs to another user on this machine (macOS and Linux): a `.veilio` someone else made, say in `/tmp`, is skipped when the CLI looks for the project, and refused when named with `--map`. Under `sudo`, a store of the user who ran it (`SUDO_UID`) can be read but not written: a file root writes there would be root's, so run `veilio` without `sudo`. To use a store someone else owns on purpose (a shared CI workspace, say), list its full path in `VEILIO_TRUST_STORE_OWNER`, as git's `safe.directory`: absolute paths separated by `:` (`;` on Windows), for example `VEILIO_TRUST_STORE_OWNER=/srv/build/.veilio`. Only a listed store is accepted, by its real path.
- whose `.veilio/.gitignore` does not keep it out of git: an existing one must be a plain file whose only pattern is `*`. The CLI writes one when there is none and never rewrites one that is there.

Outside a git checkout, the CLI cannot tell a map you made from one that came with the files. Check `.veilio/` in an unpacked archive before you restore.

## Every file is judged strictly

`scrub` and `scan` read every file as real source, test, fixture and example files included: a weak password in a secret position (`PGPASSWORD=Summer24`, `mysql -pSummer24`, the password in a URL, an auth header) is redacted wherever it is. The MCP server and the Claude Code guard do the same. A committed fixture cannot be told from a copy of `.env` in `tests/` safely enough to leave its passwords in place, so no Veilio client tries.

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

The [pre-commit framework](https://pre-commit.com) is not supported yet. This
repository has no `.pre-commit-hooks.yaml`, so there is no `veilio-scan` hook
to name, and no `v*` tag to pin it to.

Use a plain git hook:

```bash
cp packages/cli/hooks/pre-commit .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit
```

It scans what is **staged** — what you are about to commit is what matters, and
a finding in an unstaged scratch file shouldn't block you. Each staged file
(added, changed, renamed or retyped) is scanned under its own name, so its file
type picks the rules; a `.gitattributes` `-diff` hides nothing, because the
file is read, not its diff. One `veilio scan --blobs` checks the whole commit:
git lists the staged files with their object ids, `git cat-file --batch`
streams those blobs, and each is matched to its name by id. Binary files and
submodules are skipped. A finding blocks the commit with the credentials
message; anything that stops the check blocks it with "could not check" and
the reason. `--no-verify` overrides, as usual.
