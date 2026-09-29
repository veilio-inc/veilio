import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { analyzeTeamNamespace } from '@veilio-inc/engine'
import { main } from '../src/index.js'
import { EXIT_ERROR, type Io } from '../src/commands.js'
import { saveMap, resolveMapPath } from '../src/store.js'
import { RESTORE_CASES } from '../../engine/tests/fixtures/restore-cases.js'
import { mapsFor, teamScenario } from './helpers/team-scenario.js'

/**
 * `veilio restore` follows the one restore rule (spec 028): the team's maps,
 * then this project's map on top; a disputed placeholder is left and named.
 * Until now it read the project map only, so a teammate's placeholders came
 * back unrestored.
 */
let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

async function run(
  stdin: string,
  own: Record<string, string>,
  home?: string,
  argv: string[] = ['restore']
) {
  const cwd = mkdtempSync(join(tmpdir(), 'veilio-restore-'))
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
  return { code, out, err }
}

describe('the shared restore cases, through `veilio restore`', () => {
  it.each(RESTORE_CASES)('$name', async (c) => {
    let home: string | undefined
    if (c.team) {
      const maps = mapsFor(c.team)
      const a = analyzeTeamNamespace(maps)
      // The fixture's team layer is what these maps really analyze to.
      expect({ namespace: a.namespace, aliases: a.aliases, conflicts: a.conflicts }).toEqual(c.team)
      home = (await teamScenario(fetchMock, { maps })).home
    }
    const r = await run(c.text, c.own, home)
    expect(r.out).toBe(c.restored)
    for (const p of c.disputed)
      expect(r.err).toMatch(new RegExp(`left as is: ${p}[\\s\\S]*different identifiers`))
    for (const p of c.locallyNumbered ?? [])
      expect(r.err).toMatch(new RegExp(`left as is: ${p}[\\s\\S]*numbered it locally`))
    if (c.disputed.length === 0 && (c.locallyNumbered ?? []).length === 0)
      expect(r.err).not.toMatch(/left as is/)
    // Neither kind is also called invented by the AI.
    expect(r.err).not.toMatch(/invented or altered/)
    expect(r.code).toBe(0)
  })
})

describe('when the team layer is needed but not there', () => {
  const maps = mapsFor({ namespace: { __FN__1: 'settleLedger' }, aliases: {}, conflicts: {} })

  it('a locked team key: says to run `veilio team unlock`, even with --quiet, and claims nothing', async () => {
    const { home } = await teamScenario(fetchMock, { maps, locked: true })
    const r = await run('x.__FN__1()', {}, home, ['restore', '--quiet'])
    expect(r.out).toBe('x.__FN__1()')
    expect(r.err).toMatch(/__FN__1[\s\S]*team key is locked[\s\S]*veilio team unlock/)
    expect(r.code).toBe(0)
  })

  it('the team maps cannot be read (server): the reason is given, after one retry', async () => {
    const { home, calls } = await teamScenario(fetchMock, { maps, failures: 5, failStatus: 503 })
    const r = await run('x.__FN__1()', {}, home)
    expect(calls.filter((p) => p === '/api/maps')).toHaveLength(2)
    expect(r.err).toMatch(/could not read the team's maps/)
    expect(r.out).toBe('x.__FN__1()')
  })

  it('a transient server failure is retried once and then succeeds', async () => {
    const { home } = await teamScenario(fetchMock, { maps, failures: 1, failStatus: 503 })
    const r = await run('x.__FN__1()', {}, home)
    expect(r.out).toBe('x.settleLedger()')
  })

  it.each([402, 401])(
    'a %s on the listing is no team, not a team failure: no retry, and the invented-token finding stays',
    async (status) => {
      const { home, calls } = await teamScenario(fetchMock, {
        maps,
        failures: 5,
        failStatus: status,
      })
      const r = await run('x.__FN__9()', { __VAR__1: 'amount' }, home)
      expect(calls.filter((p) => p === '/api/maps')).toHaveLength(1)
      expect(r.err).not.toMatch(/could not read the team's maps/)
      expect(r.err).toMatch(/__FN__9[\s\S]*invented or altered/)
    }
  )

  it('signed in but in no team: the project map, and the usual finding', async () => {
    const { home } = await teamScenario(fetchMock, { maps, noTeam: true })
    const r = await run('x.__FN__9()', { __VAR__1: 'amount' }, home)
    expect(r.err).not.toMatch(/team/)
    expect(r.err).toMatch(/invented or altered/)
  })

  it('an instance without conflict detection is not used for restore', async () => {
    const { home } = await teamScenario(fetchMock, { maps, legacy: true })
    const r = await run('x.__FN__1()', {}, home)
    expect(r.out).toBe('x.__FN__1()')
    expect(r.err).toMatch(/predates conflict detection/)
  })

  it('a hanging instance: gives up after 5 seconds, says so, and still writes the text', async () => {
    const { home } = await teamScenario(fetchMock, { maps, hang: true })
    const started = Date.now()
    const r = await run('x.__FN__1()', {}, home)
    expect(Date.now() - started).toBeLessThan(7000)
    expect(r.err).toMatch(/did not wait for Cloud/)
    expect(r.out).toBe('x.__FN__1()')
  }, 10000)

  it('the report counts this project map and what the team restored - not the whole team layer', async () => {
    const big = mapsFor({
      namespace: Object.fromEntries(
        Array.from({ length: 40 }, (_, i) => [`__FN__${i + 1}`, `fn${i + 1}`])
      ),
      aliases: {},
      conflicts: {},
    })
    const { home } = await teamScenario(fetchMock, { maps: big })
    const r = await run('__FN__3(__VAR__1)', { __VAR__1: 'amount' }, home)
    expect(r.out).toBe('fn3(amount)')
    expect(r.err).toMatch(/restored 2 of 2 placeholders/)
    expect(r.err).not.toMatch(/did not appear in the input/)
  })

  it('asks the team even when this project map explains every token - it may explain one wrongly', async () => {
    const { home } = await teamScenario(fetchMock, {
      maps: mapsFor({ namespace: { __CLS__1: 'Bar' }, aliases: {}, conflicts: {} }),
    })
    const r = await run('new __CLS__1()', { __CLS__1: 'Foo' }, home)
    expect(r.out).toBe('new __CLS__1()')
    expect(r.err).toMatch(/left as is: __CLS__1[\s\S]*numbered it locally/)
  })

  it('signed out: fully offline, whatever the text holds', async () => {
    const r = await run('x.__VAR__1 __FN__9', { __VAR__1: 'amount' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(r.out).toBe('x.amount __FN__9')
  })

  it('signed out, with no project map: refused as before', async () => {
    const r = await run('x.__FN__1()', {})
    expect(r.code).toBe(EXIT_ERROR)
    expect(r.err).toMatch(/no symbol map/)
  })
})
