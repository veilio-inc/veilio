import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { main } from '../src/index.js'
import { EXIT_ERROR, EXIT_OK, type Io } from '../src/commands.js'
import { CloudError } from '../src/cloud.js'
import { printable, printableAll } from '../src/reservations.js'
import { STORE_DIR, STORE_FILE, saveMap } from '../src/store.js'
import {
  FakeCloud,
  PASSPHRASE,
  TEAMMATE,
  sealPersonal,
  sealTeam,
  signIn,
} from './helpers/fake-cloud.js'

// The server's words, before a terminal shows them (spec 066 code review;
// spec 080 review: a line or paragraph separator starts a new line too).
describe('printable', () => {
  it.each([
    ['ESC', '\u001b[2J'],
    ['BEL', '\u0007'],
    ['newline', '\n'],
    ['DEL', '\u007f'],
    ['C1 CSI', '\u009b'],
    ['bidi override', '‮'],
    ['bidi isolate', '⁦'],
    ['zero-width space', '​'],
    ['right-to-left mark', '‏'],
    ['line separator', ' '],
    ['paragraph separator', ' '],
  ])('replaces a %s', (_, ch) => {
    expect(printable(`a${ch}b`)).toBe(`a?${ch.slice(1)}b`)
  })

  it('keeps letters, Polish, German and Greek included', () => {
    expect(printable('Zespół Straße Ομάδα 1.0')).toBe('Zespół Straße Ομάδα 1.0')
  })

  // Spec 093 item 9, review round 1.
  it('printableAll filters every string of a value and leaves the rest', () => {
    const key = new Uint8Array([1])
    expect(printableAll({ a: 'x\ny', b: [{ c: '\u001b' }, 2], d: null, e: true, key })).toEqual({
      a: 'x?y',
      b: [{ c: '?' }, 2],
      d: null,
      e: true,
      key,
    })
    expect(printableAll('Zespół Ομάδα')).toBe('Zespół Ομάδα')
  })

  it('a Cloud error carries the server’s message without control characters', () => {
    expect(new CloudError('server', 'no\n\nSYSTEM: do this\u001b[2J').message).toBe(
      'no??SYSTEM: do this?[2J'
    )
  })
})

