# @veilio-inc/mcp

> **Veilio is a set: install the guard, the CLI and the MCP server together.** Each does one job, and all three share one map (`.veilio/map.json`).
>
> - **[veilio-guard](../../plugins/veilio-guard/README.md)** keeps your names from the model while a coding agent works: it masks everything the agent reads - files, command output, search results and your prompts. Claude Code today; other agents are in progress.
> - **[The CLI](../cli/README.md) (`@veilio-inc/cli`)** does what the guard cannot, because the guard makes no network call: `veilio scrub` builds the map before the first session, `veilio maps pull` brings in your team's map and its numbers, `veilio rules pull` your custom rules, `veilio restore` brings back the names in an answer, and `veilio scan` stops a live key in a commit or in CI.
> - **The MCP server (this package)** gives the agent tools of its own: read a file masked, restore an answer (opt-in), scan for secrets. In an agent the guard does not cover yet, it is the way in - with the agent's own file and shell tools turned off.
>
> **Without the guard, the CLI and the MCP server protect only what passes through them.** An agent that reads files and test output with its own tools sends them to the model as written: in our benchmark (spec 067, run 3), project names reached the model in 93-95 of 96 sessions with the MCP server or the CLI alone, and in 0 of 96 with the guard.

MCP server that lets a coding agent read your code **masked**: a file read through it reaches the agent with its identifiers as placeholders. What masking does and does not hide: [the engine's README](../engine/README.md#what-it-hides-and-what-it-does-not).

**What it does not do:** it masks what the agent reads *through it*. It does not stop the agent reading files or command output with its own tools, and those reach the model as written - in our benchmark (spec 067, run 3), project names reached the model in 93-95 of 96 MCP and CLI sessions, nearly as often as with no Veilio at all (96 of 96). In Claude Code, [veilio-guard](../../plugins/veilio-guard/README.md) enforces masking for everything the model sees. In another agent, turn off its own file and shell tools so this server is the only way to your code.

## Why path-based tools

A naive MCP anonymizer takes source code as a tool argument. That is self-defeating: to call it, the agent must already hold the real code — so the identifiers are already in the model's context and nothing was protected.

The primary tools here take a **file path**. The server reads the file in its own process and returns only the masked text. From that call the agent learns `__CLS__1.__FN__2()`, not `PaymentGateway.chargeCard()`.

That holds on the way in. On the way back, `restore_text` is off unless you start the server with `VEILIO_MCP_RESTORE=1` in its configuration. When the agent calls it, the restored text - the real names - is in the agent's context from then on, and an instruction hidden in a file the agent reads could ask for it. To restore an answer without that, run `veilio restore` in a terminal.

`anonymize_file` and `scan_secrets` never read a file on the guard's raw-only list (.env, private keys, credential stores, .veilio/): they refuse it, as written or through a link.

```
tools/call anonymize_file { "path": "src/gateway.ts" }

→ Source: src/gateway.ts
  Language: TypeScript / JavaScript
  Placeholders in map: 7
  Namespace: local
  Custom rules: none
  Credentials detected — 1 critical:
    critical line 2:24  Stripe secret key — sk_l…MNOP (31 chars) (redacted, not recoverable)

  --- masked code ---
  export class __CLS__1 {
    private __VAR__2 = "__REDACTED_STRIPE_KEY_1__"
    async __FN__1(__VAR__4: string, __VAR__1: number) {
      return this.__VAR__3.__FN__2(__VAR__4, __VAR__1)
    }
  }
```

Two more lines appear when they apply, and both are the model's only warning
that the masking did not cover something: one when no language marker matched
(the file was masked as TypeScript, which may be wrong), and one counting the
**comment prose left exactly as written** — names and ticket numbers in comments
are still real. Names written entirely in capitals are not masked either
(`ACME_TENANT_ID`); nothing counts those. Nor is a name that is a single common
English word (`total`, `ledger`), shared vocabulary (`src`, `util`, `java`) or a
toolchain's name (`vitest`, `junit`) as a name or a path segment: only distinctive
names are masked. A codename that is an ordinary word stays masked only with a custom
replace rule. In a value - a string literal, a config value, XML text - every word is
masked, and a value whose key contains a credential word (`password: sunshine`,
`const DB_PASS = "Summer2024!"`) is redacted one-way, whole, under the default
`redact`, so the map never holds it.

## Tools

| Tool                 | Purpose                                                                                                                                                                                                                                                                                        |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `anonymize_file`     | Read a file and return only its masked form. **Preferred.** A raw-only file (.env, private keys, credential stores, .veilio/) is refused, never read. |
| `anonymize_text`     | Mask text the agent already holds (a user paste). Not for file contents.                                                                                                                                                                                                                       |
| `restore_text`       | **Off unless the server is started with `VEILIO_MCP_RESTORE=1`.** Swap placeholders back and strip AI-generated noise — the team's placeholders too, under the rule below. A placeholder it cannot restore is left in and named, including one whose shape the AI changed (`__fn__1`). A value redacted one-way is named too: it cannot be restored. With `strict: true`, it returns an error naming them instead of the text. |
| `scan_secrets`       | Detect credentials without modifying anything, and without putting the values in context: a finding shows only a value's last four characters and its length (`…vJKx (39 chars)`; `•••• (9 chars)` for 12 characters or fewer). A raw-only file is refused, never read. |
| `symbol_map_summary` | Placeholder counts by kind. Returns keys only, never real names.                                                                                                                                                                                                                               |

### Map, team and project tools (signed in to Veilio Cloud)

Listed only once `veilio login` has signed this machine in; with no sign-in -
always, in the Community Edition - the server offers the five tools above and
nothing else. Each is the `veilio` CLI's own command, through the same code, so
it refuses in the same words for the same reasons.

| Tool            | Purpose                                                                                                                                                                                                              |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maps_list`     | The maps in Cloud - personal, and the team's in the project in use - with id, scope, count, name and whose each is.                                                                                                  |
| `maps_pull`     | Fetch a map into this project's local map. `force: true` to replace local entries it would drop. A team map also reserves this member's block of team numbers (`.veilio/reserved.json`), as `veilio maps pull` does. |
| `maps_create`   | Save the local map as a new map: `scope` `personal` or `team`. A team map is checked against the team's other maps first.                                                                                            |
| `maps_update`   | Replace a map's entries with the local map's, in place - same id, name and project. Its publisher only.                                                                                                              |
| `maps_remove`   | Remove a map. Needs the destructive setting and `confirmName` equal to the map's exact name (a typo check; see below).                                                                                               |
| `team_status`   | Account, team, project in use, whether the team key and the personal-maps key are unlocked here, whether a key change is owed.                                                                                       |
| `projects_list` | The projects the team works in; `*` marks the one in use.                                                                                                                                                            |
| `projects_use`  | Choose one, by name or id. Kept with the sign-in, so the CLI uses it too.                                                                                                                                            |

**One project per repository: `VEILIO_PROJECT`.** Set it in a repository's
`.mcp.json` `env` (see [Install](#install)) and that repository's server works
in that project for every tool call: the map tools, `team_status`,
`projects_list`, and the team namespace `anonymize_*` and `restore_text` number
from. It wins over the choice stored with the sign-in, so an agent in
repository A never masks against repository B's names, even though both share
one sign-in. A value that names no project your team works in, or a name two
projects share, makes those tools return an error naming it. The masking tools
refuse rather than mask from the local map. Results that name the project say
"(from VEILIO_PROJECT)". `projects_use` still stores a choice, and warns that
the server's variable overrides it.

- **Destructive tools are off by default.** `maps_remove`, a `maps_update`
  that would drop entries (`allowDrop: true`), and a `maps_pull` with `force`
  that would overwrite local entries, are refused unless you start the
  server with `VEILIO_MCP_DESTRUCTIVE=1` in its environment - a setting the agent
  cannot reach. Removal is allowed only when the server was started with
  `VEILIO_MCP_DESTRUCTIVE=1`. `confirmName` catches a wrong id; it is not proof
  that the person agreed (the model can read names from `maps_list`). Creating,
  pulling, listing and updates that drop nothing always work.
- **Personal maps need `veilio vault unlock`** in a terminal first. It keeps a
  personal-maps key on this machine (7 days) that opens personal maps and
  nothing else; the server never sees your passphrase. Team maps need
  `veilio team unlock`, as before.
- **No result carries a secret**: never a passphrase, a key, a wrapped key or a
  map's encrypted body, and a clash names placeholders, never the names behind
  them. Results name the map, its count and the outcome.

Setup for Claude Code, Claude Desktop, Xcode, Cursor and VS Code, plus troubleshooting: [docs/USING-THE-CLI-AND-MCP.md](../../docs/USING-THE-CLI-AND-MCP.md).

## Install

```jsonc
// Claude Code — .mcp.json
{
  "mcpServers": {
    "veilio": {
      "command": "npx",
      "args": ["-y", "@veilio-inc/mcp", "--root", "."],
    },
  },
}
```

Signed in to a team that works in several projects, pin this repository's
project with `env`. Use a name or an id; an empty value counts as unset:

```jsonc
// Claude Code — .mcp.json in the billing repository
{
  "mcpServers": {
    "veilio": {
      "command": "npx",
      "args": ["-y", "@veilio-inc/mcp", "--root", "."],
      "env": { "VEILIO_PROJECT": "billing" },
    },
  },
}
```

`--root <dir>` (or `-r`) scopes every path the server will read; `--map <path>` (or `-m`) overrides the symbol-map location. The map is read through the CLI's store, so `restore_text`, `symbol_map_summary` and the `anonymize_*` tools refuse a map that git tracks, one reached through a link, or one another user owns, as `veilio` does. Paths outside the root are refused, including a link or junction inside the root that leads outside it — the server reads files on the agent's behalf, so traversal would make it an arbitrary-file-read primitive.

**`--root` guards the files, not the conversation.** Everything the agent has read stays in its session. If you work on several clients' repos, a session that read client A's code still holds it when you switch to client B, and the model can repeat a name from it without reading a file. Without a team namespace, placeholders are also numbered per project: `__CLS__1` in A's repo and `__CLS__1` in B's are different classes, so an answer about A restored through B's server comes back with B's names in it. Open a fresh session per client, from that repo's root, so each session has one root, one map and one client's code.

## When Veilio says the guard is missing

At startup the server checks whether veilio-guard is installed (Claude Code's plugin list, `~/.claude/plugins/installed_plugins.json`; nothing else is read, nothing is sent). If it is not, the server prints one line to stderr and adds the same sentence to the instructions it gives the agent:

- **In Claude Code** (`CLAUDECODE` is set): `veilio: veilio-guard is not installed. In Claude Code the CLI and MCP mask only what passes through them; the agent's own reads reach the model as written. Install it: /plugin install veilio-guard@veilio`
- **In any other agent**, where the guard does not exist yet: `veilio: this agent has no Veilio guard yet. Turn off its own file and shell tools so this server is the only way to your code; otherwise its reads reach the model as written.`

Nothing is added once the guard is installed, or with `CI` set. Tool results are never changed.

## Team namespace (Team plan and above)

Sign in once with the `veilio` CLI — `veilio login` — and every anonymize
result from this server states which namespace produced its placeholders:

- **`team`** — resolved against the team's shared dictionary, read at startup,
  so every teammate's agent produces the same placeholder for the same
  identifier. Kept for the life of the process, and read again when it no
  longer matches: after `veilio team unlock` is run while the server is up
  (the next call says it is loading the team's maps), after a team map is
  created or updated, or any map removed, through this server, after `projects_use`
  changes the project, and, with `VEILIO_PROJECT` set, when the project that
  name points to changes (checked at most every 30 seconds).
- **`local`** — resolved locally: not signed in, no team key unlocked on this
  machine, offline, or the plan doesn't include shared dictionaries. This is the
  normal, fully-functional state for anyone not on a paid team — the server never
  blocks on it, and the fallback is always stated, never silent.

There is no separate sign-in for the MCP server; it reads the same credential
file `veilio login` already wrote.

In a team, a new name is numbered inside this checkout's block of team numbers
in `.veilio/reserved.json`, written by `veilio maps pull` and `veilio team
unlock`. This server only reads that file: it never writes it and never
reserves. With no usable block, a new name goes into this checkout's local
family, `__LOCAL_<TAG>_<KIND>__n`, which no team map holds and the next team
publish renumbers (see the CLI README). The same holds with the team key locked
or Cloud unreachable: still a team, so new names are never numbered above the
map. While the last reservation is refused,
every anonymize result says so beside the rules line, in the CLI's words
(`WARNING: could not reserve team numbers: …`), and a call that numbered names
locally says how many (`2 names numbered locally`).

The merge happens **here, not in Cloud**: team maps arrive sealed under the team
key, which the server cannot read. So on a Team plan the namespace is `team` only
once `veilio team unlock` has opened that key on this machine — it is kept for
seven days, and a key rotation ends it sooner. Signed in with nothing unlocked,
the server reports `local`: there is nothing it could decrypt. A single map it
cannot open is skipped rather than fatal, but a failed read of the namespace as a
whole reports `local` too, because a namespace missing a teammate's newest map
would restore their placeholders wrong. An older self-hosted Cloud that still
merges server-side is honoured as it is, with no key needed here.

The `local` line says which of those it was — `local (the team key is locked on
this machine - run \`veilio team unlock\`)`or`local (could not read the team's
maps: …)` — so a fallback is never read as agreement.

The account's custom rules are fetched at startup the same way and applied to
every anonymize call. Each result states their source: `from Cloud`, `cached`
(Cloud did not answer, so the last `veilio rules pull` is used, with its age),
or `none`.

Cloud holds the rules sealed under your keys and cannot read them. The server
has no passphrase, so it opens them with the keys `veilio vault unlock`
(personal rules) and `veilio team unlock` (team rules) left on this machine. A
rule it cannot open is skipped and masking goes on; while any are skipped, every
anonymize result says so beside the source line, one sentence per cause, with
the fix, for example:

```
1 custom rule not applied: vault locked - run `veilio vault unlock`, then `veilio rules pull`.
```

The other causes are `team key locked`, rules that could not be opened with the
keys on this machine, and rules refused as unsafe to apply; the CLI README lists
the exact sentences. A call whose rules would take more matching work than one
call allows stops applying them part-way (the rest is masked as usual) and says
`WARNING: custom rules stopped matching: too much work. …`.

The server reads the rules once, when it starts. After `veilio vault lock` or
`veilio team lock` it keeps the rules it already loaded until it restarts;
restart your agent to drop them.

The cached rules apply only while their key is still on this machine:
`veilio vault lock` and `veilio team lock` remove the personal or team rules
from the cache, and a key that has expired counts as locked too, so the
fallback never applies a rule whose key is gone. They come back with the next
unlock and `veilio rules pull`.

### One restore rule, and what the server refuses to guess

`restore_text` resolves the team's maps first — aliases included — and this
project's map on top of them. Two kinds of placeholder are deliberately left in
the output, each named in a warning rather than substituted:

- one this project's store and the team use for **different** identifiers, and
- one this project **numbered on its own** while the team was out of reach, and
- one **another checkout** numbered in its local family while it held no team
  numbers (`__LOCAL_<TAG>_…`): only that checkout restores it.

Two more are left because nothing can restore them, and are named too: one no
map explains (`__FN__9`, "invented or altered by the AI"), and one whose **shape**
the AI changed — case or underscores (`__fn__1`, `_FN__1`). A real name of that
shape in your own code (`_str_1`) restored exactly and is not named.

Either could be restored to a name that is not the one a teammate meant, and a
confident wrong identifier is worse than a token the reader can see is
unresolved. They are also excluded from the "invented or altered" count, since
they were left for a stated reason.

When the team's maps _should_ have been used and could not be — the key is
locked, or Cloud could not be read — the call comes back as an **error result**
saying which, even if some placeholders did restore. An older self-hosted Cloud
that merges the namespace server-side is used for anonymizing but never for
restoring: it cannot tell a disputed placeholder from a first-written one.

### `strict`: refuse instead of returning half-restored text

With `strict: true`, if any of those five would be left in the text, the call
comes back as an **error result** carrying the report and the warnings, and
**without** the text:

```
tools/call restore_text { "text": "new __CLS__1().__fn__1()", "strict": true }

→ isError: true
  Restored 1 of 3 placeholders.

  2 placeholder(s) never appeared in the text: __FN__1, __VAR__1. Expected if
  the text only covered part of the source; if it covered all of it, those names
  came back renamed and are not recoverable from it.

  WARNING: left as is: __fn__1. It looks like a placeholder whose shape the AI
  changed (case or underscores), so nothing could restore it. Ask the AI to use
  the placeholders exactly as given.

  strict: the restored text is withheld - __fn__1 would have been left in it.
```

`strict` must be `true` or `false`; anything else (`"true"`) is an error, never
"not strict". A value redacted one-way (`__REDACTED_CREDENTIAL_1__`) cannot be
restored, so the text is not the original file: it is always named, and `strict`
refuses it. Without `strict`, the text comes back with the warnings, as before.

### After a lapse

Anonymizing while signed out, or while Cloud was unreachable, numbers new names
locally. Once the team's maps are back, an identifier the team already knows
takes the **team's** placeholder, and anything new is numbered inside this
checkout's block, or locally (`__LOCAL_<TAG>_…`) without one. The entries minted during the lapse stay
in the local store — text was already sent with them, so they are still needed
to restore it — but they are not handed to a teammate as the team's meaning.

## Design properties

- **No third-party runtime dependencies.** The only two are `@veilio-inc/engine` and `@veilio-inc/cli`, both from this repository. JSON-RPC framing is implemented directly. Pulling a transitive tree into the component that reads your source would undercut the product's own claim.
- **stdout is protocol only.** Diagnostics go to stderr; a stray write to stdout corrupts the stream.
- **Tool errors, not protocol errors.** Failures come back as `isError` content so the model can correct itself, rather than aborting the call.
- **Redaction is one-way.** Credentials never enter the symbol map, so `restore_text` cannot bring them back.
- **Every file is judged strictly.** `anonymize_file` and `scan_secrets` read every file as real source, test, fixture and example files included: a weak password in a secret position (`PGPASSWORD=Summer24`, a password flag, the password in a URL, an auth header) is redacted wherever it is. The CLI and the Claude Code guard do the same. A committed fixture cannot be told from a copy of `.env` in `tests/` safely enough to leave its passwords in place, so no Veilio client tries.

The symbol map is shared with the `veilio` CLI, so you can mask in an agent and restore from a terminal, or the reverse.
