import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { main } from '../src/index.js'
import { EXIT_ERROR, EXIT_OK, type Io } from '../src/commands.js'
import { printable } from '../src/reservations.js'
import { STORE_DIR, STORE_FILE, saveMap } from '../src/store.js'
import { FakeCloud, PASSPHRASE, sealPersonal, sealTeam, signIn } from './helpers/fake-cloud.js'

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
})
