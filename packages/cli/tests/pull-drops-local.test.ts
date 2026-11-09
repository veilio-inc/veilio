import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { main } from '../src/index.js'
import { EXIT_ERROR, EXIT_OK, type Io } from '../src/commands.js'
import { STORE_DIR, STORE_FILE, StoreRefusal, loadMap, saveMap } from '../src/store.js'
import { resolveTeamNamespace } from '../src/team-namespace.js'
import {
  FakeCloud,
  PASSPHRASE,
  TEAMMATE,
  sealPersonal,
  sealTeam,
  signIn,
} from './helpers/fake-cloud.js'

/**
 * Code review of spec 066 (FR-003): every reader drops a local-family key it
 * finds in a team map. `maps pull` wrote them into map.json, where they
 * restored as a teammate's guess and blocked the next publish.
 */

let home: string
let cwd: string
let cloud: FakeCloud
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'veilio-pdl-home-'))
  cwd = mkdtempSync(join(tmpdir(), 'veilio-pdl-work-'))
  mkdirSync(join(cwd, '.git'), { recursive: true })
  cloud = new FakeCloud()
  cloud.recordsReservations = true
  vi.stubGlobal('fetch', cloud.fetch)
  signIn(home, { team: true })
})
afterEach(() => {
  vi.unstubAllGlobals()
  rmSync(home, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
})
const mapPath = () => join(cwd, STORE_DIR, STORE_FILE)
async function run(
  argv: string[],
  stdin = ''
): Promise<{ code: number; out: string; err: string }> {
  let out = ''
  let err = ''
  const io: Io = {
    cwd,
    home,
    stdin: async () => stdin,
    stdinBytes: async function* () {
      yield Buffer.from(stdin)
    },
    stdout: (t) => (out += t),
    stderr: (t) => (err += t),
    prompt: async () => '',
    password: async () => PASSPHRASE,
  }
  return { code: await main(argv, io), out, err }
}
const HOSTILE = {
  __VAR__1: 'amount',
  __LOCAL_ZZ9QQ1_VAR__1: 'teammateGuess',
  __LOCAL_ZZ9QQ1_VAR__: 'digitlessGuess',
}

describe('a team map holding local-family keys', () => {
  it('maps pull leaves them out, says so, restore never uses them, and publish is not blocked', async () => {
    const id = cloud.add({
      owner: TEAMMATE,
      scope: 'team',
      name: 'old-client',
      map_data: await sealTeam(HOSTILE),
    }).id
    const pulled = await run(['maps', 'pull', id])
    expect(pulled.code, pulled.err).toBe(EXIT_OK)
    expect(loadMap(mapPath())).toEqual({ __VAR__1: 'amount' })
    expect(pulled.out).toMatch(/left out 2 placeholders numbered on one machine/i)

    const restored = await run(['restore'], 'x = __LOCAL_ZZ9QQ1_VAR__1 + __LOCAL_ZZ9QQ1_VAR__\n')
    expect(restored.out).not.toMatch(/teammateGuess|digitlessGuess/)

    const pushed = await run(['maps', 'push', '--team', 'mine'])
    expect(pushed.code, pushed.err).toBe(EXIT_OK)
  })

  it('a personal map keeps its local entries on pull: it is the member’s own', async () => {
    signIn(home, { team: true, pmk: true })
    const id = cloud.add({ name: 'mine', map_data: await sealPersonal(HOSTILE, 'pmk') }).id
    const pulled = await run(['maps', 'pull', id])
    expect(pulled.code, pulled.err).toBe(EXIT_OK)
    expect(loadMap(mapPath())).toEqual(HOSTILE)
    expect(pulled.out).not.toMatch(/left out/i)
  })

  it('an older instance’s server-merged namespace is not read at all (spec 085 R2-4)', async () => {
    cloud.legacyNamespace = { ...HOSTILE }
    const found = await resolveTeamNamespace(home)
    expect(found.status === 'team' ? found.analysis.namespace : {}).toEqual({})
  })
})

// Review round 1 (#3): the store reads only names (isName), so it must never
// write anything else: the next read would refuse the whole map.
describe('a value that is not a name is never written to the store', () => {
  const BAD = ['PaymentGateway', 'injectedCall()'].join('\n')
  it('maps pull of a map holding one is refused, and no map is written', async () => {
    const id = cloud.add({
      owner: TEAMMATE,
      scope: 'team',
      name: 'odd-values',
      map_data: await sealTeam({ __VAR__1: 'amount', __CLS__1: BAD }),
    }).id
    const pulled = await run(['maps', 'pull', id])
    // Spec 085 R2-6: refused when the team map is opened, before the store.
    expect(pulled.code).toBe(EXIT_ERROR)
    expect(pulled.err).toContain(
      '"__CLS__1" maps to a value with a control character or line break'
    )
    expect(existsSync(mapPath())).toBe(false)
  })

  it('saveMap and addAliases refuse one before writing', async () => {
    const { addAliases } = await import('../src/reservations.js')
    expect(() => saveMap(mapPath(), { __CLS__1: BAD })).toThrow(StoreRefusal)
    expect(existsSync(mapPath())).toBe(false)
    expect(() => addAliases(mapPath(), { __CLS__1: BAD })).toThrow(StoreRefusal)
    expect(existsSync(join(cwd, STORE_DIR, 'aliases.json'))).toBe(false)
  })
})
