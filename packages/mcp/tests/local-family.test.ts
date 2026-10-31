import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadMap, resolveMapPath } from '@veilio-inc/cli/store'
import { callTool } from '../src/tools.js'
import { primeNamespace, resetNamespaceCache } from '../src/namespace.js'
import { ACCOUNT, INSTANCE, mapsFor, teamScenario } from '../../cli/tests/helpers/team-scenario.js'

/**
 * Spec 066 R3: the MCP server's anonymize tools number like the guard and
 * signed-in scrub - inside this checkout's usable block from reserved.json,
 * else in its local family. It only reads the file: it never writes it and
 * never reserves (spec 011 FR-009).
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

const CODE = 'export const holdbackDays = amount\n'

function checkout(reserved?: Record<string, unknown>) {
  const cwd = mkdtempSync(join(tmpdir(), 'veilio-mcp-lf-'))
  writeFileSync(join(cwd, 'a.ts'), CODE)
  const file = join(dirname(resolveMapPath(null, cwd)), 'reserved.json')
  if (reserved) {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        instance: INSTANCE,
        account: ACCOUNT,
        teamId: 'team-1',
        blocks: { __VAR__: { start: 41, end: 540 } },
        local: { tag: 'K7Q2XA' },
        ...reserved,
      })
    )
  }
  return { ctx: { cwd, mapPath: null }, file, cwd }
}
const minted = (cwd: string) =>
  Object.keys(loadMap(resolveMapPath(null, cwd))).filter((p) => p !== '__VAR__9')
const reserveCalls = () =>
  fetchMock.mock.calls.filter(([url]) => String(url).includes('/placeholders/reserve')).length

describe.each(['anonymize_text', 'anonymize_file'])('%s', (tool) => {
  const args = tool === 'anonymize_text' ? { text: CODE } : { path: 'a.ts' }

  it('mints inside a usable block', () => {
    const { ctx, cwd, file } = checkout({})
    const before = readFileSync(file, 'utf8')
    const r = callTool(tool, args, ctx)
    expect(r.isError ?? false, r.text).toBe(false)
    expect(minted(cwd)).toEqual(['__VAR__41'])
    expect(readFileSync(file, 'utf8')).toBe(before)
    expect(reserveCalls()).toBe(0)
  })

  it('mints local under the checkout’s tag with no block', () => {
    const { ctx, cwd } = checkout({ blocks: {} })
    callTool(tool, args, ctx)
    expect(minted(cwd)).toEqual(['__LOCAL_K7Q2XA_VAR__1'])
  })

  it('with no file: local, and no file is written', () => {
    const { ctx, cwd, file } = checkout()
    callTool(tool, args, ctx)
    expect(minted(cwd)).toEqual([expect.stringMatching(/^__LOCAL_[A-Z0-9]{6}_VAR__1$/)])
    expect(existsSync(file)).toBe(false)
    expect(reserveCalls()).toBe(0)
  })

  it('another account’s file is no blocks: local, never its tag', () => {
    const { ctx, cwd } = checkout({ account: 'someone@example.test' })
    callTool(tool, args, ctx)
    const [p] = minted(cwd)
    expect(p).toMatch(/^__LOCAL_[A-Z0-9]{6}_VAR__1$/)
    expect(p).not.toContain('K7Q2XA')
  })
})
