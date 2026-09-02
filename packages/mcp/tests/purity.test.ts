import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { callTool, type ToolContext } from '../src/tools.js'

// 005-c1 FR-003, applied to 006-c2. The MCP server carries a sharper version of
// the same claim than the CLI does: it exists so an agent never holds the real
// code, which is worthless if the server itself can send that code somewhere.
// It runs unattended, inside someone else's agent loop, so "we would have
// noticed" is not available as an argument.

let cwd: string
let ctx: ToolContext

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'veilio-mcp-purity-'))
  ctx = { cwd, mapPath: null }
})

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true })
})

const NETWORK_GLOBALS = [
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'navigator',
  'importScripts',
] as const

function trapped<T>(fn: () => T): { value: T; tripped: string[] } {
  const tripped: string[] = []
  const g = globalThis as unknown as Record<string, unknown>
  const saved = new Map<string, { present: boolean; value: unknown }>()

  for (const name of NETWORK_GLOBALS) {
    saved.set(name, { present: name in g, value: g[name] })
    Object.defineProperty(g, name, {
      configurable: true,
      writable: true,
      value: new Proxy(function trap() {} as object, {
        get: () => (tripped.push(name), undefined),
        apply: () => {
          tripped.push(name)
          throw new Error(`${name} was called`)
        },
        construct: () => {
          tripped.push(name)
          throw new Error(`${name} was constructed`)
        },
      }),
    })
  }

  try {
    return { value: fn(), tripped }
  } finally {
    for (const [name, { present, value }] of saved) {
      if (present) Object.defineProperty(g, name, { configurable: true, writable: true, value })
      else delete g[name]
    }
  }
}

const SOURCE = [
  '// Ping Kowalska about the Contoso incident, acct 88412037',
  'export class PaymentGateway {',
  '  chargeCard(amount: number) { return amount }',
  '}',
  'const key = "AKIAIOSFODNN7EXAMPLE"',
].join('\n')

describe('MCP purity — every tool, with the network trapped', () => {
  it('anonymize_file touches no network global', () => {
    writeFileSync(join(cwd, 'a.ts'), SOURCE)
    const { tripped } = trapped(() => callTool('anonymize_file', { path: 'a.ts' }, ctx))
    expect(tripped).toEqual([])
  })

  it('anonymize_text touches no network global', () => {
    const { tripped } = trapped(() => callTool('anonymize_text', { text: SOURCE }, ctx))
    expect(tripped).toEqual([])
  })

  it('restore_text touches no network global', () => {
    writeFileSync(join(cwd, 'a.ts'), SOURCE)
    callTool('anonymize_file', { path: 'a.ts' }, ctx)
    const { tripped } = trapped(() => callTool('restore_text', { text: '__CLS__1' }, ctx))
    expect(tripped).toEqual([])
  })

  it('scan_secrets touches no network global', () => {
    writeFileSync(join(cwd, 'a.ts'), SOURCE)
    const { tripped } = trapped(() => callTool('scan_secrets', { path: 'a.ts' }, ctx))
    expect(tripped).toEqual([])
  })

  it('symbol_map_summary touches no network global', () => {
    writeFileSync(join(cwd, 'a.ts'), SOURCE)
    callTool('anonymize_file', { path: 'a.ts' }, ctx)
    const { tripped } = trapped(() => callTool('symbol_map_summary', {}, ctx))
    expect(tripped).toEqual([])
  })

  it('the trap actually trips', () => {
    // Without this, every assertion above is `toEqual([])` against a tripwire
    // that could have quietly stopped being connected to anything.
    const { tripped } = trapped(() => {
      try {
        ;(globalThis as unknown as { fetch: () => void }).fetch()
      } catch {
        // expected — the trap throws
      }
      return null
    })
    expect(tripped).toEqual(['fetch'])
  })
})

describe('MCP purity — nothing that opens a socket is even imported', () => {
  const SOURCES = ['index.ts', 'server.ts', 'tools.ts'] as const
  const sources = SOURCES.map((name) => ({
    name,
    text: readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8'),
  }))

  it('imports no network or subprocess module', () => {
    const banned = [
      'node:http',
      'node:https',
      'node:net',
      'node:tls',
      'node:dns',
      'node:dgram',
      'node:child_process',
      "from 'http'",
      "from 'https'",
      "from 'net'",
    ]
    for (const { name, text } of sources) {
      for (const token of banned) {
        expect(text.includes(token), `${name} must not reference ${token}`).toBe(false)
      }
    }
  })

  it('declares no runtime dependency outside the Veilio scope', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    const outside = Object.keys(pkg.dependencies ?? {}).filter((d) => !d.startsWith('@veilio-inc/'))
    expect(outside).toEqual([])
  })

  it('speaks its protocol over stdio only', () => {
    // The transport is the thing worth pinning: an MCP server that grew an HTTP
    // listener would be reachable by something other than the agent that
    // started it, and the file-path design assumes exactly one caller.
    const index = sources.find((s) => s.name === 'index.ts')!.text
    expect(index).toContain('stdin')
    expect(index).toContain('stdout')
    expect(index.includes('listen(')).toBe(false)
    expect(index.includes('createServer')).toBe(false)
  })
})
