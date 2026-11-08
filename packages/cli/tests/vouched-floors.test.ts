import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { main } from '../src/index.js'
import { EXIT_OK, type Io } from '../src/commands.js'
import { STORE_DIR, STORE_FILE, saveMap } from '../src/store.js'
import { loadReserved } from '../src/reservations.js'
import { ensureBlocks } from '../src/client/blocks.js'
import { readReservationsFor, reservePlaceholders } from '../src/cloud.js'
import { resolveTeamNamespace } from '../src/team-namespace.js'
import { wireBase } from '../src/hashed-bases.js'
import { readCredential } from '../src/credential.js'
import {
  FakeCloud,
  PASSPHRASE,
  TEAMMATE,
  TEAM_ID,
  TEAM_RAW,
  sealTeam,
  signIn,
} from './helpers/fake-cloud.js'

// Security review, round 4 (D, E): a floor counts only numbers inside a run
// the server issued. A map holding a planted __VAR__60000 while the team's
// counter is far below once made every teammate's reservation fail with 400
// FLOOR_TOO_FAR. Now it floors nothing; restore leaves it, being above every
// number issued for its kind; and a base the server still refuses falls to
// the local family alone while the other bases reserve.

let home: string
let cwd: string
let cloud: FakeCloud

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'veilio-vouch-home-'))
  cwd = mkdtempSync(join(tmpdir(), 'veilio-vouch-work-'))
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
const credential = () => readCredential(home)!
const reserveBodies = () =>
  cloud.requests
    .filter((r) => r.path.endsWith('/placeholders/reserve'))
    .map((r) => r.body as { requests: { base: string; floor: number }[]; partial?: boolean })
const sent = () => cloud.requests.map((r) => `${r.method} ${r.path}?${r.query} ${r.raw}`).join('\n')

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
    stdinBytes: async () => Buffer.from(stdin),
    stdout: (t) => (out += t),
    stderr: (t) => (err += t),
    prompt: async () => '',
    password: async () => PASSPHRASE,
  }
  return { code: await main(argv, io), out, err }
}

async function teamMap(map: Record<string, string>): Promise<string> {
  return cloud.add({
    owner: TEAMMATE,
    scope: 'team',
    name: 'shared',
    map_data: await sealTeam(map),
  }).id
}

