import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { callTool, TOOLS } from '../src/tools.js'

/**
 * The Community Edition contract for the MCP server (spec 011 T034, spec 052
 * FR-022/FR-023). With nobody signed in there is no team, and the server must
 * be exactly the offline tool it always was: the same tools, answering from
 * the local map, with no request.
 */

let cwd: string
let home: string
const realHome = process.env.HOME

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'veilio-mcp-ce-'))
  home = mkdtempSync(join(tmpdir(), 'veilio-mcp-ce-home-'))
  process.env.HOME = home
  mkdirSync(join(cwd, '.git'), { recursive: true })
  writeFileSync(join(cwd, 'ledger.ts'), 'export class LedgerService {}\n')
  vi.stubGlobal('fetch', vi.fn())
})

afterEach(() => {
  vi.unstubAllGlobals()
  process.env.HOME = realHome
  rmSync(cwd, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
})

describe('with no sign-in, the MCP server is the offline tool', () => {
  it('lists exactly the offline tools', () => {
    expect(TOOLS.map((t) => t.name).sort()).toEqual(
      [
        'anonymize_file',
        'anonymize_text',
        'restore_text',
        'scan_secrets',
        'symbol_map_summary',
      ].sort()
    )
  })

  it.each([
    ['anonymize_file', { path: 'ledger.ts' }],
    ['anonymize_text', { text: 'export class LedgerService {}' }],
  ])('%s answers from the local map, saying so, and makes no request', (name, args) => {
    const r = callTool(name, args, { cwd, mapPath: null })
    expect(r.isError ?? false).toBe(false)
    expect(r.text).toMatch(/Namespace: local/)
    expect(r.text).toContain('__CLS__1')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('restore_text, scan_secrets and symbol_map_summary answer with no error', () => {
    callTool('anonymize_text', { text: 'export class LedgerService {}' }, { cwd, mapPath: null })
    for (const [name, args] of [
      ['restore_text', { text: 'export class __CLS__1 {}' }],
      ['scan_secrets', { path: 'ledger.ts' }],
      ['symbol_map_summary', {}],
    ] as const) {
      expect(callTool(name, args, { cwd, mapPath: null }).isError ?? false).toBe(false)
    }
    expect(fetch).not.toHaveBeenCalled()
  })
})
