import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { main } from '../src/index.js'
import { EXIT_OK, type Io } from '../src/commands.js'
import { STORE_DIR, STORE_FILE, saveMap } from '../src/store.js'
import { addAliases } from '../src/reservations.js'
import { FakeCloud, PASSPHRASE, TEAMMATE, sealTeam, signIn } from './helpers/fake-cloud.js'

/**
 * Spec 063 US2: restore never puts a wrong name in silently. A placeholder a
 * team map gives a name, whose number another member reserved, was not
 * numbered by that map's publisher - an old client's, or a clash from before
 * blocks - so it is left in place and named, not guessed. In spec 061, 931 of
 * 1354 placeholders came back as another real name this way.
 */

let home: string
let cwd: string
let cloud: FakeCloud
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'veilio-attr-home-'))
  cwd = mkdtempSync(join(tmpdir(), 'veilio-attr-work-'))
  mkdirSync(join(cwd, '.git'), { recursive: true })
  cloud = new FakeCloud()
  cloud.recordsReservations = true
  vi.stubGlobal('fetch', cloud.fetch)
  signIn(home, { team: true })
  // This project has a map of its own, as a working member's does.
  saveMap(join(cwd, STORE_DIR, STORE_FILE), { __VAR__1: 'amount' }, { force: true })
})
afterEach(() => {
  vi.unstubAllGlobals()
  rmSync(home, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
})

async function restore(text: string): Promise<{ code: number; out: string; err: string }> {
  let out = ''
  let err = ''
  const io: Io = {
    cwd,
    home,
    stdin: async () => text,
    stdout: (t) => (out += t),
    stderr: (t) => (err += t),
    prompt: async () => '',
    password: async () => PASSPHRASE,
  }
  return { code: await main(['restore'], io), out, err }
}
const teammateMap = async (map: Record<string, string>) =>
  cloud.add({ owner: TEAMMATE, scope: 'team', name: 'theirs', map_data: await sealTeam(map) })

describe('a number is restored only from a map its reserver published', () => {
  it('the reserver published it: restored', async () => {
    cloud.reservations.push({ base: '__FN__', start: 1, end: 500, member: 'u-ada' })
    await teammateMap({ __FN__12: 'refund' })
    const r = await restore('call __FN__12()\n')
    expect(r.code, r.err).toBe(EXIT_OK)
    expect(r.out).toBe('call refund()\n')
  })

  it('another member reserved it: left in place and named, never a guess', async () => {
    cloud.reservations.push({ base: '__FN__', start: 1, end: 500, member: 'u-bob' })
    await teammateMap({ __FN__12: 'refund' })
    const r = await restore('call __FN__12()\n')
    expect(r.out).toBe('call __FN__12()\n')
    expect(r.err).toMatch(/__FN__12/)
    expect(r.err).toMatch(/reserved by another member/i)
  })

  it('a number in no reservation (a map from before spec 063): restored as before', async () => {
    await teammateMap({ __FN__12: 'refund' })
    const r = await restore('call __FN__12()\n')
    expect(r.out).toBe('call refund()\n')
  })

  it('an instance that keeps no record: restored as before', async () => {
    cloud.recordsReservations = false
    cloud.reservations.push({ base: '__FN__', start: 1, end: 500, member: 'u-bob' })
    await teammateMap({ __FN__12: 'refund' })
    const r = await restore('call __FN__12()\n')
    expect(r.out).toBe('call refund()\n')
  })

  it('a teammate’s placeholder the team’s maps do not hold yet is left in place and named', async () => {
    cloud.reservations.push({ base: '__FN__', start: 501, end: 1000, member: 'u-ada' })
    await teammateMap({ __FN__12: 'refund' })
    const r = await restore('call __FN__600()\n')
    expect(r.out).toBe('call __FN__600()\n')
    expect(r.err).toMatch(/__FN__600/)
  })
})

describe('this member’s own renumbered placeholders', () => {
  it('still restore on this machine from aliases.json', async () => {
    addAliases(join(cwd, STORE_DIR, STORE_FILE), { __FN__3: 'chargeCard' })
    const r = await restore('call __FN__3()\n')
    expect(r.out).toBe('call chargeCard()\n')
  })
  it('an alias the map now gives another name is left and named, never restored either way', async () => {
    addAliases(join(cwd, STORE_DIR, STORE_FILE), { __FN__3: 'chargeCard' })
    saveMap(
      join(cwd, STORE_DIR, STORE_FILE),
      { __VAR__1: 'amount', __FN__3: 'refund' },
      { force: true }
    )
    const r = await restore('call __FN__3()\n')
    expect(r.out).toBe('call __FN__3()\n')
    expect(r.err).toMatch(/__FN__3/)
  })
  it('a contested alias is left even when a team map names that placeholder (security review)', async () => {
    await teammateMap({ __FN__3: 'teamsMeaning' })
    addAliases(join(cwd, STORE_DIR, STORE_FILE), { __FN__3: 'chargeCard' })
    saveMap(
      join(cwd, STORE_DIR, STORE_FILE),
      { __VAR__1: 'amount', __FN__3: 'refund' },
      { force: true }
    )
    const r = await restore('call __FN__3()\n')
    expect(r.out).toBe('call __FN__3()\n')
  })
})
