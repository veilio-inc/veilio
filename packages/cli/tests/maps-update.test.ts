import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  decryptMapFromVault,
  decryptTeamMap,
  importTeamKey,
  parseVaultEnvelope,
  toBase64,
  type SymbolMap,
  type TeamMapEnvelope,
} from '@veilio-inc/engine'
import { main } from '../src/index.js'
import { EXIT_ERROR, EXIT_OK, type Io } from '../src/commands.js'
import { STORE_DIR, STORE_FILE, saveMap } from '../src/store.js'
import { importPersonalMapsKey } from '../src/client/personal-maps-key.js'
import {
  FakeCloud,
  PASSPHRASE,
  PMK_RAW,
  TEAMMATE,
  TEAM_RAW,
  sealPersonal,
  sealTeam,
  signIn,
} from './helpers/fake-cloud.js'

/**
 * `veilio maps update <id>` (spec 052 US1, T012): a map already in Cloud takes
 * the local map's entries, IN PLACE - same id, same name, same project, still
 * exactly one map (SC-001).
 *
 * The refusals are the substance. Each is checked for its words AND for the
 * fact that nothing was sent: an update refused after the PATCH went out is
 * not a refusal.
 */

let home: string
let cwd: string
let cloud: FakeCloud

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'veilio-upd-home-'))
  cwd = mkdtempSync(join(tmpdir(), 'veilio-upd-work-'))
  mkdirSync(join(cwd, '.git'), { recursive: true })
  cloud = new FakeCloud()
  vi.stubGlobal('fetch', cloud.fetch)
})

