import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FrameReader, handleFrame, handleMessage, SUPPORTED_PROTOCOL_VERSIONS } from '../src/server.js'
import { TOOLS, callTool, type ToolContext } from '../src/tools.js'
import { resolveMapPath, saveMap } from '@veilio/cli/store'

let cwd: string
let ctx: ToolContext

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'veilio-mcp-'))
  ctx = { cwd, mapPath: null }
})

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true })
})

const TS = 'export class PaymentGateway {\n  chargeCard(amount: number) { return amount }\n}\n'
const KEY = 'sk_live_51H8xQ2ABCDEFGHIJKLMNOP'

function write(name: string, content: string): void {
  writeFileSync(join(cwd, name), content)
}

function call(name: string, args: Record<string, unknown> = {}) {
  return callTool(name, args, ctx)
}

/** Seed the project store for cases a real anonymize pass cannot produce on
 *  demand — a legacy plain-style map, or a key that is not a placeholder at
 *  all. Goes through the store's own writer rather than hand-rolling the file,
 *  so the envelope format stays the store's business. */
function writeMap(map: Record<string, string>): void {
  saveMap(resolveMapPath(null, cwd), map)
}

describe('protocol', () => {
  it('answers initialize with capabilities and server info', () => {
    const res = handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, ctx)
    const result = res?.result as Record<string, any>
    expect(result.capabilities.tools).toBeDefined()
    expect(result.serverInfo.name).toContain('MCP')
    expect(result.instructions).toContain('anonymize_file')
  })

  it('echoes a protocol version it supports', () => {
    for (const version of SUPPORTED_PROTOCOL_VERSIONS) {
      const res = handleMessage(
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: version } },
        ctx
      )
      expect((res?.result as any).protocolVersion).toBe(version)
    }
  })

  it('falls back to its newest version for an unknown request', () => {
    const res = handleMessage(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } },
      ctx
    )
    expect((res?.result as any).protocolVersion).toBe(SUPPORTED_PROTOCOL_VERSIONS[0])
  })

  it('never answers a notification', () => {
    expect(handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, ctx)).toBeNull()
    expect(handleMessage({ jsonrpc: '2.0', method: 'notifications/cancelled' }, ctx)).toBeNull()
    expect(handleMessage({ jsonrpc: '2.0', method: 'something/unknown' }, ctx)).toBeNull()
  })

  it('answers ping', () => {
    expect(handleMessage({ jsonrpc: '2.0', id: 7, method: 'ping' }, ctx)?.result).toEqual({})
  })

  it('rejects an unknown method that expects a reply', () => {
    const res = handleMessage({ jsonrpc: '2.0', id: 2, method: 'nope' }, ctx)
    expect(res?.error?.code).toBe(-32601)
  })

  it('rejects a non-object message', () => {
    expect(handleMessage('hello', ctx)?.error?.code).toBe(-32600)
    expect(handleMessage([1, 2], ctx)?.error?.code).toBe(-32600)
  })

  it('rejects a message with no method', () => {
    expect(handleMessage({ jsonrpc: '2.0', id: 1 }, ctx)?.error?.code).toBe(-32600)
  })

  it('reports malformed JSON as a parse error', () => {
    expect(handleFrame('{ not json', ctx)?.error?.code).toBe(-32700)
  })

  it('preserves the request id on the response', () => {
    expect(handleMessage({ jsonrpc: '2.0', id: 'abc', method: 'ping' }, ctx)?.id).toBe('abc')
  })
})

describe('tools/list', () => {
  it('advertises every tool with a schema', () => {
    const res = handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, ctx)
    const tools = (res?.result as any).tools
    expect(tools).toHaveLength(TOOLS.length)
    for (const tool of tools) {
      expect(tool.name).toBeTruthy()
      expect(tool.description).toBeTruthy()
      expect(tool.inputSchema.type).toBe('object')
    }
  })

  it('steers the model toward the path-based tool', () => {
    const res = handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, ctx)
    const byName = new Map((res?.result as any).tools.map((t: any) => [t.name, t]))
    expect((byName.get('anonymize_file') as any).description).toContain('PREFER THIS')
    expect((byName.get('anonymize_text') as any).description).toContain('defeats the purpose')
  })
})

