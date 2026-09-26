# Using Veilio from the terminal and from AI coding tools

Veilio ships two command-line packages:

- **`@veilio-inc/cli`** (`veilio`): anonymize and restore code in a terminal, a
  pipe, a pre-commit hook or CI.
- **`@veilio-inc/mcp`** (`veilio-mcp`): the same engine as an MCP server, so an AI
  coding assistant (Claude Code, Claude Desktop, Xcode, Cursor, VS Code) can
  anonymize files before it reads them and restore its own answers.

Both work **offline and without an account**. A Veilio Cloud subscription adds
your saved maps, your team's shared placeholders and your custom rules.

Node.js 24 or newer is required.

---

## 1. Install

```bash
npm install -g @veilio-inc/cli @veilio-inc/mcp
veilio --version
```

Or run either without installing: `npx -y @veilio-inc/cli --help`.

---

## 2. The terminal, offline

```bash
veilio scrub src/billing.ts | pbcopy     # anonymize; the map goes to .veilio/map.json
pbpaste | veilio restore                 # put the real names back into the AI's answer
git diff --cached | veilio scan          # credentials only; exits 1 on findings
veilio map                               # show the current symbol map (--clear to wipe it)
```

- Output goes to **stdout**; summaries and warnings go to **stderr**, so pipes stay clean.
- The symbol map lives in `.veilio/map.json` in the project (found by walking up to
  the git root). It holds the real names, so it is written 0600 and `.veilio/` gets
  its own `.gitignore`: it is never committed.
- `--language` forces a language when auto-detection guesses wrong;
  `--secrets warn|off` changes how detected credentials are handled (default: redact,
  irreversibly).

Exit codes: `0` clean, `1` findings (use it to stop a commit or a CI job),
`2` usage or I/O error.

---

## 3. Connecting the CLI to Veilio Cloud

```bash
veilio login                  # email, password - and the authentication code if 2FA is on
veilio whoami                 # who is signed in (no network request)
veilio maps list              # your maps and your team's, with ids
veilio maps pull <id>         # bring one into .veilio/map.json
veilio maps push <name>       # upload the local map as a new personal map
veilio rules pull             # fetch your custom rules (personal and team)
veilio team unlock            # open your team key with your vault passphrase (kept 7 days)
veilio team lock              # remove the unlocked team key from this machine
veilio logout                 # revoke the session and remove local credentials
```

- `login` needs a plan that includes the terminal. Accounts with two-factor
  authentication are asked for the code (an authenticator code or a recovery code).
- **Personal maps** are decrypted on your machine: `pull` and `push` ask for your
  **vault passphrase**, which never leaves the machine.
- **Team maps** open with the team key, which `veilio team unlock` stores for
  7 days (0600, under `~/.veilio/`). Run it again after 7 days, after the team key
  is rotated, or after you join a team.
- **Custom rules** (whitelist and replace, set in the web app) are applied by
  `veilio scrub` from the copy `rules pull` saves. `scrub` stays offline and prints
  how many rules it applied and how old the copy is; pull again after the rules change.
- Self-hosted: `veilio login --instance https://veilio.example.com`.

Everything is stored under `~/.veilio/` (credential, team key, rules), each file
0600. `logout` removes all three.

---

## 4. The MCP server

Once connected, your assistant gets five tools:

| Tool | What it does |
|---|---|
| `anonymize_file` | Reads a file inside the project root and returns it anonymized - the real code never enters the assistant's context. |
| `anonymize_text` | Anonymizes text you or the assistant pass in. |
| `restore_text` | Puts real names back into an answer and strips AI noise. |
| `scan_secrets` | Reports credentials without putting their values in context. |
| `symbol_map_summary` | Counts and categories in the current map, never the names. |

Every anonymize result states:

- **`Namespace: team`** - placeholders come from your team's shared maps, so
  teammates' assistants agree on what `__FN__3` means.
- **`Namespace: local`** - not signed in, offline, no team plan, or the team key is
  not unlocked. Fully functional; the team simply does not share numbering.
- **`Custom rules:`** - how many of your rules were applied and whether they came
  from Cloud or from the last `veilio rules pull`.

The server reads the same `~/.veilio/` files the CLI writes. To use team
placeholders from an assistant, run **`veilio login`** and **`veilio team unlock`**
once in a terminal first; the assistant never asks for a passphrase.

