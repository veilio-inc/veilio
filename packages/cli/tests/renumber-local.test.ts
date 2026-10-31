import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  decryptMapFromVault,
  decryptTeamMap,
  importTeamKey,
  isLocalPlaceholder,
  parseVaultEnvelope,
  toBase64,
  type SymbolMap,
  type TeamMapEnvelope,
} from '@veilio-inc/engine'
import { main } from '../src/index.js'
import { EXIT_ERROR, EXIT_OK, type Io } from '../src/commands.js'
import { STORE_DIR, STORE_FILE, loadMap, saveMap } from '../src/store.js'
import { RESERVED_FILE, loadAliases } from '../src/reservations.js'
import { wireBase } from '../src/hashed-bases.js'
import { createCloudMap, updateCloudMap } from '../src/client/index.js'
import { importPersonalMapsKey } from '../src/client/personal-maps-key.js'
import {
  FakeCloud,
  INSTANCE,
  ME,
  PASSPHRASE,
  PMK_RAW,
  TEAM_ID,
  TEAM_RAW,
  sealPersonal,
  sealTeam,
  signIn,
} from './helpers/fake-cloud.js'

/**
 * Spec 066 R6 (FR-003): a team publish gives every local-family entry a fresh
 * team number, keeps the old placeholder in aliases.json, and never seals one.
 * Team maps are envelopes the server cannot open, so the client is the only
 * place that can refuse: the check right before sealing is the chokepoint.
 */

