import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { decryptTeamMap, importTeamKey, toBase64, type TeamMapEnvelope } from '@veilio-inc/engine'
import { main } from '../src/index.js'
import { EXIT_ERROR, EXIT_OK, type Io } from '../src/commands.js'
import { STORE_DIR, STORE_FILE, loadMap, saveMap } from '../src/store.js'
import { addAliases, loadAliases } from '../src/reservations.js'
import {
  FakeCloud,
  PASSPHRASE,
  TEAMMATE,
  TEAM_RAW,
  sealTeam,
  signIn,
} from './helpers/fake-cloud.js'

/**
 * Spec 063 FR-003 (US1): a team publish carries only numbers its publisher
 * reserved. A new entry numbered outside them - by a guard with no block, or
 * before this feature - is renumbered from a fresh reservation before
 * anything is sealed, and its old placeholder is kept locally, so the
 * publisher's own restore still reads text masked before. In spec 061 the
 * same entries were refused as clashes 93 times out of 128, for good.
 */

let home: string
let cwd: string
let cloud: FakeCloud
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'veilio-pub-home-'))
  cwd = mkdtempSync(join(tmpdir(), 'veilio-pub-work-'))
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

const mapPath = (): string => join(cwd, STORE_DIR, STORE_FILE)
async function run(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = ''
  let err = ''
  const io: Io = {
    cwd,
    home,
    stdin: async () => '',
    stdout: (t) => (out += t),
    stderr: (t) => (err += t),
    prompt: async () => '',
    password: async () => PASSPHRASE,
  }
  return { code: await main(argv, io), out, err }
}
async function published(id: string): Promise<Record<string, string>> {
  const m = cloud.find(id)!
  return decryptTeamMap(
    await importTeamKey(toBase64(TEAM_RAW)),
    JSON.parse(m.map_data) as TeamMapEnvelope
  )
}
const teammateMap = async (map: Record<string, string>) =>
  cloud.add({ owner: TEAMMATE, scope: 'team', name: 'theirs', map_data: await sealTeam(map) })
const pushedId = (out: string) => /as (\S+)/.exec(out)?.[1] ?? ''