describe('the hostile map', () => {
  beforeEach(() => {
    // The team has issued __VAR__1-500 and __FN__1-500; the counter is far below 50000.
    cloud.counters.set('__VAR__', 500)
    cloud.counters.set('__FN__', 500)
    cloud.reservations.push(
      { base: '__VAR__', start: 1, end: 500, member: cloud.idOf(TEAMMATE) },
      { base: '__FN__', start: 1, end: 500, member: cloud.idOf(TEAMMATE) }
    )
  })

  it('a pull still reserves every block, floored by issued numbers only, and says so', async () => {
    const id = await teamMap({ __VAR__60000: 'planted', __VAR__7: 'amount', __FN__3: 'settle' })
    const res = await run(['maps', 'pull', id])
    expect(res.code, res.err).toBe(EXIT_OK)
    const blocks = loadReserved(mapPath())!.blocks
    expect(blocks.__VAR__!.start).toBe(501)
    expect(loadReserved(mapPath())!.refused).toBeUndefined()
    for (const body of reserveBodies()) {
      expect(body.partial).toBe(true)
      for (const r of body.requests) expect(r.floor).toBeLessThanOrEqual(500)
    }
    expect(res.out).toMatch(/1 placeholder in this map is numbered outside every run/)
  })

  // Security audit (round 4): the block was saved but unusable - the engine
  // numbered above the planted 60000, past the block, so every name went local.
  it('a scrub after that pull numbers inside the block, not in the local family', async () => {
    const id = await teamMap({ __VAR__60000: 'planted', __VAR__7: 'amount', __FN__3: 'settle' })
    expect((await run(['maps', 'pull', id])).code).toBe(EXIT_OK)
    writeFileSync(join(cwd, 'a.ts'), 'function quaywardSettle(skerryTotal: number) {}\n')
    const res = await run(['scrub', 'a.ts'])
    expect(res.code, res.err).toBe(EXIT_OK)
    expect(res.out).toMatch(/__VAR__5\d\d\b/)
    expect(res.out).not.toContain('__LOCAL_')
  })

  it('the namespace floors nothing on it, and restore leaves it', async () => {
    await teamMap({ __VAR__60000: 'planted', __VAR__7: 'amount' })
    const found = await resolveTeamNamespace(home)
    expect(found.status).toBe('team')
    if (found.status !== 'team') return
    expect(found.analysis.highest.__VAR__).toBe(7)
    expect(found.unissued).toEqual(['__VAR__60000'])
    expect(found.unvouched).toBe(1)
    expect(found.analysis.conflicts.__VAR__60000).toBeGreaterThan(0)

    saveMap(mapPath(), { __CLS__1: 'Ledger' }, { force: true })
    const res = await run(['restore'], 'const a = __VAR__7 + __VAR__60000\n')
    expect(res.out).toContain('const a = amount + __VAR__60000')
    expect(res.err).toMatch(
      /left as is: __VAR__60000\. Its number is above every number the server/
    )
  })

  it("the server's `highest` is the threshold: at or below it, restore does not leave it", async () => {
    cloud.counters.set('__VAR__', 70_000)
    await teamMap({ __VAR__60000: 'planted' })
    const found = await resolveTeamNamespace(home)
    if (found.status !== 'team') throw new Error(found.status)
    expect(found.unissued).toBeUndefined()
    expect(found.analysis.conflicts.__VAR__60000).toBeUndefined()
  })

  it('a number at or below the issued highest, in no run, restores as before', async () => {
    cloud.reservations.splice(0, cloud.reservations.length, {
      base: '__VAR__',
      start: 400,
      end: 500,
      member: cloud.idOf(TEAMMATE),
    })
    await teamMap({ __VAR__7: 'amount' })
    saveMap(mapPath(), { __CLS__1: 'Ledger' }, { force: true })
    const res = await run(['restore'], 'x = __VAR__7\n')
    expect(res.out).toContain('x = amount')
  })

  it('a publish renumbers the planted entry from a vouched floor', async () => {
    saveMap(mapPath(), { __VAR__60000: 'planted' }, { force: true })
    const res = await run(['maps', 'push', '--team'])
    expect(res.code, res.err).toBe(EXIT_OK)
    const floors = reserveBodies().flatMap((b) => b.requests.map((r) => r.floor))
    expect(Math.max(...floors)).toBeLessThanOrEqual(500)
  })
})

describe('a map numbered before the team existed', () => {
  it('floors the first run of a base never reserved, up to 10000', async () => {
    const r = await reservePlaceholders(credential(), TEAM_ID, [
      { base: '__VAR__', count: 1, floor: 42 },
      { base: '__FN__', count: 1, floor: 60_000 },
    ])
    expect(r.ranges.find((x) => x.base === '__VAR__')!.start).toBe(43)
    expect(r.ranges.find((x) => x.base === '__FN__')!.start).toBe(10_001)
    expect(r.refused).toBeUndefined()
  })

  it('a local map pushed to the team is renumbered above its own numbers', async () => {
    saveMap(mapPath(), { __VAR__5: 'amount', __VAR__7: 'total' }, { force: true })
    const res = await run(['maps', 'push', '--team'])
    expect(res.code, res.err).toBe(EXIT_OK)
    const asked = reserveBodies()[0]!.requests.find((r) => r.base === '__VAR__')!
    expect(asked.floor).toBe(7)
  })
})

