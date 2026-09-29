# @veilio-inc/mcp

MCP server that lets a coding agent work on your code **without the real identifiers ever entering its context.**

## Why path-based tools

A naive MCP anonymizer takes source code as a tool argument. That is self-defeating: to call it, the agent must already hold the real code — so the identifiers are already in the model's context and nothing was protected.

The primary tools here take a **file path**. The server reads the file in its own process and returns only the masked text. The agent learns `__CLS__1.__FN__2()` and never sees `PaymentGateway.chargeCard()`.

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
are still real.

## Tools

| Tool | Purpose |
|---|---|
| `anonymize_file` | Read a file and return only its masked form. **Preferred.** |
| `anonymize_text` | Mask text the agent already holds (a user paste). Not for file contents. |
| `restore_text` | Swap placeholders back and strip AI-generated noise — the team's placeholders too, under the rule below. |
| `scan_secrets` | Detect credentials without modifying anything, and without putting the values in context. |
| `symbol_map_summary` | Placeholder counts by kind. Returns keys only, never real names. |

Setup for Claude Code, Claude Desktop, Xcode, Cursor and VS Code, plus troubleshooting: [docs/USING-THE-CLI-AND-MCP.md](../../docs/USING-THE-CLI-AND-MCP.md).

## Install

```jsonc
// Claude Code — .mcp.json
{
  "mcpServers": {
    "veilio": {
      "command": "npx",
      "args": ["-y", "@veilio-inc/mcp", "--root", "."]
    }
  }
}
```

`--root <dir>` (or `-r`) scopes every path the server will read; `--map <path>` (or `-m`) overrides the symbol-map location. Paths outside the root are refused — the server reads files on the agent's behalf, so traversal would make it an arbitrary-file-read primitive.

## Team namespace (Team plan and above)

Sign in once with the `veilio` CLI — `veilio login` — and every anonymize
result from this server states which namespace produced its placeholders:

- **`team`** — resolved against the team's shared dictionary, read at startup,
  so every teammate's agent produces the same placeholder for the same
  identifier. Reused for the life of the process, with one exception: run
  `veilio team unlock` after the server started and the next call says it is
  loading the team's maps rather than making you restart the agent.
- **`local`** — resolved locally: not signed in, no team key unlocked on this
  machine, offline, or the plan doesn't include shared dictionaries. This is the
  normal, fully-functional state for anyone not on a paid team — the server never
  blocks on it, and the fallback is always stated, never silent.

There is no separate sign-in for the MCP server; it reads the same credential
file `veilio login` already wrote.

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
this machine - run \`veilio team unlock\`)` or `local (could not read the team's
maps: …)` — so a fallback is never read as agreement.

The account's custom rules are fetched at startup the same way and applied to
every anonymize call. Each result states their source: `from Cloud`, `cached`
(Cloud did not answer, so the last `veilio rules pull` is used, with its age),
or `none`.

### One restore rule, and what the server refuses to guess

`restore_text` resolves the team's maps first — aliases included — and this
project's map on top of them. Two kinds of placeholder are deliberately left in
the output, each named in a warning rather than substituted:

- one this project's store and the team use for **different** identifiers, and
- one this project **numbered on its own** while the team was out of reach.

Either could be restored to a name that is not the one a teammate meant, and a
confident wrong identifier is worse than a token the reader can see is
unresolved. They are also excluded from the "invented or altered" count, since
they were left for a stated reason.

When the team's maps *should* have been used and could not be — the key is
locked, or Cloud could not be read — the call comes back as an **error result**
saying which, even if some placeholders did restore. An older self-hosted Cloud
that merges the namespace server-side is used for anonymizing but never for
restoring: it cannot tell a disputed placeholder from a first-written one.

### After a lapse

Anonymizing while signed out, or while Cloud was unreachable, numbers new names
locally. Once the team's maps are back, an identifier the team already knows
takes the **team's** placeholder, and anything new is numbered above both the
team's highest and this project's own. The entries minted during the lapse stay
in the local store — text was already sent with them, so they are still needed
to restore it — but they are not handed to a teammate as the team's meaning.

## Design properties

- **Zero runtime dependencies.** JSON-RPC framing is implemented directly. Pulling a transitive tree into the component that reads your source would undercut the product's own claim.
- **stdout is protocol only.** Diagnostics go to stderr; a stray write to stdout corrupts the stream.
- **Tool errors, not protocol errors.** Failures come back as `isError` content so the model can correct itself, rather than aborting the call.
- **Redaction is one-way.** Credentials never enter the symbol map, so `restore_text` cannot bring them back.

The symbol map is shared with the `veilio` CLI, so you can mask in an agent and restore from a terminal, or the reverse.
