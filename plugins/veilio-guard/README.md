# veilio-guard

A Claude Code plugin that keeps your project's real identifiers and secrets away from the model while Claude Code works.

> **Veilio is a set: install the guard, the CLI and the MCP server together.** Each does one job, and all three share one map (`.veilio/map.json`).
>
> - **veilio-guard (this plugin)** keeps your names from the model while a coding agent works: it masks everything the agent reads - files, command output, search results and your prompts. Claude Code today; other agents are in progress.
> - **[The CLI](../../packages/cli/README.md) (`@veilio-inc/cli`)** does what the guard cannot, because the guard makes no network call: `veilio scrub` builds the map before the first session, `veilio maps pull` brings in your team's map and its numbers, `veilio rules pull` your custom rules, `veilio restore` brings back the names in an answer, and `veilio scan` stops a live key in a commit or in CI.
> - **[The MCP server](../../packages/mcp/README.md) (`@veilio-inc/mcp`)** gives the agent tools of its own: read a file masked, restore an answer (opt-in), scan for secrets. In an agent the guard does not cover yet, it is the way in - with the agent's own file and shell tools turned off.
>
> **Without the guard, the CLI and the MCP server protect only what passes through them.** An agent that reads files and test output with its own tools sends them to the model as written: in our benchmark (spec 067, run 3), project names reached the model in 93-95 of 96 sessions with the MCP server or the CLI alone, and in 0 of 96 with the guard.

Claude Code reads files and runs commands itself, so code you would never paste into a chat reaches the model anyway. veilio-guard sits between Claude Code's tools and the model:

- **What Claude reads** (files, command output, search results, MCP results, what you type, and the reminders and instruction files Claude Code adds) reaches the model with identifiers replaced by placeholders such as `__CLS__1`, and with credentials removed. One exception: the entries of Claude Code's skill and agent listings that come from Claude Code itself or from a plugin installed from the official Anthropic marketplace are public, and are sent as written. Your project's and your own skills and agents, and plugins from any other marketplace, are masked.
- **What Claude writes** (edits, searches, and shell commands that only read files or run tests) gets the real names back before it runs. Any other shell command that names a placeholder - one that reshapes it, sends it over the network, or writes - is refused before it runs, and nothing is restored into it; to commit with a message that names one, write the message to a file with the Write tool, then run `git commit -F <file>`. PowerShell commands get no real names back yet. An edit or shell command that names a placeholder the map doesn't know, or a removed credential, is refused, so a file never receives a token that means nothing.
- **`.env`, private keys, credential stores and `.veilio/`** are refused before Claude reads them. Credential stores include `.git-credentials`, `.htpasswd`, `.pgpass`, `.npmrc`, `.netrc`, `kubeconfig`, `.kube/`, `.docker/config.json`, `.aws/credentials`, `.azure/`, `.config/gcloud/`, and `*.jks`, `*.keystore` and `*.p8` keys. A path is checked as written and with `..` resolved, and a `cd` or `pushd` into one of those directories is refused.
- **You see the real names** in Claude's replies, tool rows, diffs and command output, on your machine only. The session's transcript keeps the placeholders, with one exception COVERAGE.md describes: some Claude Code versions store CLAUDE.md as written.
- **If the guard can't do its job, it fails closed:** a result it can't check is withheld, and a prompt it can't check isn't sent.

It uses the same symbol map as the [Veilio CLI](../../packages/cli/README.md) and [MCP server](../../packages/mcp/README.md): `.veilio/map.json` in the project. It makes no network call.

What it covers, what it doesn't, and the test behind each claim: [COVERAGE.md](COVERAGE.md).

Every file is judged strictly, test, fixture and example files included. A weak password in a secret position (`PGPASSWORD=Summer24`, a password flag, the password in a URL, an auth header) is removed wherever Claude reads it, as in the CLI and the MCP server.

In what Read, Edit and Write return for a dotenv file, a YAML file or a shell script - its text and its patch lines - a strong credential assigned to an environment-style name (`DB_PASSWORD=…`, `GITHUB_TOKEN: …`, `export STRIPE_SECRET_KEY=…`) is redacted in place, quoted or not; a weak one is handled as in any other file. The guard tells the engine the file's kind, never its path, so the strict judging above still holds. A Bash or Grep result has no single file kind and is read as before.

## Install

You need Claude Code 2.1.287 or later (`claude --version`). Tested on macOS and Linux, and in one Windows 11 session (terminal CLI), where Claude Code's PowerShell tool gets the same checks as Bash.

```text
/plugin marketplace add veilio-inc/veilio
/plugin install veilio-guard@veilio
```

Or from your shell: `claude plugin marketplace add veilio-inc/veilio`, then `claude plugin install veilio-guard@veilio`.

