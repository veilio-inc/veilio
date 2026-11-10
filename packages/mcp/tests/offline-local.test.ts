import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadMap, resolveMapPath, saveMap } from '@veilio-inc/cli/store'
import { writeCredential } from '@veilio-inc/cli/credential'
import { callTool } from '../src/tools.js'
import { namespaceSettled, primeNamespace, resetNamespaceCache } from '../src/namespace.js'
import { ACCOUNT, INSTANCE, mapsFor, teamScenario } from '../../cli/tests/helpers/team-scenario.js'

/**
 * Code review of spec 066 (FR-001): with the team's maps unreadable - key
 * locked, Cloud unreachable - the anonymize tools numbered above the map's
 * highest, where the next teammate's block starts. They now number in the
 * checkout's local family: reserved.json's tag where it is this account's,
 * else one held for this process. They still never write the file.
 */
let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  resetNamespaceCache()
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  resetNamespaceCache()
})

const maps = mapsFor({ namespace: { __FN__3: 'settleInvoice' }, aliases: {}, conflicts: {} })
const checkout = (withFile: boolean) => {
  const cwd = mkdtempSync(join(tmpdir(), 'veilio-mcp-off-'))
  const mapPath = resolveMapPath(null, cwd)
  saveMap(mapPath, { __FN__3: 'settleInvoice' })
  if (withFile) {
    mkdirSync(dirname(mapPath), { recursive: true })
    writeFileSync(
      join(dirname(mapPath), 'reserved.json'),
      JSON.stringify({
        version: 1,
        instance: INSTANCE,
        account: ACCOUNT,
        teamId: 'team-1',
        blocks: {},
        local: { tag: 'K7Q2XA' },
      })
    )
  }
  return { cwd, mapPath: null }
}
const fresh = (cwd: string) =>
  Object.keys(loadMap(resolveMapPath(null, cwd))).filter((p) => p !== '__FN__3')

describe.each([
  ['the team key locked', { locked: true }],
  ['Cloud unreachable', { failures: 5, failStatus: 503 }],
])('%s', (_, opts) => {
  it('with reserved.json: its tag', async () => {
    await primeNamespace((await teamScenario(fetchMock, { maps, ...opts })).home, {
      retryDelayMs: 0,
    })
    const ctx = checkout(true)
    const r = callTool('anonymize_text', { text: 'function reverseEntry() {}' }, ctx)
    expect(r.text).not.toMatch(/__FN__4\b/)
    expect(fresh(ctx.cwd)).toEqual(['__LOCAL_K7Q2XA_FN__1'])
  })

  it('without it: local under a tag of its own', async () => {
    await primeNamespace((await teamScenario(fetchMock, { maps, ...opts })).home, {
      retryDelayMs: 0,
    })
    const ctx = checkout(false)
    callTool('anonymize_text', { text: 'function reverseEntry() {}' }, ctx)
    expect(fresh(ctx.cwd)).toEqual([expect.stringMatching(/^__LOCAL_[A-Z0-9]{6}_FN__1$/)])
  })
})

// e85 (founder, 2026-11-10): a rate limit is not a reason to number from the
// local namespace. The anonymize tools refuse, in the words every rate-limited
// command already uses, and write nothing; the other fallbacks stay.
const LIMITED =
  'Run the command again in a minute; if it keeps failing, contact the instance’s support.'

describe('Cloud rate-limits the read of the team maps (429)', () => {
  it.each(['anonymize_text', 'anonymize_file'])(
    '%s refuses with the rate-limit wording and writes nothing',
    async (tool) => {
      await primeNamespace(
        (await teamScenario(fetchMock, { maps, failures: 5, failStatus: 429 })).home,
        { retryDelayMs: 0 }
      )
      const ctx = checkout(true)
      writeFileSync(join(ctx.cwd, 'entry.ts'), 'function reverseEntry() {}\n')
      const args =
        tool === 'anonymize_file' ? { path: 'entry.ts' } : { text: 'function reverseEntry() {}' }
      const r = callTool(tool, args, ctx)
      expect(r.isError, r.text).toBe(true)
      expect(r.text).toContain(LIMITED)
      expect(r.text).not.toMatch(/Namespace: local/)
      expect(fresh(ctx.cwd)).toEqual([])
    }
  )

  it('"again in a minute" holds: asked again after a minute, not sooner', async () => {
    const { home, calls } = await teamScenario(fetchMock, { maps, failures: 1, failStatus: 429 })
    await primeNamespace(home, { retryDelayMs: 0 })
    const ctx = checkout(true)
    const text = { text: 'function reverseEntry() {}' }
    const listings = () => calls.filter((p) => p === '/api/maps').length
    expect(callTool('anonymize_text', text, ctx).isError).toBe(true)
    expect(listings()).toBe(1)
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now')
    // Each recheck spends the same rate limit: none at the 30-second mark.
    clock.mockReturnValue(now + 31_000)
    expect(callTool('anonymize_text', text, ctx).isError).toBe(true)
    await namespaceSettled()
    expect(listings()).toBe(1)
    clock.mockReturnValue(now + 61_000)
    callTool('anonymize_text', text, ctx)
    await namespaceSettled()
    expect(listings()).toBe(2)
    const r = callTool('anonymize_text', text, ctx)
    expect(r.isError ?? false, r.text).toBe(false)
    expect(r.text).toMatch(/Namespace: team/)
  })

  it('another project chosen while rate-limited: still refused while its maps load', async () => {
    const { home } = await teamScenario(fetchMock, { maps, failures: 1, failStatus: 429 })
    await primeNamespace(home, { retryDelayMs: 0 })
    const ctx = checkout(true)
    const text = { text: 'function reverseEntry() {}' }
    writeCredential({ token: 't', account: ACCOUNT, instance: INSTANCE, project: 'p-other' }, home)
    for (const r of [
      callTool('anonymize_text', text, ctx),
      callTool('anonymize_text', text, ctx),
    ]) {
      expect(r.isError, r.text).toBe(true)
      expect(r.text).toContain(LIMITED)
    }
    expect(fresh(ctx.cwd)).toEqual([])
    await namespaceSettled()
    expect(callTool('anonymize_text', text, ctx).text).toMatch(/Namespace: team/)
  })

  it('signed in with no team known on this machine: a 429 masks locally, as before', async () => {
    const { home } = await teamScenario(fetchMock, {
      maps,
      locked: true,
      failures: 5,
      failStatus: 429,
    })
    await primeNamespace(home, { retryDelayMs: 0 })
    const r = callTool('anonymize_text', { text: 'function reverseEntry() {}' }, checkout(false))
    expect(r.isError ?? false, r.text).toBe(false)
    expect(r.text).toMatch(/Namespace: local \(could not read the team's maps: /)
  })

  it('a 503 still falls back to the local namespace, with the reason', async () => {
    await primeNamespace(
      (await teamScenario(fetchMock, { maps, failures: 5, failStatus: 503 })).home,
      { retryDelayMs: 0 }
    )
    const r = callTool('anonymize_text', { text: 'function reverseEntry() {}' }, checkout(true))
    expect(r.isError ?? false).toBe(false)
    expect(r.text).toMatch(/Namespace: local \(could not read the team's maps: /)
  })
})
