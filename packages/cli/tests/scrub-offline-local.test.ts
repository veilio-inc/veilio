import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { main } from '../src/index.js'
import { EXIT_OK, type Io } from '../src/commands.js'
import { loadMap, resolveMapPath, saveMap } from '../src/store.js'
import { mapsFor, teamScenario } from './helpers/team-scenario.js'
import { isolateHome } from './helpers/isolated-home.js'

isolateHome()

/**
 * Code review of spec 066 (FR-001): signed in to a team whose maps cannot be
 * read - the key locked, Cloud unreachable - scrub numbered above this
 * project's highest, which is where the next teammate's block starts. It now
 * numbers in the checkout's local family, and keeps the tag in reserved.json.
 */
let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

const TEAM = { __CLS__2: 'LedgerService', __FN__3: 'settleInvoice' }
const CODE = 'export class LedgerService { settleInvoice() {} reverseEntry() {} }\n'

async function scrub(home: string) {
  const cwd = mkdtempSync(join(tmpdir(), 'veilio-scrub-off-'))
  mkdirSync(join(cwd, '.git'))
  const mapPath = resolveMapPath(null, cwd)
  saveMap(mapPath, { __FN__3: 'settleInvoice' })
  let out = ''
  let err = ''
  const io: Io = {
    cwd,
    home,
    stdin: async () => CODE,
    stdinBytes: async () => Buffer.from(CODE),
    stdout: (t) => (out += t),
    stderr: (t) => (err += t),
  }
  const code = await main(['scrub'], io)
  const reservedPath = join(dirname(mapPath), 'reserved.json')
  return { code, out, err, map: loadMap(mapPath), reservedPath }
}

describe.each([
  ['the team key locked', { locked: true }],
  ['Cloud unreachable', { failures: 5, failStatus: 503 }],
])('signed in, %s', (_, opts) => {
  it('new names take the local family, never the next team number, and the tag is kept', async () => {
    const { home } = await teamScenario(fetchMock, {
      maps: mapsFor({ namespace: TEAM, aliases: {}, conflicts: {} }),
      ...opts,
    })
    const r = await scrub(home)
    expect(r.code, r.err).toBe(EXIT_OK)
    expect(r.out).not.toMatch(/__FN__4\b|__CLS__1\b/)
    const fresh = Object.keys(r.map).filter((p) => p !== '__FN__3')
    expect(fresh.length).toBeGreaterThan(0)
    for (const p of fresh) expect(p).toMatch(/^__LOCAL_[A-Z0-9]{6}_(?:CLS|FN)__\d+$/)
    expect(existsSync(r.reservedPath)).toBe(true)
    const file = JSON.parse(readFileSync(r.reservedPath, 'utf8')) as {
      teamId: string
      local: { tag: string }
    }
    expect(file.teamId).toBe('team-1')
    expect(fresh[0]).toContain(`__LOCAL_${file.local.tag}_`)
  })
})

describe('signed in, in no team', () => {
  it('numbering is unchanged and no reserved.json is written', async () => {
    const { home } = await teamScenario(fetchMock, {
      maps: mapsFor({ namespace: TEAM, aliases: {}, conflicts: {} }),
      noTeam: true,
    })
    const r = await scrub(home)
    expect(Object.keys(r.map).some((p) => p.startsWith('__LOCAL_'))).toBe(false)
    expect(existsSync(r.reservedPath)).toBe(false)
  })
})
