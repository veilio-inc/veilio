import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { restore } from '@veilio-inc/engine'
import { main } from '../src/index.js'
import { EXIT_OK, type Io } from '../src/commands.js'
import { STORE_DIR, STORE_FILE, loadMap, saveMap } from '../src/store.js'
import { RESERVED_FILE, ReservedFileError, loadReserved } from '../src/reservations.js'
import { anonymizeAbove, anonymizeOverTeam, floorsWith } from '../src/team-anonymize.js'
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
 * Security audit: past 2^53 adding one stops changing a number, so a block,
 * a server's answer or a map key up there made two names share a
 * placeholder. Every block is whole, in [1, 1e8] and at most 10000 long; a
 * map key above 1e8 is never a floor and never numbered after.
 */

let home: string
let cwd: string
let cloud: FakeCloud
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'veilio-big-home-'))
  cwd = mkdtempSync(join(tmpdir(), 'veilio-big-work-'))
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
const SRC = 'export class PaymentProcessor { chargeCard() {} refundCard() {} voidCard() {} }\n'
async function run(
  argv: string[],
  stdin = SRC
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
const reserveBodies = () =>
  cloud.requests
    .filter((r) => r.path.endsWith('/placeholders/reserve'))
    .map((r) => r.body as { requests: { floor: number }[] })

function plant(blocks: unknown): void {
  mkdirSync(join(cwd, STORE_DIR), { recursive: true })
  writeFileSync(
    join(cwd, STORE_DIR, RESERVED_FILE),
    JSON.stringify({ version: 1, instance: INSTANCE, account: ME, teamId: 'team-1', blocks })
  )
}

describe('a planted reserved.json', () => {
  it.each([
    [{ __VAR__: { start: 2 ** 53 - 1, end: 2 ** 53 + 99 } }],
    [{ __VAR__: { start: 1e21, end: 1e21 } }],
    [{ __VAR__: { start: 1e9, end: 1e9 + 1 } }],
    [{ __VAR__: { start: 1, end: 20_000 } }],
  ])('%j is refused, never numbered from', (blocks) => {
    saveMap(mapPath(), { __VAR__1: 'x' }, { force: true })
    plant(blocks)
    expect(() => loadReserved(mapPath())).toThrow(ReservedFileError)
  })
})

describe('a server answering with huge numbers', () => {
  it('a pull keeps no block from it', async () => {
    cloud.counters.set('__VAR__', 2 ** 53 - 10)
    const id = cloud.add({
      owner: TEAMMATE,
      scope: 'team',
      name: 'shared',
      map_data: await sealTeam({ __VAR__9: 'amount', __FN__4: 'chargeCard', __CLS__2: 'Ledger' }),
    }).id
    const res = await run(['maps', 'pull', id])
    expect(res.code, res.err).toBe(EXIT_OK)
    const held = loadReserved(mapPath())
    expect(held?.blocks.__VAR__).toBeUndefined()
  })

  // Whole and safe, so the old check let it through, but above 1e8.
  const answer = (base: string) => ({ ranges: [{ base, start: 1e10, end: 1e10 + 499 }] })

  it('a publish is refused rather than renumbered there', async () => {
    cloud.failWith(200, answer('__FN__'))
    saveMap(mapPath(), { __FN__41: 'payout' }, { force: true })
    const res = await run(['maps', 'push', '--team', 'mine'])
    expect(res.code).not.toBe(EXIT_OK)
    expect(res.out + res.err).toMatch(/usable run/)
    expect(loadMap(mapPath())).toEqual({ __FN__41: 'payout' })
  })

  it('scrub --team refuses a run that high', async () => {
    cloud.failWith(200, {
      ranges: [
        { base: '__CLS__', start: 1e10, end: 1e10 + 499 },
        { base: '__FN__', start: 1e10, end: 1e10 + 499 },
      ],
    })
    const res = await run(['scrub', '--team'])
    expect(res.code).not.toBe(EXIT_OK)
    expect(res.out).not.toMatch(/__(?:FN|CLS)__10000000000/)
  })
})

describe('a map key near 2^53', () => {
  it('scrub gives each new name its own placeholder, and restore writes the right names', async () => {
    rmSync(home, { recursive: true, force: true })
    home = mkdtempSync(join(tmpdir(), 'veilio-big-solo-')) // signed out: the map numbers
    saveMap(mapPath(), { __FN__9007199254740991: 'planted' }, { force: true })
    const res = await run(['scrub'])
    expect(res.code, res.err).toBe(EXIT_OK)
    const map = loadMap(mapPath())
    expect(new Set(Object.values(map)).size).toBe(Object.keys(map).length)
    expect(restore(res.out, map).restored).toBe(SRC)
  })

  it('a team map holding one: the pull says so, and the next block is not floored there', async () => {
    const id = cloud.add({
      owner: TEAMMATE,
      scope: 'team',
      name: 'shared',
      map_data: await sealTeam({ __FN__9007199254740991: 'planted', __FN__4: 'chargeCard' }),
    }).id
    const res = await run(['maps', 'pull', id])
    expect(res.code, res.err).toBe(EXIT_OK)
    expect(res.out).toMatch(/above 100,000,000/)
    for (const body of reserveBodies())
      for (const r of body.requests) expect(r.floor).toBeLessThanOrEqual(1e8)
    expect(loadReserved(mapPath())?.blocks.__FN__?.start).toBeLessThanOrEqual(1e8)
  })
})

describe('the floors scrub and the MCP number above (security review of item 2)', () => {
  const planted = { __VAR__9007199254740991: 'planted' }
  const code = 'const ledgerAlpha = 1\nconst berthQuorum = 2\n'

  it('a planted key above 1e8 raises no floor', () => {
    expect(floorsWith({}, planted).__VAR__ ?? 0).toBe(0)
    expect(floorsWith({ __VAR__: 7 }, planted).__VAR__).toBe(7)
  })

  it('a floor above 1e8 is not seeded, and never writes over the entry already at it', () => {
    const r = anonymizeAbove(code, { existingMap: planted }, { __VAR__: 2 ** 53 - 1 })
    expect(r.map.__VAR__9007199254740991).toBe('planted')
    const fresh = Object.keys(r.map).filter((p) => !(p in planted))
    expect(fresh).toHaveLength(2)
    for (const p of fresh) expect(Number(/\d+$/.exec(p)![0])).toBeLessThanOrEqual(1e8)
    expect(restore(r.anonymized, r.map).restored).toBe(code)
  })

  it('a floor at an entry the map holds does not write over it', () => {
    const r = anonymizeAbove(code, { existingMap: { __VAR__1000: 'kept' } }, { __VAR__: 1000 })
    expect(r.map.__VAR__1000).toBe('kept')
  })

  it('anonymizeOverTeam (the MCP path) keeps a planted local entry and numbers below 1e8', () => {
    const { result } = anonymizeOverTeam(code, planted, { namespace: {}, highest: {} }, {})
    expect(result.map.__VAR__9007199254740991).toBe('planted')
    for (const p of Object.keys(result.map).filter((p) => !(p in planted)))
      expect(Number(/\d+$/.exec(p)![0])).toBeLessThanOrEqual(1e8)
  })
})

// Cloud 450a93ce: the server caps placeholder numbers at 1e8, and refuses a
// floor more than 10000 above the base's counter. A number above 1e8 is never
// a floor and never sent; a floor the server refuses leaves the member in the
// local family, and the refusal is recorded for the band.
describe('the server caps numbers at 1e8 (Cloud 450a93ce)', () => {
  const credential = { token: 'tok', account: ME, instance: INSTANCE }
  const TEAM = 'team-1'

  it('a pasted __FN__100000001 is no floor: nothing above 1e8 is sent', async () => {
    const { ensureBlocks } = await import('../src/client/blocks.js')
    saveMap(mapPath(), { __FN__100000001: 'pasted' }, { force: true })
    const outcome = await ensureBlocks(credential, TEAM, mapPath(), home)
    expect(outcome.status).toBe('reserved')
    for (const body of reserveBodies())
      for (const r of body.requests) expect(r.floor).toBeLessThanOrEqual(1e8)
    expect(floorsWith({}, { __FN__100000001: 'pasted' }).__FN__ ?? 0).toBe(0)
  })

  // Round 4 (D): a number no run the server issued vouches for floors
  // nothing; a base never reserved keeps at most 10000 of it.
  it('a pasted __FN__99999999 is unvouched: it floors nothing, and the block is reserved', async () => {
    const { ensureBlocks } = await import('../src/client/blocks.js')
    saveMap(mapPath(), { __FN__99999999: 'pasted' }, { force: true })
    const outcome = await ensureBlocks(credential, TEAM, mapPath(), home)
    expect(outcome).toMatchObject({ status: 'reserved' })
    for (const body of reserveBodies())
      for (const r of body.requests) expect(r.floor).toBeLessThanOrEqual(10_000)
    const file = loadReserved(mapPath())!
    expect(file.refused).toBeUndefined()
    expect(file.blocks.__FN__!.start).toBeLessThanOrEqual(10_001)
  })

  it('no block reaching past 1e8 is trusted', async () => {
    const { isSaneBlock, MAX_PLACEHOLDER_NUMBER } = await import('@veilio-inc/engine')
    expect(MAX_PLACEHOLDER_NUMBER).toBe(1e8)
    expect(isSaneBlock({ start: 1e8 - 10, end: 1e8 })).toBe(true)
    expect(isSaneBlock({ start: 1e8, end: 1e8 + 1 })).toBe(false)
  })
})
