#!/usr/bin/env node
// stdio transport wiring.
//
// stdout carries the JSON-RPC stream and nothing else — a stray console.log
// here corrupts the protocol and the client drops the connection. Diagnostics
// go to stderr, which MCP clients surface as server logs.

import { FrameReader, type JsonRpcResponse } from './server.js'
import type { ToolContext } from './tools.js'

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

function start(): void {
  const ctx = parseCliContext(process.argv.slice(2))
  const send = (response: JsonRpcResponse): void => {
    process.stdout.write(`${JSON.stringify(response)}\n`)
  }
  const reader = new FrameReader(ctx, send)

  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk: string) => reader.push(chunk))
  process.stdin.on('end', () => process.exit(0))
  process.stderr.write(`veilio-mcp: serving ${ctx.cwd}\n`)
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  start()
}