Options: `--root <dir>` limits the files the server may read (paths outside it
are refused); `--map <path>` uses a specific map file.

---

## 5. Connecting your assistant

In every client the command is `npx -y @veilio-inc/mcp --root <project>`. If the
client cannot find `npx` (GUI apps often do not see your shell's `PATH`), use
absolute paths: `which npx` or `which veilio-mcp` shows them.

### Claude Code (terminal, VS Code or JetBrains extension)

```bash
cd your-project
claude mcp add veilio -- npx -y @veilio-inc/mcp --root .
claude mcp list          # veilio should be listed as connected
```

To share it with everyone who works in the repository, add it at project scope
(`claude mcp add --scope project ...`), which writes `.mcp.json`:

```json
{
  "mcpServers": {
    "veilio": { "command": "npx", "args": ["-y", "@veilio-inc/mcp", "--root", "."] }
  }
}
```

### Claude Desktop

Settings → Developer → Edit Config opens `claude_desktop_config.json`
(macOS: `~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`).
Claude Desktop has no project folder, so give `--root` an absolute path:

```json
{
  "mcpServers": {
    "veilio": {
      "command": "/opt/homebrew/bin/npx",
      "args": ["-y", "@veilio-inc/mcp", "--root", "/Users/you/code/your-project"]
    }
  }
}
```

Restart Claude Desktop; the tools appear under the tools icon.

### Xcode (26.3 and later, Claude Agent)

Xcode's Claude Agent keeps its own configuration, separate from your `~/.claude`,
in `~/Library/Developer/Xcode/CodingAssistant/ClaudeAgentConfig/`. Xcode does
not inherit your shell, so use absolute paths and pass `PATH` explicitly:

```json
{
  "mcpServers": {
    "veilio": {
      "type": "stdio",
      "command": "/opt/homebrew/bin/node",
      "args": ["/opt/homebrew/lib/node_modules/@veilio-inc/mcp/dist/index.js", "--root", "/Users/you/code/YourApp"],
      "env": { "PATH": "/opt/homebrew/bin:/usr/bin:/bin" }
    }
  }
}
```

The paths above are for a Homebrew install with `npm install -g`; check yours
with `which node` and `npm root -g`. After restarting the agent, type `/context`
in the Agent panel to confirm the veilio tools loaded. Apple's configuration
format is new and may change between Xcode releases; if the file above is not
picked up, check Xcode's Intelligence settings for the current location.

### Cursor

`.cursor/mcp.json` in the project (or `~/.cursor/mcp.json` for every project):

```json
{
  "mcpServers": {
    "veilio": { "command": "npx", "args": ["-y", "@veilio-inc/mcp", "--root", "."] }
  }
}
```

### VS Code (GitHub Copilot agent mode)

`.vscode/mcp.json`:

```json
{
  "servers": {
    "veilio": { "type": "stdio", "command": "npx", "args": ["-y", "@veilio-inc/mcp", "--root", "${workspaceFolder}"] }
  }
}
```

### Any other MCP client

Veilio is a standard **stdio** MCP server: command `npx`, arguments
`-y @veilio-inc/mcp --root <project>`.

---

## 6. A typical session

1. In the assistant: *"Anonymize `src/payments/refund.ts` with veilio and review it."*
   The assistant calls `anonymize_file` and only ever sees placeholders.
2. It answers in placeholders.
3. *"Restore that answer with veilio."* - `restore_text` gives back real names.
   Anything it could not restore is listed, never guessed.

Tell your assistant once, for example in `CLAUDE.md` or your client's rules file:
*"Before reading source files, use the veilio `anonymize_file` tool; restore answers
with `restore_text`."*

---

## 7. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `Namespace: local` on a team plan | Run `veilio login`, then `veilio team unlock`; the unlock expires after 7 days and after a key rotation. |
| `that authentication code was not accepted` | The code expired or was used already; run `veilio login` again with a fresh one. |
| `this account's plan does not include terminal access` | Sign-in worked; the plan needs changing in the web app. |
| The client says the server failed to start | The client cannot find `npx`/`node`: use absolute paths (section 5). |
| A placeholder is "left as is" on restore | Two of your team's saved maps give it different names; restoring would be a guess. Load the map the text was anonymized with. |
| `veilio scrub` did not apply a new rule | Run `veilio rules pull`; `scrub` uses the saved copy and prints its age. |
