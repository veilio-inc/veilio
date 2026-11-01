import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { main } from '../src/index.js'
import { EXIT_OK, type Io } from '../src/commands.js'
import { loadMap, resolveMapPath, saveMap } from '../src/store.js'
import { mapsFor, teamScenario } from './helpers/team-scenario.js'
import { isolateHome } from './helpers/isolated-home.js'

isolateHome()

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
/** Spec 066: a checkout with no block numbers new names in its local family. */
const LOCAL = '__LOCAL_[A-Z0-9]{6}_'
const LOCAL_ONLY = new RegExp(
  `^export class ${LOCAL}CLS__1 \\{ ${LOCAL}FN__1\\(\\) \\{\\} ${LOCAL}FN__2\\(\\) \\{\\} \\}\\n$`
)

async function scrub(
  stdin: string,
  home?: string,
  argv: string[] = ['scrub'],
  own: Record<string, string> = {}
) {
  const cwd = mkdtempSync(join(tmpdir(), 'veilio-scrub-team-'))
  if (Object.keys(own).length) saveMap(resolveMapPath(null, cwd), own)
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
  it("uses the team's placeholders for names the team knows, and numbers new ones locally without a block (spec 066)", async () => {
    const { home } = await teamScenario(fetchMock, {
      maps: mapsFor({ namespace: TEAM, aliases: {}, conflicts: {} }),
    })
    const r = await scrub(CODE, home)
    expect(r.code).toBe(EXIT_OK)
    expect(r.out).toMatch(
      new RegExp(
        `^export class __CLS__2 \\{ __FN__3\\(\\) \\{\\} ${LOCAL}FN__1\\(\\) \\{\\} \\}\\n$`
      )
    )
    expect(r.err).toMatch(/Namespace: team/)
  })

  it('never hands a new name a number this project and the team use for different names', async () => {
    // __FN__4 is localOnlyName in this project and teamOnlyName in the team: the
    // overlay uses it for neither, and the next new name must not be given it.
    const maps = mapsFor({
      namespace: { ...TEAM, __FN__4: 'teamOnlyName' },
      aliases: {},
      conflicts: {},
    })
    const { home } = await teamScenario(fetchMock, { maps })
    const r = await scrub(CODE, home, ['scrub'], { __FN__4: 'localOnlyName' })
    expect(r.out).toMatch(
      new RegExp(
        `^export class __CLS__2 \\{ __FN__3\\(\\) \\{\\} ${LOCAL}FN__1\\(\\) \\{\\} \\}\\n$`
      )
    )
    expect(r.out).not.toContain('__FN__4')
  })

  it("never emits a placeholder the team's maps dispute: the name gets a fresh number", async () => {
    // Code review: the engine's namespace keeps a disputed placeholder's first
    // meaning (for numbering); scrub emitted it, the MCP never does.
    const maps = mapsFor({
      namespace: { ...TEAM, __CLS__5: 'Foo' },
      aliases: {},
      conflicts: { __CLS__5: 2 },
    })
    const { home } = await teamScenario(fetchMock, { maps })
    const r = await scrub('export class Foo {}\n', home)
    expect(r.out).toMatch(new RegExp(`^export class ${LOCAL}CLS__1 \\{\\}\\n$`))
    expect(Object.keys(r.map)).not.toContain('__CLS__5')
  })

  it('keeps in the project map only the team entries the output used', async () => {
    const big = { ...TEAM, __FN__9: 'unrelatedTeamName' }
    const { home } = await teamScenario(fetchMock, {
      maps: mapsFor({ namespace: big, aliases: {}, conflicts: {} }),
    })
    const r = await scrub(CODE, home)
    const { __CLS__2, __FN__3, ...minted } = r.map
    expect({ __CLS__2, __FN__3 }).toEqual({ __CLS__2: 'LedgerService', __FN__3: 'settleInvoice' })
    expect(Object.entries(minted)).toEqual([
      [expect.stringMatching(new RegExp(`^${LOCAL}FN__1$`)), 'reverseEntry'],
    ])
  })

  it('the team key is locked: new names numbered locally, and it says why - even under --quiet', async () => {
    const { home } = await teamScenario(fetchMock, {
      maps: mapsFor({ namespace: TEAM, aliases: {}, conflicts: {} }),
      locked: true,
    })
    const r = await scrub(CODE, home, ['scrub', '--quiet'])
    expect(r.code).toBe(EXIT_OK)
    // Spec 066 FR-001: still a team, so new names take the local family.
    expect(r.out).toMatch(LOCAL_ONLY)
    expect(r.err).toMatch(/team key is locked[\s\S]*veilio team unlock/)
  })

  it('Cloud cannot be read: new names numbered locally, with the reason', async () => {
    const { home } = await teamScenario(fetchMock, {
      maps: mapsFor({ namespace: TEAM, aliases: {}, conflicts: {} }),
      failures: 5,
      failStatus: 503,
    })
    const r = await scrub(CODE, home)
    expect(r.out).toMatch(LOCAL_ONLY)
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
    expect(r.out).toMatch(LOCAL_ONLY)
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

// Security review of 8adc729: a name the TEAM's maps hold as code is the
// project's too, and scrub never leaves it as written as a third-party name.
describe('veilio scrub, a third-party name the team holds as code', () => {
  it('stays masked', async () => {
    const { home } = await teamScenario(fetchMock, {
      maps: mapsFor({ namespace: { __FN__30: 'tarnwickSuite' }, aliases: {}, conflicts: {} }),
    })
    const { mkdirSync, writeFileSync } = await import('node:fs')
    const cwd = mkdtempSync(join(tmpdir(), 'veilio-scrub-team-held-'))
    mkdirSync(join(cwd, '.git'))
    mkdirSync(join(cwd, 'src'))
    writeFileSync(
      join(cwd, 'src/a.test.ts'),
      "import { tarnwickSuite, expect } from 'vitest'\nexport function settleLedger() {}\n"
    )
    let out = ''
    const io: Io = { cwd, home, stdin: async () => '', stdout: (t) => (out += t), stderr: () => {} }
    expect(await main(['scrub', 'src/a.test.ts'], io)).toBe(EXIT_OK)
    expect(out).not.toMatch(/import \{ tarnwickSuite\b/)
  })
})

// Security review of ec0cb00: the project map and the team's are two sources;
// one placeholder in both must not drop either name.
describe('veilio scrub, the same placeholder in the project map and the team', () => {
  it('keeps both names masked', async () => {
    const { home } = await teamScenario(fetchMock, {
      maps: mapsFor({ namespace: { __FN__30: 'settleLedger' }, aliases: {}, conflicts: {} }),
    })
    const { mkdirSync, writeFileSync } = await import('node:fs')
    const cwd = mkdtempSync(join(tmpdir(), 'veilio-scrub-team-clash-'))
    mkdirSync(join(cwd, '.git'))
    mkdirSync(join(cwd, 'src'))
    saveMap(resolveMapPath(null, cwd), { __FN__30: 'tarnwickSuite' })
    writeFileSync(join(cwd, 'src/a.test.ts'), "import { tarnwickSuite, expect } from 'vitest'\n")
    let out = ''
    const io: Io = { cwd, home, stdin: async () => '', stdout: (t) => (out += t), stderr: () => {} }
    await main(['scrub', 'src/a.test.ts'], io)
    expect(out).not.toMatch(/import \{ tarnwickSuite\b/)
  })
})