describe('one refused base does not block the others', () => {
  it('the server answers per base: the refused one falls to the local family, visibly', async () => {
    cloud.refuseBases.add('__FN__')
    saveMap(mapPath(), {}, { force: true })
    const outcome = await ensureBlocks(credential(), TEAM_ID, mapPath(), home)
    expect(outcome.status).toBe('failed')
    const file = loadReserved(mapPath())!
    expect(file.blocks.__VAR__).toBeDefined()
    expect(file.blocks.__CLS__).toBeDefined()
    expect(file.blocks.__FN__).toBeUndefined()
    expect(file.refused?.detail).toMatch(/__FN__/)
  })

  it('an older server refusing all with a 400 that names the base: asked again without it', async () => {
    cloud.partialReserve = false
    cloud.refuseBases.add('__FN__')
    saveMap(mapPath(), {}, { force: true })
    await ensureBlocks(credential(), TEAM_ID, mapPath(), home)
    const file = loadReserved(mapPath())!
    expect(file.blocks.__VAR__).toBeDefined()
    expect(file.blocks.__FN__).toBeUndefined()
    expect(file.refused?.detail).toMatch(/__FN__/)
    expect(reserveBodies()).toHaveLength(2)
  })
})

describe('the filtered listing (E)', () => {
  it('asks for the bases it needs, a rule base only by its hashes, and reads `highest`', async () => {
    cloud.reservations.push({ base: '__FN__', start: 1, end: 700, member: 'x' })
    const listed = await readReservationsFor(credential(), TEAM_ID, ['__FN__'])
    expect(listed!.highest).toEqual({ __FN__: 700 })
    const q = cloud.requests.find((r) => r.path.endsWith('/placeholders/reservations'))!.query
    expect(q.get('bases')).toBe('__FN__')
  })

  it('an older server that ignores `bases` is filtered here, and floors the same', async () => {
    cloud.filteredListing = false
    cloud.reservations.push(
      { base: '__FN__', start: 1, end: 700, member: 'x' },
      { base: '__VAR__', start: 1, end: 9000, member: 'x' }
    )
    const listed = await readReservationsFor(credential(), TEAM_ID, ['__FN__'])
    expect(listed!.reservations.map((r) => r.base)).toEqual(['__FN__'])
    expect(listed!.highest).toEqual({})
  })

  it('no request URL or body carries a rule base in plain text, the listing included', async () => {
    cloud.usedVersions = 1
    const id = await teamMap({ __CODENAME__4: 'Falcon', __VAR__2: 'amount' })
    cloud.reservations.push({
      base: wireBase('__CODENAME__', TEAM_RAW),
      start: 1,
      end: 10,
      member: cloud.idOf(TEAMMATE),
    })
    const res = await run(['maps', 'pull', id])
    expect(res.code, res.err).toBe(EXIT_OK)
    expect(cloud.requests.some((r) => r.query.get('bases')?.includes('__H_'))).toBe(true)
    expect(sent()).not.toMatch(/CODENAME/)
  })
})