let home: string
let cwd: string
let cloud: FakeCloud
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'veilio-rnl-home-'))
  cwd = mkdtempSync(join(tmpdir(), 'veilio-rnl-work-'))
  mkdirSync(join(cwd, '.git'), { recursive: true })
  cloud = new FakeCloud()
  cloud.recordsReservations = true
  vi.stubGlobal('fetch', cloud.fetch)
  signIn(home, { team: true, pmk: true })
})
afterEach(() => {
  vi.unstubAllGlobals()
  rmSync(home, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
})

const mapPath = (): string => join(cwd, STORE_DIR, STORE_FILE)
const reservedPath = () => join(cwd, STORE_DIR, RESERVED_FILE)
const writeReserved = (tag: string) =>
  writeFileSync(
    reservedPath(),
    JSON.stringify({
      version: 1,
      instance: INSTANCE,
      account: ME,
      teamId: TEAM_ID,
      blocks: {},
      local: { tag },
    })
  )
const tagNow = () =>
  (JSON.parse(readFileSync(reservedPath(), 'utf8')) as { local: { tag: string } }).local.tag
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
const openTeam = async (mapData: string): Promise<SymbolMap> =>
  decryptTeamMap(await importTeamKey(toBase64(TEAM_RAW)), JSON.parse(mapData) as TeamMapEnvelope)
const pushedId = (out: string) => /as (\S+)/.exec(out)?.[1] ?? ''
const sent = () => cloud.requests.filter((r) => r.method === 'POST' && r.path === '/api/maps')
const reserveAsks = () =>
  cloud.requests
    .filter((r) => r.path.endsWith('/placeholders/reserve'))
    .flatMap((r) => r.body!.requests as { base: string }[])

const LOCALS = {
  __LOCAL_K7Q2XA_FN__2: 'refundLater',
  __LOCAL_K7Q2XA_FN__1: 'chargeLater',
  __LOCAL_K7Q2XA_API_KEY__1: 'sk_live_x',
}

describe('a team publish renumbers local entries', () => {
  it('every local entry takes a reserved team number under its team kind, in order, with aliases', async () => {
    saveMap(mapPath(), { __FN__3: 'chargeCard', ...LOCALS }, { force: true })
    cloud.reservations.push({ base: '__FN__', start: 1, end: 3, member: 'u-me' })
    const res = await run(['maps', 'push', '--team', 'mine'])
    expect(res.code, res.err).toBe(EXIT_OK)
    const up = await openTeam(cloud.find(pushedId(res.out))!.map_data)
    expect(Object.keys(up).filter((p) => p.startsWith('__LOCAL_'))).toEqual([])
    const fnOf = (name: string) => Object.keys(up).find((p) => up[p] === name)!
    expect(fnOf('chargeLater')).toMatch(/^__FN__\d+$/)
    // Sorted by their old numbers, as today.
    expect(Number(fnOf('chargeLater').slice(6))).toBeLessThan(Number(fnOf('refundLater').slice(6)))
    expect(fnOf('sk_live_x')).toMatch(/^__API_KEY__\d+$/)
    expect(up.__FN__3).toBe('chargeCard')
    expect(
      reserveAsks()
        .map((r) => r.base)
        .sort()
      // A rule's base goes under its hash with the team key (Cloud audit M1).
    ).toEqual([wireBase('__API_KEY__', TEAM_RAW), '__FN__'].sort())
    expect(loadAliases(mapPath())).toEqual(LOCALS)
    expect(Object.keys(loadMap(mapPath())).filter(isLocalPlaceholder)).toEqual([])
  })

  it('a local entry is never "already the team’s", even where a team map holds that key', async () => {
    cloud.add({
      owner: 'ada@example.test',
      scope: 'team',
      name: 'theirs',
      map_data: await sealTeam({ __LOCAL_K7Q2XA_FN__1: 'chargeLater' }),
    })
    saveMap(mapPath(), { __LOCAL_K7Q2XA_FN__1: 'chargeLater' }, { force: true })
    const res = await run(['maps', 'push', '--team', 'mine'])
    expect(res.code, res.err).toBe(EXIT_OK)
    const up = await openTeam(cloud.find(pushedId(res.out))!.map_data)
    expect(Object.keys(up)).toEqual([expect.stringMatching(/^__FN__\d+$/)])
  })

  it('a renumbering that moved a local entry redraws the tag', async () => {
    saveMap(mapPath(), { __LOCAL_K7Q2XA_FN__1: 'chargeLater' }, { force: true })
    writeReserved('K7Q2XA')
    expect((await run(['maps', 'push', '--team', 'mine'])).code).toBe(EXIT_OK)
    expect(tagNow()).toMatch(/^[A-Z0-9]{6}$/)
    expect(tagNow()).not.toBe('K7Q2XA')
  })

  it('a renumbering of team-family entries only keeps the tag', async () => {
    saveMap(mapPath(), { __FN__41: 'chargeLater' }, { force: true })
    writeReserved('K7Q2XA')
    expect((await run(['maps', 'push', '--team', 'mine'])).code).toBe(EXIT_OK)
    expect(tagNow()).toBe('K7Q2XA')
  })

  it('a refused reservation refuses the publish by name, and the local entries stay', async () => {
    saveMap(mapPath(), { ...LOCALS }, { force: true })
    cloud.failWith(500, { error: 'boom' })
    const res = await run(['maps', 'push', '--team', 'mine'])
    expect(res.code).toBe(EXIT_ERROR)
    expect(res.err).toMatch(/numbered outside the team numbers this account reserved/)
    expect(res.err).toContain('__LOCAL_K7Q2XA_FN__1')
    expect(sent()).toHaveLength(0)
    expect(loadMap(mapPath())).toEqual(LOCALS)
  })
})

describe('the check before sealing (the chokepoint)', () => {
  it.each([
    ['a numbered local key', { __LOCAL_K7Q2XA_VAR__1: 'holdbackDays' }],
    ['a digitless local key', { __LOCAL_K7Q2XA_VAR__: 'holdbackDays' }],
  ])('%s is refused with local_entry_unpublishable when nothing renumbered it', async (_, map) => {
    // An instance that keeps no reservations record: renumbering is skipped.
    cloud.recordsReservations = false
    saveMap(mapPath(), map, { force: true })
    const res = await run(['maps', 'push', '--team', 'mine'])
    expect(res.code).toBe(EXIT_ERROR)
    expect(res.err).toContain(
      `this team map still holds placeholders numbered on one machine (${Object.keys(map)[0]})`
    )
    expect(res.err).toContain(
      'Run the publish again so they are renumbered, or report this as a bug.'
    )
    expect(sent()).toHaveLength(0)
  })

  it('a digitless local key is refused even with reservations kept', async () => {
    saveMap(mapPath(), { __LOCAL_K7Q2XA_VAR__: 'holdbackDays' }, { force: true })
    const res = await run(['maps', 'push', '--team', 'mine'])
    expect(res.code).toBe(EXIT_ERROR)
    expect(res.err).toContain('numbered on one machine')
  })

  it('the shared client (MCP maps_create, maps_update) refuses the same way', async () => {
    cloud.recordsReservations = false
    saveMap(mapPath(), { __LOCAL_K7Q2XA_VAR__1: 'holdbackDays' }, { force: true })
    const ctx = { home }
    const created = await createCloudMap(ctx, { name: 'mine', scope: 'team', mapPath: mapPath() })
    expect(created.ok).toBe(false)
    if (!created.ok) expect(created.refusal.code).toBe('local_entry_unpublishable')

    const row = cloud.add({
      scope: 'team',
      name: 'mine',
      map_data: await sealTeam({ __VAR__1: 'a' }),
    })
    saveMap(mapPath(), { __VAR__1: 'a', __LOCAL_K7Q2XA_VAR__1: 'holdbackDays' }, { force: true })
    const updated = await updateCloudMap(ctx, row.id, { mapPath: mapPath() })
    expect(updated.ok).toBe(false)
    if (!updated.ok) expect(updated.refusal.code).toBe('local_entry_unpublishable')
    expect(cloud.requests.filter((r) => r.method === 'PATCH')).toHaveLength(0)
    expect(sent()).toHaveLength(0)
  })

  it('a team update renumbers its local entries like a create', async () => {
    const row = cloud.add({
      scope: 'team',
      name: 'mine',
      map_data: await sealTeam({ __VAR__1: 'a' }),
    })
    cloud.reservations.push({ base: '__VAR__', start: 1, end: 1, member: 'u-me' })
    saveMap(mapPath(), { __VAR__1: 'a', __LOCAL_K7Q2XA_VAR__1: 'holdbackDays' }, { force: true })
    const res = await run(['maps', 'update', row.id])
    expect(res.code, res.err).toBe(EXIT_OK)
    const up = await openTeam(cloud.find(row.id)!.map_data)
    expect(Object.keys(up).filter((p) => p.startsWith('__LOCAL_'))).toEqual([])
    expect(Object.values(up)).toContain('holdbackDays')
  })
})

describe('a personal map keeps its local entries', () => {
  it('push and update go up with them, unrenumbered', async () => {
    saveMap(mapPath(), { __VAR__1: 'a', ...LOCALS }, { force: true })
    const pushed = await run(['maps', 'push', 'mine'])
    expect(pushed.code, pushed.err).toBe(EXIT_OK)
    const open = async (id: string) =>
      decryptMapFromVault(
        await importPersonalMapsKey(PMK_RAW),
        parseVaultEnvelope(cloud.find(id)!.map_data)
      )
    expect(await open(pushedId(pushed.out))).toEqual({ __VAR__1: 'a', ...LOCALS })

    const row = cloud.add({ name: 'p', map_data: await sealPersonal({ __VAR__1: 'a' }, 'pmk') })
    const updated = await run(['maps', 'update', row.id])
    expect(updated.code, updated.err).toBe(EXIT_OK)
    expect(await open(row.id)).toEqual({ __VAR__1: 'a', ...LOCALS })
    expect(reserveAsks()).toEqual([])
  })
})

describe('a process holding a session tag (no reserved.json) after a publish', () => {
  it('numbers the next local name under a new tag, never a retired placeholder', async () => {
    writeFileSync(join(cwd, 'a.ts'), 'export const holdbackDays = 3\n')
    const first = await run(['scrub', 'a.ts'])
    const retired = /__LOCAL_[A-Z0-9]{6}_VAR__1/.exec(first.out)?.[0]
    expect(retired, first.out).toBeDefined()
    const pushed = await run(['maps', 'push', '--team', 'mine'])
    expect(pushed.code, pushed.err).toBe(EXIT_OK)
    expect(loadAliases(mapPath())).toEqual({ [retired!]: 'holdbackDays' })

    writeFileSync(join(cwd, 'b.ts'), 'export const payoutCutoff = 5\n')
    const next = await run(['scrub', 'b.ts'])
    const minted = /__LOCAL_([A-Z0-9]{6})_VAR__\d+/.exec(next.out)
    expect(minted, next.out).not.toBeNull()
    expect(minted![1]).not.toBe(retired!.slice('__LOCAL_'.length, '__LOCAL_'.length + 6))
    expect(next.out).not.toContain(retired!)
  })
})
