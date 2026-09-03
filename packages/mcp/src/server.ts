// MCP over JSON-RPC 2.0, implemented directly.
//
// No SDK dependency. The product's claim is that your source code is handled by
// auditable, local, dependency-free code; pulling a transitive tree into the
// component that reads your files to undercut that would be an odd trade for
// ~150 lines of message plumbing.

import { PRODUCT_NAME } from '@veilio-inc/engine'
import { callTool, TOOLS, type ToolContext } from './tools.js'

export const SERVER_VERSION = '0.1.0'

/** Protocol revisions this server implements. If the client asks for one of
 *  these we echo it back; otherwise we answer with our newest and let the
 *  client decide whether it can proceed. */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']
const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0]

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: string | number | null
  method: string
  params?: Record<string, unknown>
}

export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: string | number | null
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

// Standard JSON-RPC error codes.
const PARSE_ERROR = -32700
const INVALID_REQUEST = -32600
const METHOD_NOT_FOUND = -32601

function ok(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result }
}

function fail(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

/** Handle one parsed message. Returns null for notifications, which by spec
 *  MUST NOT be answered. */
export function handleMessage(message: unknown, ctx: ToolContext): JsonRpcResponse | null {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) {
    return fail(null, INVALID_REQUEST, 'request must be a JSON object')
  }
  const req = message as Partial<JsonRpcRequest>
  if (typeof req.method !== 'string') {
    return fail(req.id ?? null, INVALID_REQUEST, 'missing method')
  }
  // Absent id = notification. Handle the side effect, answer nothing.
  const isNotification = req.id === undefined
  const id = req.id ?? null
  const params = req.params ?? {}

  switch (req.method) {
    case 'initialize': {
      const requested = params.protocolVersion
      const protocolVersion =
        typeof requested === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
          ? requested
          : LATEST_PROTOCOL_VERSION
      return ok(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: `${PRODUCT_NAME} MCP`, version: SERVER_VERSION },
        instructions:
          `Use anonymize_file before reasoning about proprietary source: it reads the file ` +
          `itself and returns only masked code, so real identifiers never enter your context. ` +
          `Use scan_secrets to check a file or diff for credentials without seeing their values.`,
      })
    }

    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null

    case 'ping':
      return ok(id, {})

    case 'tools/list':
      return ok(id, {
        tools: TOOLS.map((t) => ({
          name: t.name,
          title: t.title,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      })

    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : ''
      const rawArgs = params.arguments
      const args =
        typeof rawArgs === 'object' && rawArgs !== null && !Array.isArray(rawArgs)
          ? (rawArgs as Record<string, unknown>)
          : {}
      const result = callTool(name, args, ctx)
      return ok(id, {
        content: [{ type: 'text', text: result.text }],
        isError: result.isError === true,
      })
    }

    default:
      if (isNotification) return null
      return fail(id, METHOD_NOT_FOUND, `unknown method "${req.method}"`)
  }
}

/** Parse and handle one newline-delimited frame. */
export function handleFrame(line: string, ctx: ToolContext): JsonRpcResponse | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return fail(null, PARSE_ERROR, 'invalid JSON')
  }
  return handleMessage(parsed, ctx)
}

/** Accumulates stdin chunks and emits one response per complete line. Kept
 *  separate from process wiring so it can be driven directly in tests. */
export class FrameReader {
  private buffer = ''

  constructor(
    private readonly ctx: ToolContext,
    private readonly send: (response: JsonRpcResponse) => void
  ) {}

  push(chunk: string): void {
    this.buffer += chunk
    let index: number
    while ((index = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (line.length === 0) continue
      const response = handleFrame(line, this.ctx)
      if (response !== null) this.send(response)
    }
  }
}