afterEach(() => {
  vi.unstubAllGlobals()
  rmSync(home, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
})

const mapPath = (): string => join(cwd, STORE_DIR, STORE_FILE)
const local = (map: SymbolMap): void => saveMap(mapPath(), map, { force: true })

async function run(
  argv: string[]
): Promise<{ code: number; out: string; err: string; asked: number }> {
  let out = ''
  let err = ''
  let asked = 0
  const io: Io = {
    cwd,
    home,
    stdin: async () => '',
    stdout: (t) => (out += t),
    stderr: (t) => (err += t),
    prompt: async () => '',
    password: async () => {
      asked++
      return PASSPHRASE
    },
  }
  return { code: await main(argv, io), out, err, asked }
}

async function openPersonalWithPmk(mapData: string): Promise<SymbolMap> {
  return decryptMapFromVault(await importPersonalMapsKey(PMK_RAW), parseVaultEnvelope(mapData))
}

async function openTeam(mapData: string): Promise<SymbolMap> {
  return decryptTeamMap(
    await importTeamKey(toBase64(TEAM_RAW)),
    JSON.parse(mapData) as TeamMapEnvelope
  )
}

const patches = (): number => cloud.requests.filter((r) => r.method === 'PATCH').length

describe('a personal map, updated in place', () => {
  it('takes the local entries, keeps its id and name, and stays sealed for its owner', async () => {
    signIn(home, { pmk: true })
    const row = cloud.add({
      name: 'billing',
      map_data: await sealPersonal({ __CLS__1: 'Ledger' }, 'pmk'),
    })
    const before = row.updated_at
    local({ __CLS__1: 'Ledger', __FN__2: 'settle' })

    const r = await run(['maps', 'update', row.id])
    expect(r.code, r.err).toBe(EXIT_OK)
    expect(r.out).toContain(`Updated "billing" (${row.id}) in place: 2 symbols`)
    expect(cloud.maps).toHaveLength(1)
    expect(cloud.maps[0]!.id).toBe(row.id)
    expect(cloud.maps[0]!.name).toBe('billing')
    expect(cloud.maps[0]!.updated_at).not.toBe(before)
    expect(await openPersonalWithPmk(cloud.maps[0]!.map_data)).toEqual({
      __CLS__1: 'Ledger',
      __FN__2: 'settle',
    })
    // The version it read, so a write in between is refused rather than lost.
    const patch = cloud.requests.find((r) => r.method === 'PATCH')!
    expect(patch.body?.if_updated_at).toBe(before)
    expect(patch.body?.identifier_count).toBe(2)
    // The personal-maps key on disk: nothing to ask for.
    expect(r.asked).toBe(0)
  })

  it('ten updates leave exactly one map, with the same id (SC-001)', async () => {
    signIn(home, { pmk: true })
    const row = cloud.add({ map_data: await sealPersonal({ __CLS__1: 'A' }, 'pmk') })
    const growing: SymbolMap = { __CLS__1: 'A' }
    for (let i = 0; i < 10; i++) {
      growing[`__FN__${i + 1}`] = `f${i}`
      local(growing)
      const r = await run(['maps', 'update', row.id])
      expect(r.code, r.err).toBe(EXIT_OK)
    }
    expect(cloud.maps.map((m) => m.id)).toEqual([row.id])
    expect(patches()).toBe(10)
  })

  it('a map still sealed with the vault key is refused, naming `veilio vault unlock`', async () => {
    signIn(home, { pmk: true })
    const row = cloud.add({ map_data: await sealPersonal({ __CLS__1: 'Ledger' }, 'vault') })
    local({ __CLS__1: 'Ledger', __FN__2: 'settle' })
    const r = await run(['maps', 'update', row.id])
    expect(r.code).toBe(EXIT_ERROR)
    expect(r.err).toMatch(/still sealed with the vault key/)
    expect(r.err).toContain('`veilio vault unlock`')
    expect(patches()).toBe(0)
  })

  it('without the key on disk, the passphrase opens the vault-key map and it is re-sealed under the PMK', async () => {
    signIn(home)
    await cloud.withVault()
    await cloud.withPmkWrap()
    const row = cloud.add({ map_data: await sealPersonal({ __CLS__1: 'Ledger' }, 'vault') })
    local({ __CLS__1: 'Ledger', __FN__2: 'settle' })
    const r = await run(['maps', 'update', row.id])
    expect(r.code, r.err).toBe(EXIT_OK)
    expect(r.asked).toBe(1)
    expect(await openPersonalWithPmk(cloud.maps[0]!.map_data)).toEqual({
      __CLS__1: 'Ledger',
      __FN__2: 'settle',
    })
    // The passphrase never went anywhere.
    expect(cloud.wire()).not.toContain(PASSPHRASE)
  })

  it('neither key on disk nor a personal-maps key on the account: refused, naming the command that makes one', async () => {
    signIn(home)
    await cloud.withVault()
    const row = cloud.add({ map_data: await sealPersonal({ __CLS__1: 'Ledger' }, 'vault') })
    local({ __CLS__1: 'Ledger', __FN__2: 'settle' })
    const r = await run(['maps', 'update', row.id])
    expect(r.code).toBe(EXIT_ERROR)
    expect(r.err).toContain('`veilio vault unlock`')
    expect(patches()).toBe(0)
  })
})

describe('entries the update would drop (FR-005)', () => {
  it('are refused with the count, and nothing is sent', async () => {
    signIn(home, { pmk: true })
    const row = cloud.add({
      map_data: await sealPersonal({ __CLS__1: 'A', __FN__2: 'b', __FN__3: 'c' }, 'pmk'),
    })
    local({ __CLS__1: 'A' })
    const r = await run(['maps', 'update', row.id])
    expect(r.code).toBe(EXIT_ERROR)
    expect(r.err).toMatch(/would drop 2 entries/)
    expect(r.err).toContain('--allow-drop')
    expect(patches()).toBe(0)
  })

  it('a changed meaning counts as a drop: the old one is gone', async () => {
    signIn(home, { pmk: true })
    const row = cloud.add({ map_data: await sealPersonal({ __CLS__1: 'Old' }, 'pmk') })
    local({ __CLS__1: 'New' })
    const r = await run(['maps', 'update', row.id])
    expect(r.err).toMatch(/would drop 1 entry/)
    expect(patches()).toBe(0)
  })

  it('go when the person says so, and the result says how many went', async () => {
    signIn(home, { pmk: true })
    const row = cloud.add({
      map_data: await sealPersonal({ __CLS__1: 'A', __FN__2: 'b', __FN__3: 'c' }, 'pmk'),
    })
    local({ __CLS__1: 'A' })
    const r = await run(['maps', 'update', row.id, '--allow-drop'])
    expect(r.code, r.err).toBe(EXIT_OK)
    expect(r.out).toMatch(/2 dropped as asked/)
    expect(await openPersonalWithPmk(cloud.maps[0]!.map_data)).toEqual({ __CLS__1: 'A' })
  })
})

describe('a team map, updated in place', () => {
  it('its publisher updates it, sealed with the team key, the key version declared', async () => {
    signIn(home, { team: true })
    const row = cloud.add({
      scope: 'team',
      project: 'p-billing',
      map_data: await sealTeam({ __CLS__1: 'Ledger' }),
    })
    cloud.add({
      scope: 'team',
      owner: TEAMMATE,
      project: 'p-billing',
      map_data: await sealTeam({ __CLS__7: 'Router' }),
    })
    local({ __CLS__1: 'Ledger', __FN__2: 'settle' })
    const r = await run(['maps', 'update', row.id])
    expect(r.code, r.err).toBe(EXIT_OK)
    expect(r.out).toContain('sealed with the team key')
    expect(await openTeam(cloud.find(row.id)!.map_data)).toEqual({
      __CLS__1: 'Ledger',
      __FN__2: 'settle',
    })
    expect(cloud.requests.find((x) => x.method === 'PATCH')!.body?.key_version).toBe(1)
    expect(cloud.maps).toHaveLength(2)
    expect(cloud.find(row.id)!.project).toBe('p-billing')
  })

  it('a placeholder another team map gives a different meaning is refused, naming it (FR-003)', async () => {
    signIn(home, { team: true })
    const row = cloud.add({ scope: 'team', map_data: await sealTeam({ __CLS__1: 'Ledger' }) })
    cloud.add({
      scope: 'team',
      owner: TEAMMATE,
      map_data: await sealTeam({ __CLS__9: 'TheirRouter' }),
    })
    local({ __CLS__1: 'Ledger', __CLS__9: 'MyRouter' })
    const r = await run(['maps', 'update', row.id])
    expect(r.code).toBe(EXIT_ERROR)
    expect(r.err).toContain('__CLS__9')
    expect(r.err).toMatch(/unrestorable for every member/)
    expect(r.err).toContain('this map says MyRouter, the team says TheirRouter')
    expect(patches()).toBe(0)
  })

  it('is not checked against its own old entries: a changed meaning of its own is a drop, not a clash', async () => {
    signIn(home, { team: true })
    const row = cloud.add({ scope: 'team', map_data: await sealTeam({ __FN__1: 'oldName' }) })
    local({ __FN__1: 'newName' })
    const r = await run(['maps', 'update', row.id, '--allow-drop'])
    expect(r.code, r.err).toBe(EXIT_OK)
    expect(await openTeam(cloud.find(row.id)!.map_data)).toEqual({ __FN__1: 'newName' })
  })

  it('a teammate’s map is refused before anything is read or sent (FR-006)', async () => {
    signIn(home, { team: true })
    const theirs = cloud.add({
      scope: 'team',
      owner: TEAMMATE,
      name: 'routing',
      map_data: await sealTeam({ __CLS__1: 'X' }),
    })
    local({ __CLS__1: 'X', __FN__2: 'y' })
    const r = await run(['maps', 'update', theirs.id])
    expect(r.code).toBe(EXIT_ERROR)
    expect(r.err).toMatch(
      /"routing" \(map-\d+\) belongs to someone else on your team, so only they can update it/
    )
    expect(patches()).toBe(0)
    expect(cloud.requests.some((x) => x.path === `/api/maps/${theirs.id}`)).toBe(false)
  })

  it('the server’s 403 says the same thing, if it is the one to notice', async () => {
    signIn(home, { team: true })
    const row = cloud.add({ scope: 'team', map_data: await sealTeam({ __CLS__1: 'X' }) })
    // Listed as ours when listed; by the write, the server says otherwise.
    cloud.afterGet = (m) => (m.owner = TEAMMATE)
    local({ __CLS__1: 'X', __FN__2: 'y' })
    const r = await run(['maps', 'update', row.id])
    expect(r.code).toBe(EXIT_ERROR)
    expect(r.err).toMatch(/belongs to someone else on your team, so only they can update it/)
  })

  it('a team owing a key change is refused with the team push’s words (FR-004)', async () => {
    signIn(home, { team: true })
    const row = cloud.add({ scope: 'team', map_data: await sealTeam({ __CLS__1: 'X' }) })
    cloud.rotationOwed = true
    local({ __CLS__1: 'X', __FN__2: 'y' })
    const before = cloud.find(row.id)!.map_data
    const r = await run(['maps', 'update', row.id])
    expect(r.code).toBe(EXIT_ERROR)
    expect(r.err).toMatch(/teammate left/)
    expect(r.err).toMatch(/holds the current key/)
    expect(r.err).not.toMatch(/HTTP 423|reported an error/)
    expect(cloud.find(row.id)!.map_data).toBe(before)
  })

  it('the team key not unlocked here: refused, naming `veilio team unlock`', async () => {
    signIn(home)
    const row = cloud.add({ scope: 'team', map_data: await sealTeam({ __CLS__1: 'X' }) })
    local({ __CLS__1: 'X', __FN__2: 'y' })
    const r = await run(['maps', 'update', row.id])
    expect(r.code).toBe(EXIT_ERROR)
    expect(r.err).toContain('`veilio team unlock`')
    expect(patches()).toBe(0)
  })
})

describe('a teammate’s write in between (stale version)', () => {
  it('is refused, naming the version it lost to, and nothing is overwritten', async () => {
    signIn(home, { pmk: true })
    const row = cloud.add({ map_data: await sealPersonal({ __CLS__1: 'A' }, 'pmk') })
    // Another client writes between our read and our update.
    let other = ''
    cloud.afterGet = (m) => {
      m.updated_at = '2026-10-25T12:00:00.000Z'
      other = m.map_data
      cloud.afterGet = null
    }
    local({ __CLS__1: 'A', __FN__2: 'b' })
    const r = await run(['maps', 'update', row.id])
    expect(r.code).toBe(EXIT_ERROR)
    expect(r.err).toMatch(/changed in Cloud since it was read \(now 2026-10-25T12:00:00.000Z\)/)
    expect(r.err).toContain('`veilio maps pull <id>`')
    expect(cloud.find(row.id)!.map_data).toBe(other)
  })
})

describe('the ordinary refusals', () => {
  it('signed out: the sign-in sentence, and no request', async () => {
    local({ __CLS__1: 'A' })
    const r = await run(['maps', 'update', 'map-1'])
    expect(r.code).toBe(EXIT_ERROR)
    expect(r.err).toBe('veilio: not signed in. Run `veilio login` first.\n')
    expect(cloud.requests).toHaveLength(0)
  })

  it('no id: which map', async () => {
    signIn(home, { pmk: true })
    local({ __CLS__1: 'A' })
    const r = await run(['maps', 'update'])
    expect(r.err).toMatch(/which map/)
  })

  it('a map that is not on the account', async () => {
    signIn(home, { pmk: true })
    local({ __CLS__1: 'A' })
    const r = await run(['maps', 'update', 'nope'])
    expect(r.err).toMatch(/there is no map nope on this account/)
    expect(patches()).toBe(0)
  })

  it('no local map: nothing to send', async () => {
    signIn(home, { pmk: true })
    const row = cloud.add({ map_data: await sealPersonal({ __CLS__1: 'A' }, 'pmk') })
    const r = await run(['maps', 'update', row.id])
    expect(r.err).toMatch(/no local map/)
    expect(cloud.requests).toHaveLength(0)
  })

  it('too large for Cloud', async () => {
    signIn(home, { pmk: true })
    const row = cloud.add({ map_data: await sealPersonal({ __CLS__1: 'A' }, 'pmk') })
    cloud.maxBytes = 10
    local({ __CLS__1: 'A', __FN__2: 'b' })
    const r = await run(['maps', 'update', row.id])
    expect(r.err).toMatch(/too large/)
  })

  it('the local map is left exactly as it was by every refusal', async () => {
    signIn(home, { pmk: true })
    const row = cloud.add({ map_data: await sealPersonal({ __CLS__1: 'A', __FN__2: 'b' }, 'pmk') })
    local({ __CLS__1: 'A' })
    const bytes = readFileSync(mapPath(), 'utf8')
    await run(['maps', 'update', row.id])
    expect(readFileSync(mapPath(), 'utf8')).toBe(bytes)
  })
})
