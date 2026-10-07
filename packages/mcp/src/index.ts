#!/usr/bin/env node
// stdio transport wiring.
//
// stdout carries the JSON-RPC stream and nothing else — a stray console.log
// here corrupts the protocol and the client drops the connection. Diagnostics
// go to stderr, which MCP clients surface as server logs.

import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { FrameReader, type JsonRpcResponse } from './server.js'
import type { ToolContext } from './tools.js'
import { primeNamespace } from './namespace.js'
import { primeRules } from './rules.js'

export { FrameReader, handleFrame, handleMessage, SERVER_VERSION } from './server.js'
export { TOOLS, callTool } from './tools.js'

function parseCliContext(argv: readonly string[]): ToolContext {
  let cwd = process.cwd()
  let mapPath: string | null = null
  for (let i = 0; i < argv.length; i++) {
    if ((argv[i] === '--root' || argv[i] === '-r') && argv[i + 1] !== undefined) {
      cwd = argv[++i]
    } else if ((argv[i] === '--map' || argv[i] === '-m') && argv[i + 1] !== undefined) {
      mapPath = argv[++i]
    }
  }
  return { cwd, mapPath }
}

async function start(): Promise<void> {
  const ctx = parseCliContext(process.argv.slice(2))
  const send = (response: JsonRpcResponse): void => {
    process.stdout.write(`${JSON.stringify(response)}\n`)
  }
  const reader = new FrameReader(ctx, send)

  // Resolved once, before a single byte of stdin is read, so every tool call
  // for the rest of this process sees the answer already settled rather than
  // racing the first one in (contracts/shared-namespace.md R-007). Never
  // throws — see namespace.ts — so this can only delay startup, not fail it.
  await Promise.all([primeNamespace(), primeRules()])

  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk: string) => reader.push(chunk))
  process.stdin.on('end', () => process.exit(0))
  process.stderr.write(`veilio-mcp: serving ${ctx.cwd}\n`)
}

/**
 * Was this file run as a program, or imported?
 *
 * Comparing `import.meta.url` to `file://${process.argv[1]}` is wrong, and it
 * shipped here as it once did in the CLI: npx and npm run a binary through a
 * SYMLINK in node_modules/.bin, so `argv[1]` is the link while
 * `import.meta.url` is the file it resolves to. A path with a space, and every
 * Windows path (`C:\...` against `file:///C:/...`), fail the same way. The
 * server then exited 0 having said nothing, and the agent saw a server that
 * never answered.
 *
 * `realpathSync` resolves the link; `pathToFileURL` builds the URL the way
 * Node does. Wrapped because `argv[1]` may name something unstattable
 * (`node --eval`), which is not a program.
 */
function invokedAsProgram(): boolean {
  const argv1 = process.argv[1]
  if (argv1 === undefined) return false
  try {
    return import.meta.url === pathToFileURL(realpathSync(argv1)).href
  } catch {
    return false
  }
}

if (invokedAsProgram()) {
  void start()
}
