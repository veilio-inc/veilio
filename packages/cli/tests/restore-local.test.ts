import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { localFamilyNote } from '@veilio-inc/engine'
import { main } from '../src/index.js'
import { EXIT_FINDINGS, EXIT_OK, type Io } from '../src/commands.js'
import { STORE_DIR, STORE_FILE, loadMap, saveMap } from '../src/store.js'
import { addAliases } from '../src/reservations.js'
import { FakeCloud, PASSPHRASE, TEAMMATE, sealTeam, signIn } from './helpers/fake-cloud.js'

/**
 * Spec 066 R5 (FR-004): `veilio restore` leaves another checkout's local
 * placeholders as written, counts them as left and names them. Only the
 * checkout that numbered one restores it - from its map, or from aliases.json
 * after a publish renumbered it.
 */

const OTHER = '__LOCAL_ZZ9QQ1_VAR__1'
const MINE = '__LOCAL_K7Q2XA_VAR__1'

let home: string
let cwd: string
let cloud: FakeCloud
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'veilio-rsl-home-'))
  cwd = mkdtempSync(join(tmpdir(), 'veilio-rsl-work-'))
  mkdirSync(join(cwd, '.git'), { recursive: true })
  cloud = new FakeCloud()
  vi.stubGlobal('fetch', cloud.fetch)
  signIn(home, { team: true })
  cloud.add({
    owner: TEAMMATE,
    scope: 'team',
    name: 'shared',
    // A hostile or old client's map holding the other checkout's key: dropped.
    map_data: await sealTeam({ __VAR__1: 'amount', [OTHER]: 'teammateGuess' }),
  })
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

describe('restore and the local family', () => {
  it('another checkout’s local placeholder is left, named, and not called invented', async () => {
    saveMap(mapPath(), { __VAR__1: 'amount' }, { force: true })
    const res = await run(['restore'], `x = ${OTHER} + __VAR__1\n`)
    expect(res.code).toBe(EXIT_OK)
    expect(res.out).toBe(`x = ${OTHER} + amount\n`)
    expect(res.out).not.toContain('teammateGuess')
    expect(res.err).toContain(localFamilyNote([OTHER]))
    expect(res.err).not.toMatch(/invented or altered/)
  })

  it('it counts as left: --strict writes nothing', async () => {
    saveMap(mapPath(), { __VAR__1: 'amount' }, { force: true })
    const res = await run(['restore', '--strict'], `x = ${OTHER}\n`)
    expect(res.code).toBe(EXIT_FINDINGS)
    expect(res.out).toBe('')
    expect(res.err).toMatch(new RegExp(`--strict: nothing written - .*${OTHER}`))
  })

  it('several are named in one line', async () => {
    saveMap(mapPath(), { __VAR__1: 'amount' }, { force: true })
    const two = '__LOCAL_ZZ9QQ1_FN__4'
    const res = await run(['restore'], `${OTHER}(${two}, ${OTHER})\n`)
    expect(res.err).toContain(localFamilyNote([OTHER, two]))
  })

  it('this checkout’s own local placeholder restores', async () => {
    saveMap(mapPath(), { __VAR__1: 'amount', [MINE]: 'holdbackDays' }, { force: true })
    const res = await run(['restore'], `x = ${MINE}\n`)
    expect(res.out).toBe('x = holdbackDays\n')
    expect(res.err).not.toContain('left as is')
  })

  it('and still restores after a publish renumbered it (aliases.json)', async () => {
    saveMap(mapPath(), { __VAR__1: 'amount', __VAR__502: 'holdbackDays' }, { force: true })
    addAliases(mapPath(), { [MINE]: 'holdbackDays' })
    const res = await run(['restore'], `x = ${MINE}\n`)
    expect(res.out).toBe('x = holdbackDays\n')
  })

  it('after leaving the team, the own aliases still restore', async () => {
    cloud.teamId = null
    saveMap(mapPath(), { __VAR__502: 'holdbackDays' }, { force: true })
    addAliases(mapPath(), { [MINE]: 'holdbackDays' })
    const res = await run(['restore'], `x = ${MINE} ${OTHER}\n`)
    expect(res.out).toBe(`x = holdbackDays ${OTHER}\n`)
    expect(res.err).toContain(localFamilyNote([OTHER]))
  })

  it('a pasted local literal is a placeholder: scrub leaves it, restore names it', async () => {
    saveMap(mapPath(), { __VAR__1: 'amount' }, { force: true })
    writeFileSync(join(cwd, 'a.ts'), `export const total = ${OTHER}\n`)
    const scrubbed = await run(['scrub', 'a.ts'])
    expect(scrubbed.out).toContain(OTHER)
    expect(Object.keys(loadMap(mapPath()))).not.toContain(OTHER)
    const res = await run(['restore', '--strict'], scrubbed.out)
    expect(res.code).toBe(EXIT_FINDINGS)
    expect(res.err).toContain(localFamilyNote([OTHER]))
  })
})
