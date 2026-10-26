import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { handleMessage } from '../src/server.js'
import { callTool } from '../src/tools.js'
import { resetNamespaceCache } from '../src/namespace.js'

/**
 * FR-022 / FR-023 / SC-008 (spec 052) for the MCP server: with nobody signed
 * in, `initialize`, `tools/list` and the five offline tools answer exactly what
 * they answered before spec 052 - every byte - and make no request.
 *
 * Recorded at e6e6a09 (MCP 0.5.2) with `VEILIO_WRITE_GOLDEN=1`. Regenerating it
 * later to make a failure go away would make it a record of the current code,
 * which proves nothing; a deliberate change to an offline answer is a decision
 * to take to the founder, not a fixture to refresh.
 */

const GOLDEN = fileURLToPath(new URL('./fixtures/offline-golden.json', import.meta.url))

const SOURCE = `import { ledgerTotals } from '@acme/ledger-core'

// Settles a customer's ledger. Ticket ACME-42.
export class LedgerService {
  private readonly apiKey = 'AKIAIOSFODNN7EXAMPLE'
  settleInvoice(customerAccount: string): number {
    return ledgerTotals(customerAccount)
  }
}
`

type Step = { rpc: Record<string, unknown> } | { tool: string; args: Record<string, unknown> }

const CASES: { name: string; steps: Step[] }[] = [
  {
    name: 'initialize',
    steps: [
      {
        rpc: {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-06-18' },
        },
      },
    ],
  },
  { name: 'tools/list', steps: [{ rpc: { jsonrpc: '2.0', id: 2, method: 'tools/list' } }] },
  { name: 'anonymize_file', steps: [{ tool: 'anonymize_file', args: { path: 'src/ledger.ts' } }] },
  {
    name: 'anonymize_file with preamble',
    steps: [{ tool: 'anonymize_file', args: { path: 'src/ledger.ts', preamble: true } }],
  },
  { name: 'anonymize_text', steps: [{ tool: 'anonymize_text', args: { text: SOURCE } }] },
  {
    name: 'anonymize then restore',
    steps: [
      { tool: 'anonymize_file', args: { path: 'src/ledger.ts' } },
      { tool: 'restore_text', args: { text: 'class __CLS__1 { __FN__1() {} }\n' } },
    ],
  },
  {
    name: 'restore strict refuses',
    steps: [
      { tool: 'anonymize_file', args: { path: 'src/ledger.ts' } },
      { tool: 'restore_text', args: { text: 'class __CLS__1 { __FN__77() {} }', strict: true } },
    ],
  },
  { name: 'restore with no map', steps: [{ tool: 'restore_text', args: { text: '__CLS__1' } }] },
  { name: 'scan_secrets path', steps: [{ tool: 'scan_secrets', args: { path: 'src/ledger.ts' } }] },
  { name: 'scan_secrets text', steps: [{ tool: 'scan_secrets', args: { text: 'no secrets' } }] },
  { name: 'symbol_map_summary empty', steps: [{ tool: 'symbol_map_summary', args: {} }] },
  {
    name: 'symbol_map_summary after anonymize',
    steps: [
      { tool: 'anonymize_file', args: { path: 'src/ledger.ts' } },
      { tool: 'symbol_map_summary', args: {} },
    ],
  },
  {
    name: 'path outside the root',
    steps: [{ tool: 'anonymize_file', args: { path: '../../etc/passwd' } }],
  },
]

let home: string
const realHome = process.env.HOME

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'veilio-mcp-golden-home-'))
  process.env.HOME = home
  resetNamespaceCache()
  vi.stubGlobal('fetch', vi.fn())
})

afterEach(() => {
  vi.unstubAllGlobals()
  process.env.HOME = realHome
  rmSync(home, { recursive: true, force: true })
})

/** A response with the server's own version blanked: it moves on every release
 *  and is not part of the offline behaviour this pins. */
function normalise(value: unknown, cwd: string): unknown {
  const text = JSON.stringify(value).split(cwd).join('<CWD>')
  const parsed = JSON.parse(text) as { result?: { serverInfo?: { version?: string } } }
  if (parsed.result?.serverInfo?.version) parsed.result.serverInfo.version = '<VERSION>'
  return parsed
}

function runCase(steps: Step[]): unknown[] {
  const cwd = mkdtempSync(join(tmpdir(), 'veilio-mcp-golden-'))
  try {
    mkdirSync(join(cwd, '.git'), { recursive: true })
    mkdirSync(join(cwd, 'src'), { recursive: true })
    writeFileSync(join(cwd, 'src', 'ledger.ts'), SOURCE)
    const ctx = { cwd, mapPath: null }
    return steps.map((step) =>
      normalise(
        'rpc' in step ? handleMessage(step.rpc, ctx) : callTool(step.tool, step.args, ctx),
        cwd
      )
    )
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

describe('signed out, the MCP server answers byte for byte as before spec 052 (FR-022/FR-023)', () => {
  if (process.env.VEILIO_WRITE_GOLDEN === '1') {
    it('writes the golden outputs', () => {
      const all: Record<string, unknown[]> = {}
      for (const c of CASES) all[c.name] = runCase(c.steps)
      mkdirSync(join(GOLDEN, '..'), { recursive: true })
      writeFileSync(GOLDEN, `${JSON.stringify(all, null, 2)}\n`)
    })
    return
  }

  const golden = existsSync(GOLDEN)
    ? (JSON.parse(readFileSync(GOLDEN, 'utf8')) as Record<string, unknown[]>)
    : {}

  it('has a recorded output for every case, and no stale ones', () => {
    expect(Object.keys(golden).sort()).toEqual(CASES.map((c) => c.name).sort())
  })

  it.each(CASES.map((c) => [c.name, c] as const))('%s', (name, c) => {
    expect(runCase(c.steps)).toEqual(golden[name])
    expect(fetch, `${name} made a request`).not.toHaveBeenCalled()
  })
})