// The reserve and listing contract, in Cloud 86772272's exact shapes
// (specs/066-local-names-never-collide/contracts/reserve-api.md).
describe('contract: Cloud 86772272', () => {
  const stub = (answers: Record<string, { status: number; body: unknown }>) => {
    const calls: { url: string; body: unknown }[] = []
    vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
      const u = String(url)
      calls.push({ url: u, body: init?.body ? JSON.parse(String(init.body)) : null })
      const key = Object.keys(answers).find((k) => u.includes(k))!
      const a = answers[key]!
      return new Response(JSON.stringify(a.body), {
        status: a.status,
        headers: { 'content-type': 'application/json' },
      })
    })
    return calls
  }

  it('a partial answer: issued bases get their runs, each refused code goes to the refusal', async () => {
    const calls = stub({
      '/placeholders/reserve': {
        status: 200,
        body: {
          ranges: [
            { base: '__VAR__', start: 11, end: 11 },
            { base: '__FN__', refused: 'floor_too_far', message: 'too far' },
            { base: '__CLS__', refused: 'numbers_exhausted', message: 'none left' },
            { base: '__PKG__', refused: 'cap', message: 'cap', retry_at: '2026-11-02T00:00:00Z' },
          ],
        },
      },
    })
    const r = await reservePlaceholders(
      credential(),
      TEAM_ID,
      ['__VAR__', '__FN__', '__CLS__', '__PKG__'].map((base) => ({ base, count: 1, floor: 0 }))
    )
    expect(calls[0]!.body).toMatchObject({ partial: true })
    expect(r.ranges).toEqual([{ base: '__VAR__', start: 11, end: 11 }])
    expect(r.refused!.bases.sort()).toEqual(['__CLS__', '__FN__', '__PKG__'])
  })

  it('refused as a whole (400 with `refused`): asked again without those bases', async () => {
    let first = true
    const calls: unknown[] = []
    vi.stubGlobal('fetch', async (_url: string | URL, init?: RequestInit) => {
      calls.push(JSON.parse(String(init!.body)))
      const body = first
        ? {
            error: 'refused',
            refused: [{ base: '__FN__', refused: 'floor_too_high', message: 'x' }],
          }
        : { ranges: [{ base: '__VAR__', start: 1, end: 1 }] }
      const status = first ? 400 : 200
      first = false
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      })
    })
    const r = await reservePlaceholders(credential(), TEAM_ID, [
      { base: '__VAR__', count: 1, floor: 0 },
      { base: '__FN__', count: 1, floor: 0 },
    ])
    expect(calls).toHaveLength(2)
    expect((calls[1] as { requests: { base: string }[] }).requests.map((q) => q.base)).toEqual([
      '__VAR__',
    ])
    expect(r.ranges).toEqual([{ base: '__VAR__', start: 1, end: 1 }])
    expect(r.refused!.bases).toEqual(['__FN__'])
  })

  it('a 429 cap for the whole call stays a failed call, with its retry time', async () => {
    stub({
      '/placeholders/reserve': {
        status: 429,
        body: { error: 'cap', reason: 'cap', retry_at: '2026-11-02T00:00:00Z', refused: [] },
      },
    })
    await expect(
      reservePlaceholders(credential(), TEAM_ID, [{ base: '__VAR__', count: 1, floor: 0 }])
    ).rejects.toMatchObject({ status: 429 })
  })

  it('the listing: rows, `truncated` and `highest` (0 for a base with none) are read as sent', async () => {
    stub({
      '/placeholders/reservations': {
        status: 200,
        body: {
          reservations: [{ base: '__VAR__', start: 1, end: 500, member: 'u-a' }],
          truncated: ['__VAR__'],
          highest: { __VAR__: 900, __FN__: 0 },
          next: null,
        },
      },
    })
    const listed = await readReservationsFor(credential(), TEAM_ID, ['__VAR__', '__FN__'])
    expect(listed).toEqual({
      reservations: [{ base: '__VAR__', start: 1, end: 500, member: 'u-a' }],
      highest: { __VAR__: 900, __FN__: 0 },
      truncated: ['__VAR__'],
    })
  })

  it('a truncated base floors by `highest`: an unvouched floor never passes it', async () => {
    const calls = stub({
      '/placeholders/reservations': {
        status: 200,
        body: { reservations: [], truncated: ['__VAR__'], highest: { __VAR__: 900 }, next: null },
      },
      '/placeholders/reserve': {
        status: 200,
        body: { ranges: [{ base: '__VAR__', start: 901, end: 901 }] },
      },
    })
    await reservePlaceholders(credential(), TEAM_ID, [{ base: '__VAR__', count: 1, floor: 60_000 }])
    const reserve = calls.find((c) => c.url.includes('/reserve'))!
    expect((reserve.body as { requests: { floor: number }[] }).requests[0]!.floor).toBe(900)
  })

  it('more than 50 bases are listed 50 at a time', async () => {
    const calls = stub({
      '/placeholders/reservations': {
        status: 200,
        body: { reservations: [], truncated: [], highest: {}, next: null },
      },
    })
    const bases = Array.from({ length: 60 }, (_, i) => `__B${i}__`)
    await readReservationsFor(credential(), TEAM_ID, bases)
    expect(calls).toHaveLength(2)
    for (const c of calls)
      expect(new URL(c.url).searchParams.get('bases')!.split(',').length).toBeLessThanOrEqual(50)
  })
})
