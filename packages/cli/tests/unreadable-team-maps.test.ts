import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { main } from '../src/index.js'
import { EXIT_ERROR, EXIT_OK, type Io } from '../src/commands.js'
import { STORE_DIR, STORE_FILE, saveMap } from '../src/store.js'
import { FakeCloud, TEAMMATE, sealTeam, signIn } from './helpers/fake-cloud.js'

/**
 * FR-018 (spec 052, T016): a team map nobody here can open is NAMED by every
 * refusal and note it causes.
 *
 * Found live on 2026-10-25: an unreadable map left by an earlier test blocked
 * every team push with "none of the team maps opened with the unlocked key",
 * and nothing said which map, so nobody could act. The fix is not to stop
 * refusing - publishing blind is what the check prevents - but to say which
 * map, by the name a person recognises and the id they would type.
 */

let home: string
let cwd: string
let cloud: FakeCloud
const OTHER_KEY = new Uint8Array(32).fill(1)

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'veilio-fr018-home-'))
  cwd = mkdtempSync(join(tmpdir(), 'veilio-fr018-work-'))
  mkdirSync(join(cwd, '.git'), { recursive: true })
  cloud = new FakeCloud()
  vi.stubGlobal('fetch', cloud.fetch)
  signIn(home, { team: true })
  saveMap(join(cwd, STORE_DIR, STORE_FILE), { __CLS__1: 'Ledger' }, { force: true })
})

afterEach(() => {
  vi.unstubAllGlobals()
  rmSync(home, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
})

async function run(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = ''
  let err = ''
  const io: Io = {
    cwd,
    home,
    stdin: async () => '',
    stdout: (t) => (out += t),
    stderr: (t) => (err += t),
    password: async () => '',
  }
  return { code: await main(argv, io), out, err }
}

describe('every team map unreadable', () => {
  it('a team push is refused, naming each map', async () => {
    const a = cloud.add({
      scope: 'team',
      owner: TEAMMATE,
      name: 'stale-test-map',
      map_data: await sealTeam({ __FN__1: 'x' }, OTHER_KEY),
    })
    const r = await run(['maps', 'push', '--team', 'mine'])
    expect(r.code).toBe(EXIT_ERROR)
    expect(r.err).toContain(`"stale-test-map" (${a.id})`)
    expect(r.err).toContain('`veilio maps rm <id>`')
    expect(cloud.requests.filter((x) => x.method === 'POST')).toHaveLength(0)
  })

  it('a team update is refused the same way', async () => {
    const mine = cloud.add({
      scope: 'team',
      name: 'mine',
      map_data: await sealTeam({ __CLS__1: 'Ledger' }),
    })
    const bad = cloud.add({
      scope: 'team',
      owner: TEAMMATE,
      name: 'broken',
      map_data: await sealTeam({ __FN__1: 'x' }, OTHER_KEY),
    })
    saveMap(join(cwd, STORE_DIR, STORE_FILE), { __CLS__1: 'Ledger', __FN__2: 'y' }, { force: true })
    const r = await run(['maps', 'update', mine.id])
    expect(r.code).toBe(EXIT_ERROR)
    expect(r.err).toContain(`"broken" (${bad.id})`)
    expect(cloud.requests.filter((x) => x.method === 'PATCH')).toHaveLength(0)
  })
})

describe('some readable, some not', () => {
  it('the push goes ahead against the readable ones, and names the ones it could not check', async () => {
    cloud.add({
      scope: 'team',
      owner: TEAMMATE,
      name: 'good',
      map_data: await sealTeam({ __FN__9: 'z' }),
    })
    const bad = cloud.add({
      scope: 'team',
      owner: TEAMMATE,
      name: 'broken',
      map_data: await sealTeam({ __FN__1: 'x' }, OTHER_KEY),
    })
    const r = await run(['maps', 'push', '--team', 'mine'])
    expect(r.code, r.err).toBe(EXIT_OK)
    expect(r.err).toMatch(/1 team map could not be opened and was not checked for clashes/)
    expect(r.err).toContain(`"broken" (${bad.id})`)
  })
})

describe('pulling one that does not open', () => {
  it('names it', async () => {
    const bad = cloud.add({
      scope: 'team',
      owner: TEAMMATE,
      name: 'broken',
      map_data: await sealTeam({ __FN__1: 'x' }, OTHER_KEY),
    })
    const r = await run(['maps', 'pull', bad.id])
    expect(r.code).toBe(EXIT_ERROR)
    expect(r.err).toContain(`"broken" (${bad.id})`)
    expect(r.err).toMatch(/could not be opened with the unlocked team keys/)
  })
})

describe('maps the server itself cannot read', () => {
  it('all of them: refused like any unreadable namespace, naming them - never a blind publish', async () => {
    const a = cloud.add({
      scope: 'team',
      owner: TEAMMATE,
      name: 'peeled',
      map_data: await sealTeam({ __FN__1: 'x' }),
    })
    cloud.serverUnreadable.add(a.id)
    const r = await run(['maps', 'push', '--team', 'mine'])
    expect(r.code).toBe(EXIT_ERROR)
    expect(r.err).toContain(`"peeled" (${a.id})`)
    expect(cloud.requests.filter((x) => x.method === 'POST')).toHaveLength(0)
  })
})

describe('team keys unlocked for another team (security)', () => {
  it('are refused before anything is sealed, even where the namespace needs no key', async () => {
    // An older instance merges the namespace server-side, so the namespace
    // read never checks the key: the key step must.
    const { writeTeamUnlock } = await import('../src/team-unlock.js')
    const { toBase64 } = await import('@veilio-inc/engine')
    writeTeamUnlock(
      {
        v: 1,
        instance: 'https://veilio.test',
        account: 'me@example.test',
        teamId: 'team-previous',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        keys: [{ version: 1, key: toBase64(new Uint8Array(32).fill(8)) }],
      },
      home
    )
    cloud.legacyNamespace = { __CLS__3: 'Shared' }
    const r = await run(['maps', 'push', '--team', 'mine'])
    expect(r.code).toBe(EXIT_ERROR)
    expect(r.err).toMatch(/does not match this team/)
    expect(cloud.requests.filter((x) => x.method === 'POST')).toHaveLength(0)
  })

  it('an update with them is refused at the key, too', async () => {
    const mine = cloud.add({
      scope: 'team',
      name: 'mine',
      map_data: await sealTeam({ __CLS__1: 'Ledger' }),
    })
    const { writeTeamUnlock } = await import('../src/team-unlock.js')
    const { toBase64 } = await import('@veilio-inc/engine')
    writeTeamUnlock(
      {
        v: 1,
        instance: 'https://veilio.test',
        account: 'me@example.test',
        teamId: 'team-previous',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        // The same bytes as this team's key: only the team id tells them apart.
        keys: [{ version: 1, key: toBase64(new Uint8Array(32).fill(7)) }],
      },
      home
    )
    saveMap(join(cwd, STORE_DIR, STORE_FILE), { __CLS__1: 'Ledger', __FN__2: 'y' }, { force: true })
    const r = await run(['maps', 'update', mine.id])
    expect(r.code).toBe(EXIT_ERROR)
    expect(r.err).toMatch(/does not match this team/)
    expect(cloud.requests.filter((x) => x.method === 'PATCH')).toHaveLength(0)
    // Refused before the map itself was even downloaded.
    expect(cloud.requests.some((x) => x.path === `/api/maps/${mine.id}`)).toBe(false)
  })
})