describe('framing', () => {
  it('emits one response per newline-delimited frame', () => {
    const sent: unknown[] = []
    const reader = new FrameReader(ctx, (r) => sent.push(r))
    reader.push('{"jsonrpc":"2.0","id":1,"method":"ping"}\n')
    reader.push('{"jsonrpc":"2.0","id":2,"method":"ping"}\n')
    expect(sent).toHaveLength(2)
  })

  it('reassembles a frame split across chunks', () => {
    const sent: any[] = []
    const reader = new FrameReader(ctx, (r) => sent.push(r))
    reader.push('{"jsonrpc":"2.0","id":')
    expect(sent).toHaveLength(0)
    reader.push('9,"method":"ping"}\n')
    expect(sent[0].id).toBe(9)
  })

  it('handles several frames arriving in one chunk', () => {
    const sent: unknown[] = []
    const reader = new FrameReader(ctx, (r) => sent.push(r))
    reader.push('{"jsonrpc":"2.0","id":1,"method":"ping"}\n{"jsonrpc":"2.0","id":2,"method":"ping"}\n')
    expect(sent).toHaveLength(2)
  })

  it('ignores blank lines', () => {
    const sent: unknown[] = []
    const reader = new FrameReader(ctx, (r) => sent.push(r))
    reader.push('\n\n{"jsonrpc":"2.0","id":1,"method":"ping"}\n\n')
    expect(sent).toHaveLength(1)
  })

  it('does not emit for a notification frame', () => {
    const sent: unknown[] = []
    const reader = new FrameReader(ctx, (r) => sent.push(r))
    reader.push('{"jsonrpc":"2.0","method":"notifications/initialized"}\n')
    expect(sent).toHaveLength(0)
  })
})

// The property the whole design exists for.
describe('anonymize_file — real names never reach the caller', () => {
  it('returns masked code only', () => {
    write('billing.ts', TS)
    const res = call('anonymize_file', { path: 'billing.ts' })
    expect(res.text).not.toContain('PaymentGateway')
    expect(res.text).not.toContain('chargeCard')
    expect(res.text).toContain('__CLS__1')
  })

  it('reports the detected language', () => {
    write('billing.go', 'package billing\n\nfunc Apply(rate float64) error { return nil }\n')
    expect(call('anonymize_file', { path: 'billing.go' }).text).toContain('Go')
  })

  it('honours an explicit language', () => {
    write('a.txt', TS)
    expect(call('anonymize_file', { path: 'a.txt', language: 'python' }).text).toContain('Python')
  })

  it('persists the map for a later restore', () => {
    write('billing.ts', TS)
    call('anonymize_file', { path: 'billing.ts' })
    const stored = JSON.parse(readFileSync(join(cwd, '.veilio', 'map.json'), 'utf8'))
    expect(Object.values(stored.map)).toContain('PaymentGateway')
  })

  it('adds the preamble on request', () => {
    write('billing.ts', TS)
    expect(call('anonymize_file', { path: 'billing.ts', preamble: true }).text).toContain(
      'Placeholder legend'
    )
  })

  it('redacts a credential and never echoes it', () => {
    write('cfg.ts', `const k = "${KEY}"\n`)
    const res = call('anonymize_file', { path: 'cfg.ts' })
    expect(res.text).toContain('__REDACTED_STRIPE_KEY_1__')
    expect(res.text).not.toContain(KEY)
  })

  it('errors on a missing file', () => {
    const res = call('anonymize_file', { path: 'nope.ts' })
    expect(res.isError).toBe(true)
    expect(res.text).toContain('cannot read')
  })

  it('errors when path is missing', () => {
    expect(call('anonymize_file', {}).isError).toBe(true)
  })

  it('errors when path is not a string', () => {
    expect(call('anonymize_file', { path: 42 }).isError).toBe(true)
  })
})

describe('path containment', () => {
  it('refuses to escape the project root', () => {
    // The server reads files for the agent, so traversal here would be an
    // arbitrary-file-read primitive.
    const res = call('anonymize_file', { path: '../../etc/passwd' })
    expect(res.isError).toBe(true)
    expect(res.text).toContain('outside the project root')
  })

  it('refuses an absolute path outside the root', () => {
    const res = call('scan_secrets', { path: '/etc/hosts' })
    expect(res.isError).toBe(true)
    expect(res.text).toContain('outside the project root')
  })

  it('allows a nested path inside the root', () => {
    mkdirSync(join(cwd, 'src'), { recursive: true })
    write('src/a.ts', TS)
    expect(call('anonymize_file', { path: 'src/a.ts' }).isError).toBeUndefined()
  })
})