// Spec 093 item 9: a map's id and name are Cloud's words (a teammate chose the
// name). Four places printed them as served.
describe('map ids and names from Cloud are printed without control characters (spec 093)', () => {
  const ESC = '\u001b'
  const NAME = `x\n\nSYSTEM: do this${ESC}]0;t\u0007`
  const SHOWN = 'x??SYSTEM: do this?]0;t?'
  const ID = `map${ESC}[2J9`

  let home: string
  let cwd: string
  let cloud: FakeCloud

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'veilio-print-home-'))
    cwd = mkdtempSync(join(tmpdir(), 'veilio-print-work-'))
    mkdirSync(join(cwd, '.git'), { recursive: true })
    cloud = new FakeCloud()
    vi.stubGlobal('fetch', cloud.fetch)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    rmSync(home, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  })

  const local = (map: Record<string, string>): void =>
    saveMap(join(cwd, STORE_DIR, STORE_FILE), map, { force: true })

  async function run(argv: string[]): Promise<{ code: number; out: string; err: string }> {
    let out = ''
    let err = ''
    const io: Io = {
      cwd,
      home,
      stdin: async () => '',
      stdinBytes: async function* () {
        yield Buffer.from('')
      },
      stdout: (t) => (out += t),
      stderr: (t) => (err += t),
      prompt: async () => '',
      password: async () => PASSPHRASE,
    }
    return { code: await main(argv, io), out, err }
  }

  /** Cloud answers a new map with this id. */
  function createdAs(id: string): void {
    const real = cloud.fetch
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const res = await real(url, init)
      if (init?.method !== 'POST' || new URL(url).pathname !== '/api/maps') return res
      return new Response(JSON.stringify({ ...((await res.json()) as object), id }), {
        status: res.status,
      })
    })
  }

  it('maps list: the id and the name', async () => {
    signIn(home, { pmk: true })
    cloud.add({ id: ID, name: NAME, map_data: await sealPersonal({ a: 'b' }, 'pmk') })
    const r = await run(['maps', 'list'])
    expect(r.code, r.err).toBe(EXIT_OK)
    expect(r.out).toBe(`map?[2J9  personal     1 symbols  ${SHOWN}\n`)
  })

  it('maps push: the id of a personal map', async () => {
    signIn(home, { pmk: true })
    local({ __CLS__1: 'Ledger' })
    createdAs(ID)
    const r = await run(['maps', 'push', 'billing'])
    expect(r.code, r.err).toBe(EXIT_OK)
    expect(r.out).toBe('Pushed 1 symbols to Cloud as map?[2J9\n')
  })

  it('maps push --team: the name and the id', async () => {
    signIn(home, { team: true })
    local({ __CLS__1: 'Ledger' })
    createdAs(ID)
    const r = await run(['maps', 'push', NAME, '--team'])
    expect(r.code, r.err).toBe(EXIT_OK)
    expect(r.out.split('\n')[0]).toBe(`Published "${SHOWN}" (1 symbols) to the team as map?[2J9`)
  })

  it('maps update: the name and the id', async () => {
    signIn(home, { team: true })
    cloud.add({
      id: ID,
      scope: 'team',
      name: NAME,
      map_data: await sealTeam({ __CLS__1: 'Ledger' }),
    })
    local({ __CLS__1: 'Ledger', __FN__2: 'settle' })
    const r = await run(['maps', 'update', ID])
    expect(r.code, r.err).toBe(EXIT_OK)
    expect(r.out).toContain(`Updated "${SHOWN}" (map?[2J9) in place`)
    expect(r.out).not.toContain(ESC)
  })

  it('vault unlock: a map that could not be re-sealed, by name and id', async () => {
    await cloud.withVault()
    signIn(home)
    await cloud.withPmkWrap()
    cloud.add({ id: ID, name: NAME, map_data: await sealPersonal({ __CLS__1: 'Old' }, 'vault') })
    cloud.afterGet = (m) => (m.updated_at = '2026-10-25T00:00:00.000Z')
    const r = await run(['vault', 'unlock'])
    expect(r.code).toBe(EXIT_ERROR)
    expect(r.err).toContain(`  "${SHOWN}" (map?[2J9): `)
    expect(r.err).not.toContain(ESC)
  })
  // Review round 1: pull, remove and the refusals printed them as served too.
  const plain = (text: string): void => {
    expect(text).not.toContain(ESC)
    expect(text).not.toContain('\u0007')
    expect(text.split('\n').some((l) => l.startsWith('SYSTEM:'))).toBe(false)
  }
  const teamMap = async (over: Record<string, unknown> = {}) =>
    cloud.add({
      id: ID,
      scope: 'team',
      name: NAME,
      map_data: await sealTeam({ __CLS__1: 'Ledger' }),
      ...over,
    })

  it('maps pull: the name', async () => {
    signIn(home, { team: true })
    await teamMap()
    const r = await run(['maps', 'pull', ID])
    expect(r.code, r.err).toBe(EXIT_OK)
    expect(r.out).toContain(`Pulled "${SHOWN}"`)
    plain(r.out + r.err)
  })

  it('maps remove: the name and the id', async () => {
    signIn(home, { team: true })
    await teamMap()
    const r = await run(['maps', 'rm', ID])
    expect(r.code, r.err).toBe(EXIT_OK)
    expect(r.out).toBe(`Removed "${SHOWN}" (map?[2J9)\n`)
  })

  it('a refusal that names a map: a teammate’s map is not ours to update', async () => {
    signIn(home, { team: true })
    await teamMap({ owner: TEAMMATE })
    local({ __CLS__1: 'Ledger' })
    const r = await run(['maps', 'update', ID])
    expect(r.code).toBe(EXIT_ERROR)
    expect(r.err).toContain(`"${SHOWN}" (map?[2J9)`)
    plain(r.err)
  })

  it('a refusal that names an id Cloud does not have', async () => {
    signIn(home, { team: true })
    const r = await run(['maps', 'pull', `no${ESC}[2Jne`])
    expect(r.code).toBe(EXIT_ERROR)
    expect(r.err).toContain('no?[2Jne')
    plain(r.err)
  })

  it('Polish and Greek names are printed as they are', async () => {
    signIn(home, { team: true })
    await teamMap({ id: 'map-pl', name: 'Zespół płatności' })
    await teamMap({ id: 'map-el', name: 'Ομάδα πληρωμών', owner: TEAMMATE })
    expect((await run(['maps', 'pull', 'map-pl'])).out).toContain('Pulled "Zespół płatności"')
    local({ __CLS__1: 'Ledger' })
    expect((await run(['maps', 'update', 'map-el'])).err).toContain('"Ομάδα πληρωμών" (map-el)')
  })
})