The install may print `2 userConfig options not yet set`. Both options are optional and the guard runs without them; see [Configure](#configure).

Install the CLI and the MCP server too (`npm install -g @veilio-inc/cli @veilio-inc/mcp`) and run `veilio scrub` once over your source files (`veilio scrub src/**/*.ts > /dev/null`): the guard then starts with a full map instead of growing one as Claude reads.

If the project already has a map (`veilio scrub` builds one), the guard uses it from the first message. Otherwise the map grows as Claude reads your source files.

## Use

A line above the prompt says what the guard is doing:

```text
Veilio guard on · 42 names in the map · custom rules: 3 · 0 withheld · 0 refused
```

- `/veilio` shows the state, the map, and what is covered.
- `/veilio off` switches the guard off for this project. It is recorded in `~/.veilio/guard-state.json`, outside the project, where the agent's tools cannot reach it. Claude then reads raw code, and the line above the prompt says so on every turn.
- When the plugin's settings name MCP servers that get real names, the line above the prompt ends with ` · real names to: <server>, <server>`.
- `/veilio on` switches it back on.

Your account's custom rules apply too. The guard reads the rules `veilio rules pull` keeps on this machine, for the account you are signed in as, and never fetches them itself: run `veilio rules pull` after a rule changes, then start a new session. Replace rules mask what they match, an ordinary word such as `phoenix` included, in files Claude reads, command output and your prompts; whitelist rules keep their names readable. The line above the prompt says how many apply (`custom rules: 3`), or that none are pulled, and how many were not applied and why (vault locked, team key locked, refused). A cached rule applies only while the key it was opened with is still on this machine: after `veilio vault lock` or `veilio team lock`, or once the key expires, those rules are not applied and count as vault locked or team key locked. A session already running keeps the rules it loaded until you start a new one.

To clear the map (`veilio map --clear`), close Claude Code first: an open session puts back the entries it knows on its next save.

## Configure

In the plugin's settings (`/config`). `.veilio/guard.json` in the project can add `rawOnly` paths and nothing else, committed or not, because a file in the project can be written by the agent: its `mcpRestore` and `enabled` are ignored, and the guard says so once. The agent may not write Claude Code's settings files (`.claude/settings.json`, `.claude/settings.local.json`, `~/.claude/settings.json`), which could switch the guard off. A committed `.veilio/map.json` or `aliases.json` stops the guard until it is removed from git. Outside a git checkout, only placeholders this session showed are restored.

```json
{
  "rawOnly": ["secrets/**", "*.sqlite"]
}
```

- `rawOnly`: more files Claude must never read. These are added to the built-in list; the built-in list can't be shortened.
- `mcpRestore` (plugin settings only): MCP servers that get the real names in their arguments. By default every MCP server gets placeholders, and web fetches and web searches always do.
- `publicMarketplaces` (plugin settings only, not `guard.json`): plugin marketplaces you know are public, each as `<name>=<source>`, where the source is what Claude Code records for it in `~/.claude/plugins/known_marketplaces.json`, such as `acme-oss=github:acme/oss-plugins`. The skill and agent listings of their plugins are then sent as written. The name and the source must both match exactly. An entry with no source is ignored, and the guard says so once.

## For a team

To run the guard for everyone, an administrator lists it in Claude Code's [managed settings](https://code.claude.com/docs/en/managed-settings), so it runs before any plugin a user installs:

```json
{
  "prependPlugins": ["veilio-guard@veilio"],
  "allowManagedModsOnly": true
}
```

When the organisation runs it, `/veilio` says so, and neither `/veilio off` nor a project's `guard.json` can switch it off. The team's shared map comes through the CLI: `veilio maps pull` writes it to the project's map, and the guard uses it as is.

`veilio maps pull` also reserves you a block of the team's placeholder numbers (`.veilio/reserved.json`), and the guard numbers new names inside it, offline, so two teammates working at once never give one placeholder two meanings. When no block can be reserved (the day's limit, offline, the plan), the line above the prompt says so for the whole session (`team numbers refused (cap): new names numbered here, next block 09:14`), and the guard numbers new names in this checkout's local family, `__LOCAL_<TAG>_<KIND>__n`: your machine restores them, a teammate's restore leaves them as written, and your next team publish (`veilio maps push --team` or `veilio maps update`) renumbers them and keeps the old ones in `.veilio/aliases.json`, which the guard reads so edits written with them still land.

## Develop

```bash
node scripts/sync-guard-engine.mjs           # copy the engine's build in (after changing packages/engine)
claude plugin validate --strict plugins/veilio-guard
claude plugin test plugins/veilio-guard       # the hooks, with payloads recorded from a live session
npx vitest run tests/guard                    # lib/, and COVERAGE.md against the tests
bash plugins/veilio-guard/tests/live/run-live.sh   # one real session (spends a little model usage)
bash plugins/veilio-guard/tests/live/run-scale.sh  # three sessions on this whole repository
```

A mod can only import files inside its plugin directory, so `vendor/engine` holds a copy of `packages/engine/dist`. CI fails when the copy differs from the build.