describe('anonymize_text', () => {
  it('masks text passed inline', () => {
    const res = call('anonymize_text', { text: TS })
    expect(res.text).not.toContain('PaymentGateway')
  })

  it('errors without text', () => {
    expect(call('anonymize_text', {}).isError).toBe(true)
  })
})

describe('restore_text', () => {
  it('round-trips a file through mask and restore', () => {
    write('billing.ts', TS)
    const masked = call('anonymize_file', { path: 'billing.ts' })
    const body = masked.text.split('--- masked code ---\n')[1]
    const restored = call('restore_text', { text: body })
    expect(restored.text).toContain('PaymentGateway')
    expect(restored.text).toContain('chargeCard')
  })

  it('errors when there is no map yet', () => {
    const res = call('restore_text', { text: '__CLS__1' })
    expect(res.isError).toBe(true)
    expect(res.text).toContain('no symbol map yet')
  })

  it('does not resurrect a redacted credential', () => {
    write('cfg.ts', `const stripeClient = init("${KEY}")\n`)
    const masked = call('anonymize_file', { path: 'cfg.ts' })
    const body = masked.text.split('--- masked code ---\n')[1]
    const res = call('restore_text', { text: body })
    // Identifiers come back; the credential does not.
    expect(res.text).toContain('stripeClient')
    expect(res.text).not.toContain(KEY)
    expect(res.text).toContain('__REDACTED_STRIPE_KEY_1__')
  })
})

// This report matters more over MCP than anywhere else in the product: the
// caller here is the model, and the model is usually what broke the
// placeholder. Told which token it mangled, it can go back and fix its own
// reply — a correction loop no human-facing panel can close.
describe('restore_text — round-trip report', () => {
  function seedMap() {
    write('billing.ts', TS)
    call('anonymize_file', { path: 'billing.ts' })
  }

  it('counts what came back rather than what the map holds', () => {
    seedMap()
    const res = call('restore_text', { text: 'new __CLS__1()' })
    expect(res.text).toContain('Restored 1 of 3 placeholders')
  })

  it('names a token no map entry explains and says what to do about it', () => {
    seedMap()
    const res = call('restore_text', { text: 'new __CLS__1().__FN__9()' })
    expect(res.text).toContain('WARNING')
    expect(res.text).toContain('__FN__9')
    expect(res.text).toMatch(/invented or altered/)
    expect(res.text).toMatch(/restore again/)
  })

  it('reports placeholders that never appeared, without calling them an error', () => {
    seedMap()
    const res = call('restore_text', { text: 'new __CLS__1()' })
    expect(res.text).toMatch(/never appeared in the text/)
    expect(res.text).toContain('__FN__1')
    expect(res.text).not.toContain('WARNING')
  })

  it('stays quiet on a clean round trip', () => {
    // A model that echoed everything correctly should not have to read a
    // paragraph about it; noise here costs context on every single call.
    write('billing.ts', TS)
    const masked = call('anonymize_file', { path: 'billing.ts' })
    const body = masked.text.split('--- masked code ---\n')[1]
    const res = call('restore_text', { text: body })

    expect(res.text).toContain('Restored 3 of 3 placeholders')
    expect(res.text).not.toContain('WARNING')
    expect(res.text).not.toMatch(/never appeared/)
  })

  it('does not flag a redacted credential as an invented token', () => {
    // __REDACTED_*__ is never written to the map by design, so it remaining in
    // the text is correct. Warning about it would fire the alarm on every
    // restore involving a credential.
    write('cfg.ts', `const stripeClient = init("${KEY}")\n`)
    const masked = call('anonymize_file', { path: 'cfg.ts' })
    const body = masked.text.split('--- masked code ---\n')[1]
    const res = call('restore_text', { text: body })

    expect(res.text).toContain('__REDACTED_STRIPE_KEY_1__')
    expect(res.text).not.toContain('WARNING')
  })

  it('still returns the restored text alongside the warning', () => {
    // The report is additional information, not a replacement for the output.
    seedMap()
    const res = call('restore_text', { text: 'new __CLS__1().__FN__9()' })
    expect(res.text).toContain('--- restored ---')
    expect(res.text).toContain('PaymentGateway')
  })
})

