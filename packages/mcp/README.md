# @veilio/mcp

MCP server that lets a coding agent work on your code **without the real identifiers ever entering its context.**

## Why path-based tools

A naive MCP anonymizer takes source code as a tool argument. That is self-defeating: to call it, the agent must already hold the real code — so the identifiers are already in the model's context and nothing was protected.

The primary tools here take a **file path**. The server reads the file in its own process and returns only the masked text. The agent learns `__CLS__1.__FN__2()` and never sees `PaymentGateway.chargeCard()`.

```
tools/call anonymize_file { "path": "src/gateway.ts" }

→ Source: src/gateway.ts
  Language: TypeScript / JavaScript
  Placeholders in map: 7
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

## Tools

| Tool | Purpose |
|---|---|
| `anonymize_file` | Read a file and return only its masked form. **Preferred.** |
| `anonymize_text` | Mask text the agent already holds (a user paste). Not for file contents. |
| `restore_text` | Swap placeholders back and strip AI-generated noise. |
| `scan_secrets` | Detect credentials without modifying anything, and without putting the values in context. |
| `symbol_map_summary` | Placeholder counts by kind. Returns keys only, never real names. |

## Install

```jsonc
// Claude Code — .mcp.json
{
  "mcpServers": {
    "veilio": {
      "command": "npx",
      "args": ["-y", "@veilio/mcp", "--root", "."]
    }
  }
}
```

`--root <dir>` scopes every path the server will read; `--map <path>` overrides the symbol-map location. Paths outside the root are refused — the server reads files on the agent's behalf, so traversal would make it an arbitrary-file-read primitive.

## Design properties

- **Zero runtime dependencies.** JSON-RPC framing is implemented directly. Pulling a transitive tree into the component that reads your source would undercut the product's own claim.
- **stdout is protocol only.** Diagnostics go to stderr; a stray write to stdout corrupts the stream.
- **Tool errors, not protocol errors.** Failures come back as `isError` content so the model can correct itself, rather than aborting the call.
- **Redaction is one-way.** Credentials never enter the symbol map, so `restore_text` cannot bring them back.

The symbol map is shared with the `veilio` CLI, so you can mask in an agent and restore from a terminal, or the reverse.
