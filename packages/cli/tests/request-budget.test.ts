import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { STORE_DIR, STORE_FILE, saveMap } from '../src/store.js'
import { VERSION } from '../src/version.js'
import {
  FakeCloud,
  PASSPHRASE,
  TEAMMATE,
  sealPersonal,
  sealTeam,
  signIn,
} from './helpers/fake-cloud.js'
import { runBinary, serveOverHttp } from './helpers/http-fake.js'

/**
 * How many requests each command makes (spec 052, the staging journey of
 * 2026-10-26).
 *
 * The journey hit Cloud's maps rate limit (300 per 15 minutes per session)
 * after about 45 commands: staging logged ~345 listings and 116 team-envelope
 * reads, about eight listings per command. A person scripting updates, or an
 * agent using the MCP server, meets the same limit the same way.
 *
 * So each command has a budget, pinned here against the BUILT binary, spawned
 * as a user runs it, talking over real HTTP to a recording fake server. A
 * change that adds a request fails here, not on staging. The same run checks
 * that every request carries the program's name (tracker d12).
 */

const BIN = resolve(import.meta.dirname, '..', 'dist', 'index.js')

let cloud: FakeCloud
let url: string
let close: () => Promise<void>
let home: string
let cwd: string

beforeEach(async () => {
  cloud = new FakeCloud()
  ;({ url, close } = await serveOverHttp(cloud))
  home = mkdtempSync(join(tmpdir(), 'veilio-budget-home-'))
  cwd = mkdtempSync(join(tmpdir(), 'veilio-budget-work-'))
  mkdirSync(join(cwd, '.git'))
})