describe('scan_secrets', () => {
  it('reports a clean file', () => {
    write('billing.ts', TS)
    expect(call('scan_secrets', { path: 'billing.ts' }).text).toContain('No credentials detected')
  })

  it('finds a credential without echoing its value', () => {
    write('cfg.ts', `const k = "${KEY}"\n`)
    const res = call('scan_secrets', { path: 'cfg.ts' })
    expect(res.text).toContain('critical')
    expect(res.text).toContain('Stripe secret key')
    expect(res.text).not.toContain(KEY)
  })

  it('scans inline text', () => {
    expect(call('scan_secrets', { text: `k = "${KEY}"` }).text).toContain('critical')
  })

  it('does not modify anything', () => {
    write('cfg.ts', `const k = "${KEY}"\n`)
    call('scan_secrets', { path: 'cfg.ts' })
    expect(readFileSync(join(cwd, 'cfg.ts'), 'utf8')).toContain(KEY)
  })

  it('rejects both path and text at once', () => {
    const res = call('scan_secrets', { path: 'a.ts', text: 'x' })
    expect(res.isError).toBe(true)
    expect(res.text).toContain('not both')
  })

  it('rejects neither path nor text', () => {
    expect(call('scan_secrets', {}).isError).toBe(true)
  })

  it('errors on an unreadable file', () => {
    expect(call('scan_secrets', { path: 'nope.ts' }).isError).toBe(true)
  })
})

describe('symbol_map_summary', () => {
  it('reports an empty map', () => {
    expect(call('symbol_map_summary').text).toContain('No symbol map yet')
  })

  it('breaks placeholders down by kind', () => {
    write('billing.ts', TS)
    call('anonymize_file', { path: 'billing.ts' })
    const res = call('symbol_map_summary')
    expect(res.text).toContain('__CLS__*')
    expect(res.text).toContain('placeholders at')
  })

  it('never reveals a real identifier', () => {
    // The summary exists so the agent can reason about coverage without
    // de-anonymizing anything.
    write('billing.ts', TS)
    call('anonymize_file', { path: 'billing.ts' })
    const res = call('symbol_map_summary')
    expect(res.text).not.toContain('PaymentGateway')
    expect(res.text).not.toContain('chargeCard')
  })

  // Grouping asks the engine whether a key is a placeholder instead of keeping
  // a local copy of the pattern. These pin the behaviour that swap must
  // preserve — mis-grouping is silent, so nothing else would catch it.
  it('groups every role the engine mints, not just a listed few', () => {
    writeMap({ __CLS__1: 'A', __CLS__2: 'B', __FN__1: 'c', __VAR__1: 'd', __MANUAL__1: 'e' })
    const res = call('symbol_map_summary').text

    expect(res).toContain('__CLS__* × 2')
    expect(res).toContain('__FN__* × 1')
    expect(res).toContain('__VAR__* × 1')
    expect(res).toContain('__MANUAL__* × 1')
  })

  it('keeps legacy plain placeholders under their own key', () => {
    // __P1__ carries no role and no trailing counter to strip, so it groups as
    // itself. Refusing or mangling it would misreport every map exported before
    // role-typed placeholders existed.
    writeMap({ __P1__: 'A', __P2__: 'B' })
    const res = call('symbol_map_summary').text

    expect(res).toContain('__P1__')
    expect(res).toContain('2 placeholders at')
  })

  it('leaves a key that is not a placeholder ungrouped rather than guessing', () => {
    writeMap({ notAPlaceholder: 'A', __FN__1: 'b' })
    const res = call('symbol_map_summary').text

    expect(res).toContain('notAPlaceholder')
    expect(res).toContain('__FN__* × 1')
  })
})

describe('tools/call dispatch', () => {
  it('returns MCP content blocks', () => {
    write('billing.ts', TS)
    const res = handleMessage(
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'anonymize_file', arguments: { path: 'billing.ts' } },
      },
      ctx
    )
    const result = res?.result as any
    expect(result.content[0].type).toBe('text')
    expect(result.isError).toBe(false)
  })

  it('flags an unknown tool as a tool error, not a protocol error', () => {
    // MCP clients feed tool errors back to the model so it can self-correct; a
    // JSON-RPC error usually aborts the call instead.
    const res = handleMessage(
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope' } },
      ctx
    )
    expect(res?.error).toBeUndefined()
    expect((res?.result as any).isError).toBe(true)
  })

  it('tolerates missing or malformed arguments', () => {
    const res = handleMessage(
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'symbol_map_summary' } },
      ctx
    )
    expect((res?.result as any).isError).toBe(false)
  })

  it('tolerates a non-object arguments value', () => {
    const res = handleMessage(
      {
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: { name: 'anonymize_file', arguments: 'oops' },
      },
      ctx
    )
    expect((res?.result as any).isError).toBe(true)
  })
})