describe('a team publish carries only the publisher’s reserved numbers', () => {
  it('entries inside the publisher’s reservations go up as they are', async () => {
    cloud.reservations.push({ base: '__FN__', start: 5001, end: 5500, member: 'u-me' })
    saveMap(mapPath(), { __FN__5001: 'chargeCard' }, { force: true })
    const res = await run(['maps', 'push', '--team', 'mine'])
    expect(res.code, res.err).toBe(EXIT_OK)
    expect(await published(pushedId(res.out))).toEqual({ __FN__5001: 'chargeCard' })
    expect(loadAliases(mapPath())).toEqual({})
  })

  it('a clash on an unreserved number is renumbered, not refused (spec 061 F2)', async () => {
    await teammateMap({ __FN__41: 'refund' })
    saveMap(mapPath(), { __FN__41: 'payout' }, { force: true })
    const res = await run(['maps', 'push', '--team', 'mine'])
    expect(res.code, res.err).toBe(EXIT_OK)
    const up = await published(pushedId(res.out))
    const [placeholder] = Object.keys(up)
    expect(up[placeholder]).toBe('payout')
    expect(Number(placeholder.replace('__FN__', ''))).toBeGreaterThan(41)
    // Reserved for this member, and recorded as theirs.
    expect(
      cloud.reservations.some((r) => r.member === 'u-me' && r.start <= Number(placeholder.slice(6)))
    ).toBe(true)
    // The local map now holds the new number; the old one stays readable here.
    expect(loadMap(mapPath())).toEqual({ [placeholder]: 'payout' })
    expect(loadAliases(mapPath())).toEqual({ __FN__41: 'payout' })
    expect(res.out + res.err).toMatch(/renumbered 1/i)
  })

  it('a name the team already holds gets a fresh number above the map, so no retired number is reachable again (review)', async () => {
    await teammateMap({ __FN__7: 'chargeCard' })
    saveMap(mapPath(), { __FN__90: 'chargeCard' }, { force: true })
    const res = await run(['maps', 'push', '--team', 'mine'])
    expect(res.code, res.err).toBe(EXIT_OK)
    const after = loadMap(mapPath())
    const [placeholder] = Object.keys(after)
    expect(after[placeholder]).toBe('chargeCard')
    // Above the retired __FN__90: local numbering, which counts up from the
    // map's highest, can never mint __FN__90 again for another name.
    expect(Number(placeholder.replace('__FN__', ''))).toBeGreaterThan(90)
    expect(loadAliases(mapPath())).toEqual({ __FN__90: 'chargeCard' })
  })

  it('an old placeholder already retired with another meaning is refused by name, not thrown', async () => {
    await teammateMap({ __FN__41: 'refund' })
    addAliases(mapPath(), { __FN__41: 'payout' })
    saveMap(mapPath(), { __FN__41: 'foo' }, { force: true })
    const res = await run(['maps', 'push', '--team', 'mine'])
    expect(res.code).toBe(EXIT_ERROR)
    expect(res.err).toMatch(/__FN__41/)
    expect(res.err).not.toMatch(/at .*\.js:\d+/)
    expect(loadMap(mapPath())).toEqual({ __FN__41: 'foo' })
  })

  it('a number another member reserved is never published by this one', async () => {
    cloud.reservations.push({ base: '__FN__', start: 1, end: 500, member: 'u-ada' })
    saveMap(mapPath(), { __FN__12: 'chargeCard' }, { force: true })
    const res = await run(['maps', 'push', '--team', 'mine'])
    expect(res.code, res.err).toBe(EXIT_OK)
    const up = await published(pushedId(res.out))
    expect(Object.keys(up)).not.toContain('__FN__12')
  })

  it('when no numbers can be reserved, nothing is uploaded and the entries are named', async () => {
    await teammateMap({ __FN__41: 'refund' })
    saveMap(mapPath(), { __FN__41: 'payout' }, { force: true })
    cloud.limited.add('/api/teams/team-1/placeholders/reserve')
    const mapWrites = () => cloud.writes().filter((w) => w.path.startsWith('/api/maps')).length
    const writesBefore = mapWrites()
    const res = await run(['maps', 'push', '--team', 'mine'])
    expect(res.code).toBe(EXIT_ERROR)
    expect(res.err).toMatch(/__FN__41/)
    expect(res.err).toMatch(/reserve/i)
    expect(mapWrites()).toBe(writesBefore)
    expect(loadMap(mapPath())).toEqual({ __FN__41: 'payout' })
  })

  it('maps update renumbers the same way', async () => {
    cloud.reservations.push({ base: '__FN__', start: 5001, end: 5500, member: 'u-me' })
    saveMap(mapPath(), { __FN__5001: 'chargeCard' }, { force: true })
    const first = await run(['maps', 'push', '--team', 'mine'])
    const id = pushedId(first.out)
    await teammateMap({ __FN__6000: 'refund' })
    saveMap(mapPath(), { __FN__5001: 'chargeCard', __FN__6000: 'payout' }, { force: true })
    const res = await run(['maps', 'update', id])
    expect(res.code, res.err).toBe(EXIT_OK)
    const up = await published(id)
    expect(up.__FN__5001).toBe('chargeCard')
    expect(up.__FN__6000).toBeUndefined()
    expect(Object.values(up)).toContain('payout')
  })
})

describe('an instance without the reservations record', () => {
  it('publishes as before (the clash check still refuses a real clash)', async () => {
    cloud.recordsReservations = false
    const real = cloud.fetch
    vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) =>
      String(url).includes('/placeholders/reservations')
        ? new Response(JSON.stringify({ error: 'Not found' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          })
        : real(url, init)
    )
    await teammateMap({ __FN__41: 'refund' })
    saveMap(mapPath(), { __FN__41: 'payout' }, { force: true })
    const res = await run(['maps', 'push', '--team', 'mine'])
    expect(res.code).toBe(EXIT_ERROR)
    expect(res.err).toMatch(/something else to the team/)
  })
})

