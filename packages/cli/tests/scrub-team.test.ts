import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { main } from '../src/index.js'
import { EXIT_OK, type Io } from '../src/commands.js'
import { loadMap, resolveMapPath } from '../src/store.js'
import { mapsFor, teamScenario } from './helpers/team-scenario.js'

/**
 * `veilio scrub` numbers from the team's namespace when signed in (spec 030,
 * F11 of the 2026-09-30 walk). It numbered from the project's own map only, so a
 * member's terminal gave `reverseEntry` the number the team uses for
 * `settleInvoice` - the web app and the MCP server use the team's numbering.
 */
let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

const TEAM = { __CLS__2: 'LedgerService', __FN__3: 'settleInvoice' }
const CODE = 'export class LedgerService { settleInvoice() {} reverseEntry() {} }\n'

async function scrub(stdin: string, home?: string, argv: string[] = ['scrub']) {
  const cwd = mkdtempSync(join(tmpdir(), 'veilio-scrub-team-'))
  let out = ''
  let err = ''
  const io: Io = {
    cwd,
    home,
    stdin: async () => stdin,
    stdout: (t) => (out += t),
    stderr: (t) => (err += t),
  }
  const code = await main(argv, io)
  return { code, out, err, map: loadMap(resolveMapPath(null, cwd)) }
}

describe('veilio scrub, signed in to a team', () => {
  it("uses the team's placeholders for names the team knows, and numbers new ones above the team's", async () => {
    const { home } = await teamScenario(fetchMock, {
      maps: mapsFor({ namespace: TEAM, aliases: {}, conflicts: {} }),
    })
    const r = await scrub(CODE, home)
    expect(r.code).toBe(EXIT_OK)
    expect(r.out).toBe('export class __CLS__2 { __FN__3() {} __FN__4() {} }\n')
    expect(r.err).toMatch(/Namespace: team/)
  })

  it('keeps in the project map only the team entries the output used', async () => {
    const big = { ...TEAM, __FN__9: 'unrelatedTeamName' }
    const { home } = await teamScenario(fetchMock, {
      maps: mapsFor({ namespace: big, aliases: {}, conflicts: {} }),
    })
    const r = await scrub(CODE, home)
    expect(r.map).toEqual({
      __CLS__2: 'LedgerService',
      __FN__3: 'settleInvoice',
      __FN__10: 'reverseEntry',
    })
  })

  it('the team key is locked: masked from the project map, and says why - even under --quiet', async () => {
    const { home } = await teamScenario(fetchMock, {
      maps: mapsFor({ namespace: TEAM, aliases: {}, conflicts: {} }),
      locked: true,
    })
    const r = await scrub(CODE, home, ['scrub', '--quiet'])
    expect(r.code).toBe(EXIT_OK)
    expect(r.out).toBe('export class __CLS__1 { __FN__1() {} __FN__2() {} }\n')
    expect(r.err).toMatch(/team key is locked[\s\S]*veilio team unlock/)
  })

  it('Cloud cannot be read: masked from the project map, with the reason', async () => {
    const { home } = await teamScenario(fetchMock, {
      maps: mapsFor({ namespace: TEAM, aliases: {}, conflicts: {} }),
      failures: 5,
      failStatus: 503,
    })
    const r = await scrub(CODE, home)
    expect(r.out).toBe('export class __CLS__1 { __FN__1() {} __FN__2() {} }\n')
    expect(r.err).toMatch(/could not read the team's maps/)
  })

  it('a hanging instance: gives up after 5 seconds and still writes the masked text', async () => {
    const { home } = await teamScenario(fetchMock, {
      maps: mapsFor({ namespace: TEAM, aliases: {}, conflicts: {} }),
      hang: true,
    })
    const started = Date.now()
    const r = await scrub(CODE, home)
    expect(Date.now() - started).toBeLessThan(7000)
    expect(r.out).toBe('export class __CLS__1 { __FN__1() {} __FN__2() {} }\n')
    expect(r.err).toMatch(/did not wait for Cloud/)
  }, 10000)

  it('signed in but in no team: the project map, no note', async () => {
    const { home } = await teamScenario(fetchMock, {
      maps: mapsFor({ namespace: TEAM, aliases: {}, conflicts: {} }),
      noTeam: true,
    })
    const r = await scrub(CODE, home)
    expect(r.out).toBe('export class __CLS__1 { __FN__1() {} __FN__2() {} }\n')
    expect(r.err).not.toMatch(/team/i)
  })
})

describe('veilio scrub, signed out', () => {
  it('makes no request at all, as before', async () => {
    const r = await scrub(CODE)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(r.out).toBe('export class __CLS__1 { __FN__1() {} __FN__2() {} }\n')
  })
})