afterEach(async () => {
  await close()
  rmSync(home, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
})

const local = (map: Record<string, string>): void =>
  saveMap(join(cwd, STORE_DIR, STORE_FILE), map, { force: true })

/** Run one command; answer its requests, by path. */
async function measure(
  args: string[],
  input = ''
): Promise<{ code: number | null; err: string; paths: string[] }> {
  cloud.requests = []
  const r = await runBinary(BIN, args, { cwd, home, input })
  // Every request names the program and its version (tracker d12).
  for (const req of cloud.requests) {
    expect(req.headers['x-veilio-client'], `${req.method} ${req.path}`).toBe('cli')
    expect(req.headers['user-agent'], `${req.method} ${req.path}`).toBe(`veilio-cli/${VERSION}`)
  }
  return { code: r.code, err: r.err, paths: cloud.requests.map((q) => `${q.method} ${q.path}`) }
}

async function teamWorld(): Promise<{ mine: string; personal: string }> {
  signIn(home, { team: true, pmk: true, instance: url })
  const mine = cloud.add({
    scope: 'team',
    name: 'shared',
    project: 'p-billing',
    map_data: await sealTeam({ __CLS__1: 'Ledger' }),
  }).id
  cloud.add({
    scope: 'team',
    owner: TEAMMATE,
    project: 'p-billing',
    map_data: await sealTeam({ __CLS__7: 'Router' }),
  })
  const personal = cloud.add({
    name: 'mine',
    map_data: await sealPersonal({ __CLS__1: 'Ledger' }, 'pmk'),
  }).id
  return { mine, personal }
}

describe('each command stays within its request budget', () => {
  it('maps list: 1', async () => {
    await teamWorld()
    const r = await measure(['maps', 'list'])
    expect(r.code, r.err).toBe(0)
    expect(r.paths).toEqual(['GET /api/maps'])
  })

  it('maps pull (personal, key unlocked): at most 2', async () => {
    const { personal } = await teamWorld()
    const r = await measure(['maps', 'pull', personal])
    expect(r.code, r.err).toBe(0)
    expect(r.paths.length, r.paths.join('\n')).toBeLessThanOrEqual(2)
  })

  it('maps pull (team): at most 2', async () => {
    const { mine } = await teamWorld()
    const r = await measure(['maps', 'pull', mine])
    expect(r.code, r.err).toBe(0)
    expect(r.paths.length, r.paths.join('\n')).toBeLessThanOrEqual(2)
  })

  it('maps update (personal): at most 3', async () => {
    const { personal } = await teamWorld()
    local({ __CLS__1: 'Ledger', __FN__2: 'settle' })
    const r = await measure(['maps', 'update', personal])
    expect(r.code, r.err).toBe(0)
    expect(r.paths.length, r.paths.join('\n')).toBeLessThanOrEqual(3)
  })

  it('maps update (team): at most 3 - the listing once, the team maps once, the write', async () => {
    const { mine } = await teamWorld()
    local({ __CLS__1: 'Ledger', __FN__2: 'settle' })
    const r = await measure(['maps', 'update', mine])
    expect(r.code, r.err).toBe(0)
    expect(r.paths.length, r.paths.join('\n')).toBeLessThanOrEqual(3)
    expect(r.paths.filter((p) => p === 'GET /api/maps')).toHaveLength(1)
  })

  it('maps push --team: at most 3', async () => {
    await teamWorld()
    local({ __CLS__2: 'Fresh' })
    const r = await measure(['maps', 'push', '--team', 'fresh'])
    expect(r.code, r.err).toBe(0)
    expect(r.paths.length, r.paths.join('\n')).toBeLessThanOrEqual(3)
    expect(r.paths.filter((p) => p === 'GET /api/maps')).toHaveLength(1)
  })

  it('maps push (personal, key unlocked): 1', async () => {
    await teamWorld()
    local({ __CLS__2: 'Fresh' })
    const r = await measure(['maps', 'push', 'fresh'])
    expect(r.code, r.err).toBe(0)
    expect(r.paths).toEqual(['POST /api/maps'])
  })

  it('maps rm: at most 2', async () => {
    const { personal } = await teamWorld()
    const r = await measure(['maps', 'rm', personal])
    expect(r.code, r.err).toBe(0)
    expect(r.paths.length, r.paths.join('\n')).toBeLessThanOrEqual(2)
  })

  it('scrub (signed in to a team): at most 2 - the team namespace read once', async () => {
    await teamWorld()
    writeFileSync(join(cwd, 'a.ts'), 'export class Gamma {}\n')
    const r = await measure(['scrub', 'a.ts'])
    expect(r.code, r.err).toBe(0)
    expect(r.paths.length, r.paths.join('\n')).toBeLessThanOrEqual(2)
  })

  it('scrub --team: at most 2 reads, plus the one reservation', async () => {
    await teamWorld()
    writeFileSync(join(cwd, 'a.ts'), 'export class Gamma {}\n')
    const r = await measure(['scrub', '--team', 'a.ts'])
    expect(r.code, r.err).toBe(0)
    expect(
      r.paths.filter((p) => p.startsWith('GET')).length,
      r.paths.join('\n')
    ).toBeLessThanOrEqual(2)
    expect(r.paths.filter((p) => p.startsWith('POST')).length).toBeLessThanOrEqual(1)
  })

  it('projects: 1, projects use: 1', async () => {
    await teamWorld()
    expect((await measure(['projects'])).paths).toHaveLength(1)
    expect((await measure(['projects', 'use', 'tools'])).paths).toHaveLength(1)
  })

  it('vault unlock (first time, nothing to re-seal): at most 4', async () => {
    signIn(home, { instance: url })
    await cloud.withVault()
    const r = await measure(['vault', 'unlock'], `${PASSPHRASE}\n`)
    expect(r.code, r.err).toBe(0)
    expect(r.paths.length, r.paths.join('\n')).toBeLessThanOrEqual(4)
  })

  it('a rate-limited answer is not retried: a second request only deepens the limit', async () => {
    await teamWorld()
    cloud.limited.add('/api/maps')
    writeFileSync(join(cwd, 'a.ts'), 'export class Gamma {}\n')
    const r = await measure(['scrub', 'a.ts'])
    expect(r.code, r.err).toBe(0)
    expect(r.paths).toEqual(['GET /api/maps'])
  })

  it('whoami and the offline commands: none', async () => {
    await teamWorld()
    expect((await measure(['whoami'])).paths).toHaveLength(0)
    expect((await measure(['map'])).paths).toHaveLength(0)
  })
})
