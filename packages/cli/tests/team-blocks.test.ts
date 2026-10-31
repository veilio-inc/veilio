import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { main } from '../src/index.js'
import { EXIT_OK, type Io } from '../src/commands.js'
import { STORE_DIR, STORE_FILE } from '../src/store.js'
import { RESERVED_FILE, loadReserved } from '../src/reservations.js'
import {
  FakeCloud,
  INSTANCE,
  ME,
  PASSPHRASE,
  TEAMMATE,
  sealTeam,
  signIn,
} from './helpers/fake-cloud.js'

/**
 * Spec 063 US1: a member who pulls a team map leaves with a block of the
 * team's numbers, so the guard - which makes no request - numbers new names
 * where no teammate can. In spec 061's benchmark every member's guard numbered
 * from the same pulled map, and 93 of 128 publishes were refused.
 */

let home: string
let cwd: string
let cloud: FakeCloud

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'veilio-blk-home-'))
  cwd = mkdtempSync(join(tmpdir(), 'veilio-blk-work-'))
  mkdirSync(join(cwd, '.git'), { recursive: true })
  cloud = new FakeCloud()
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

async function teamMap(map: Record<string, string>, owner = TEAMMATE): Promise<string> {
  return cloud.add({ owner, scope: 'team', name: 'shared', map_data: await sealTeam(map) }).id
}
const blockRequests = () =>
  cloud.requests.filter((r) => r.path.endsWith('/placeholders/reserve') && r.body?.block === true)

describe('pulling a team map reserves a block when the member needs one', () => {
  it('a first pull reserves one block per kind, above everything the map holds, in one request', async () => {
    const id = await teamMap({ __FN__40: 'chargeCard', __CLS__3: 'Ledger', __VAR__9: 'amount' })
    const res = await run(['maps', 'pull', id])
    expect(res.code, res.err).toBe(EXIT_OK)
    expect(blockRequests()).toHaveLength(1)
    const r = loadReserved(mapPath())!
    expect(r).toMatchObject({ instance: INSTANCE, account: ME, teamId: 'team-1' })
    expect(r.blocks.__FN__.start).toBeGreaterThan(40)
    expect(r.blocks.__CLS__.start).toBeGreaterThan(3)
    expect(r.blocks.__VAR__.start).toBeGreaterThan(9)
    for (const b of Object.values(r.blocks)) expect(b.end - b.start + 1).toBe(500)
    expect(res.out).toMatch(/reserved/i)
  })

  it('a block that is still above the map is kept: no request', async () => {
    const id = await teamMap({ __FN__40: 'chargeCard' })
    await run(['maps', 'pull', id])
    const before = blockRequests().length
    const res = await run(['maps', 'pull', id, '--force'])
    expect(res.code, res.err).toBe(EXIT_OK)
    expect(blockRequests()).toHaveLength(before)
  })

  it('a teammate’s number above the block gets that kind a new block, above it', async () => {
    const id = await teamMap({ __FN__40: 'chargeCard' })
    await run(['maps', 'pull', id])
    const first = loadReserved(mapPath())!.blocks.__FN__
    const newer = await teamMap({ __FN__40: 'chargeCard', [`__FN__${first.end + 20}`]: 'refund' })
    const res = await run(['maps', 'pull', newer, '--force'])
    expect(res.code, res.err).toBe(EXIT_OK)
    const second = loadReserved(mapPath())!.blocks.__FN__
    expect(second.start).toBeGreaterThan(first.end + 20)
    // Only the kind that needed it.
    expect(
      (blockRequests().at(-1)!.body!.requests as { base: string }[]).map((x) => x.base)
    ).toEqual(['__FN__'])
  })

  it('a personal map reserves nothing', async () => {
    const res = await run(['maps', 'list'])
    expect(res.code).toBe(EXIT_OK)
    expect(blockRequests()).toHaveLength(0)
    expect(existsSync(join(cwd, STORE_DIR, RESERVED_FILE))).toBe(false)
  })

  it('a refused block does not fail the pull: the map is in, and it says the guard numbers locally', async () => {
    cloud.blocksRefused = true
    const id = await teamMap({ __FN__40: 'chargeCard' })
    const res = await run(['maps', 'pull', id])
    expect(res.code, res.err).toBe(EXIT_OK)
    expect(existsSync(mapPath())).toBe(true)
    // Spec 066: on the normal output.
    expect(res.out).toMatch(/could not reserve/i)
    expect(res.out).toMatch(/new names are numbered on this machine/i)
    // Spec 066 R4: written anyway, with no block, so the guard knows it is in a team.
    expect(loadReserved(mapPath())).toMatchObject({ blocks: {}, refused: { reason: 'cap' } })
  })

  it('blocks reserved for another team or account are replaced, never numbered from', async () => {
    mkdirSync(join(cwd, STORE_DIR), { recursive: true })
    writeFileSync(
      join(cwd, STORE_DIR, RESERVED_FILE),
      JSON.stringify({
        version: 1,
        instance: INSTANCE,
        account: 'someone-else@example.test',
        teamId: 'team-1',
        blocks: { __FN__: { start: 5001, end: 5500 } },
      })
    )
    const id = await teamMap({ __FN__40: 'chargeCard' })
    await run(['maps', 'pull', id])
    const r = loadReserved(mapPath())!
    expect(r.account).toBe(ME)
    expect(blockRequests()).toHaveLength(1)
  })
})

describe('a block is taken only from a sane answer', () => {
  it.each([
    ['no ranges', {}],
    ['a run below the map', { ranges: [{ base: '__FN__', start: 3, end: 502 }] }],
    ['a run for a kind not asked for', { ranges: [{ base: '__X__', start: 100, end: 599 }] }],
  ])('%s: no block in reserved.json, and the pull still succeeds', async (_why, body) => {
    const real = cloud.fetch
    vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) =>
      String(url).endsWith('/placeholders/reserve')
        ? new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        : real(url, init)
    )
    const id = await teamMap({ __FN__40: 'chargeCard' })
    // Only __FN__ is in the map; the core kinds are asked for too, so the
    // answers above are short or wrong either way.
    const res = await run(['maps', 'pull', id])
    expect(res.code, res.err).toBe(EXIT_OK)
    expect(res.out).toMatch(/could not reserve/i)
    expect(loadReserved(mapPath())).toMatchObject({ blocks: {}, refused: { reason: 'server' } })
  })
})

describe('team unlock reserves a block for a project that already has a map', () => {
  beforeEach(async () => {
    await cloud.withVault()
    await cloud.withKeypair()
  })

  it('a project with a map gets blocks above it', async () => {
    mkdirSync(join(cwd, STORE_DIR), { recursive: true })
    writeFileSync(mapPath(), JSON.stringify({ version: 1, map: { __VAR__12: 'amount' } }))
    const res = await run(['team', 'unlock'])
    expect(res.code, res.err).toBe(EXIT_OK)
    expect(loadReserved(mapPath())!.blocks.__VAR__.start).toBeGreaterThan(12)
  })

  it('a directory with no map reserves nothing (and creates no store)', async () => {
    const res = await run(['team', 'unlock'])
    expect(res.code, res.err).toBe(EXIT_OK)
    expect(blockRequests()).toHaveLength(0)
    expect(existsSync(join(cwd, STORE_DIR))).toBe(false)
  })
})
