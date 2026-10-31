import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveMapPath, saveMap } from '@veilio-inc/cli/store'
import { reservationRefusedSentence } from '@veilio-inc/cli/reservations'
import { callTool } from '../src/tools.js'
import { primeNamespace, resetNamespaceCache } from '../src/namespace.js'
import { ACCOUNT, INSTANCE, mapsFor, teamScenario } from '../../cli/tests/helpers/team-scenario.js'

/**
 * Spec 066 R8 (FR-005): while this checkout's last reservation is refused,
 * every anonymize result says so, in the CLI's sentence; a call that numbered
 * names locally says how many. The model reading the result is the one who
 * would otherwise believe its placeholders are the team's.
 */

let fetchMock: ReturnType<typeof vi.fn>
beforeEach(async () => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  resetNamespaceCache()
  const maps = mapsFor({ namespace: { __VAR__9: 'amount' }, aliases: {}, conflicts: {} })
  await primeNamespace((await teamScenario(fetchMock, { maps })).home)
})
afterEach(() => {
  vi.unstubAllGlobals()
  resetNamespaceCache()
})

const REFUSED = {
  reason: 'cap',
  at: '2026-10-31T10:00:00.000Z',
  nextAt: '2026-11-01T09:14:00.000Z',
}

function checkout(extra: Record<string, unknown>) {
  const cwd = mkdtempSync(join(tmpdir(), 'veilio-mcp-rv-'))
  const mapPath = resolveMapPath(null, cwd)
  mkdirSync(dirname(mapPath), { recursive: true })
  writeFileSync(
    join(dirname(mapPath), 'reserved.json'),
    JSON.stringify({
      version: 1,
      instance: INSTANCE,
      account: ACCOUNT,
      teamId: 'team-1',
      blocks: { __VAR__: { start: 41, end: 540 } },
      local: { tag: 'K7Q2XA' },
      ...extra,
    })
  )
  writeFileSync(join(cwd, 'a.ts'), 'export class HoldbackLedger { settleHoldback() {} }\n')
  writeFileSync(join(cwd, 'b.ts'), 'const x = amount\n')
  return { cwd, mapPath: null }
}
const sentence = reservationRefusedSentence({ reason: 'cap', nextAt: REFUSED.nextAt }, 'K7Q2XA')

describe.each([
  [
    'anonymize_text',
    { text: 'export class HoldbackLedger { settleHoldback() {} }' },
    { text: 'const x = amount' },
  ],
  ['anonymize_file', { path: 'a.ts' }, { path: 'b.ts' }],
])('%s', (tool, args, known) => {
  it('while refused: the sentence, and how many names were numbered locally', () => {
    const r = callTool(tool, args, checkout({ refused: REFUSED }))
    expect(r.isError ?? false, r.text).toBe(false)
    expect(r.text).toContain(sentence)
    expect(r.text).toMatch(/2 names numbered locally/)
  })

  it('while refused, with nothing new: the sentence still', () => {
    const ctx = checkout({ refused: REFUSED })
    const r = callTool(tool, known, ctx)
    expect(r.text).toContain(sentence)
    expect(r.text).not.toMatch(/numbered locally/)
  })

  it('not refused, a block ran out: only the local count', () => {
    const ctx = checkout({ blocks: {} })
    const r = callTool(tool, args, ctx)
    expect(r.text).not.toContain('could not reserve')
    expect(r.text).toMatch(/2 names numbered locally/)
  })

  it('not refused, nothing local: neither line', () => {
    const ctx = checkout({
      blocks: { __CLS__: { start: 1, end: 500 }, __FN__: { start: 1, end: 500 } },
    })
    saveMap(resolveMapPath(null, ctx.cwd), {})
    const r = callTool(tool, args, ctx)
    expect(r.text).not.toContain('could not reserve')
    expect(r.text).not.toMatch(/numbered locally/)
  })
})