describe('renumbering never overwrites a meaning (security review, 2026-10-30)', () => {
  beforeEach(() => {
    cloud.recordsReservations = true
  })

  it('the team’s placeholder for a name is not taken when this map uses it for another name', async () => {
    await teammateMap({ __FN__7: 'chargeCard' })
    cloud.reservations.push({ base: '__FN__', start: 7, end: 7, member: 'u-me' })
    // This member's own __FN__7 (reserved by them) means something else here;
    // a move of chargeCard onto it would silently overwrite it.
    saveMap(mapPath(), { __FN__7: 'refund', __FN__90: 'chargeCard' }, { force: true })
    const res = await run(['maps', 'push', '--team', 'mine'])
    // __FN__7 is this member's and the teammate's map claims it too: a real
    // clash, refused - and nothing local moved, whichever check said so.
    expect(res.code).toBe(EXIT_ERROR)
    expect(res.err).toMatch(/__FN__7/)
    expect(loadMap(mapPath())).toEqual({ __FN__7: 'refund', __FN__90: 'chargeCard' })
    expect(loadAliases(mapPath())).toEqual({})
  })

  it.each([
    [
      'a run for another kind',
      (floor: number) => ({ ranges: [{ base: '__VAR__', start: floor + 1, end: floor + 1 }] }),
    ],
    ['a run at or below the floor', () => ({ ranges: [{ base: '__FN__', start: 3, end: 3 }] })],
    [
      'a run shorter than asked',
      (floor: number) => ({ ranges: [{ base: '__FN__', start: floor + 1, end: floor }] }),
    ],
    [
      'numbers that are not whole',
      (floor: number) => ({ ranges: [{ base: '__FN__', start: floor + 0.5, end: floor + 1 }] }),
    ],
  ])(
    'a reservation answer with %s is refused: nothing uploaded, the map untouched',
    async (_why, answer) => {
      await teammateMap({ __FN__41: 'refund' })
      saveMap(mapPath(), { __FN__41: 'payout' }, { force: true })
      const real = cloud.fetch
      vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) =>
        String(url).endsWith('/placeholders/reserve')
          ? new Response(JSON.stringify(answer(41)), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            })
          : real(url, init)
      )
      const res = await run(['maps', 'push', '--team', 'mine'])
      expect(res.code).toBe(EXIT_ERROR)
      expect(res.err).toMatch(/__FN__41/)
      expect(loadMap(mapPath())).toEqual({ __FN__41: 'payout' })
      expect(loadAliases(mapPath())).toEqual({})
      expect(cloud.writes().filter((w) => w.path.startsWith('/api/maps'))).toHaveLength(0)
    }
  )
})

describe('a personal map keeps every meaning its owner used (journey j052, 2026-10-30)', () => {
  beforeEach(() => {
    cloud.recordsReservations = true
  })

  it('after a team publish renumbers, a personal update is not a drop, and the old placeholder stays in it', async () => {
    cloud.vault = null
    signIn(home, { team: true, pmk: true })
    saveMap(mapPath(), { __FN__41: 'payout' }, { force: true })
    const personal = await run(['maps', 'push', 'mine-personal'])
    expect(personal.code, personal.err).toBe(EXIT_OK)
    const personalId = /as (\S+)/.exec(personal.out)?.[1] ?? ''
    await teammateMap({ __FN__41: 'refund' })
    const team = await run(['maps', 'push', '--team', 'mine'])
    expect(team.code, team.err).toBe(EXIT_OK)
    expect(loadAliases(mapPath())).toEqual({ __FN__41: 'payout' })
    const update = await run(['maps', 'update', personalId])
    expect(update.code, update.err).toBe(EXIT_OK)
  })
})
