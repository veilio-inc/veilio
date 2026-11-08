import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  decryptTeamMap,
  importTeamKey,
  isLocalPlaceholder,
  localFamilyNote,
  toBase64,
  type TeamMapEnvelope,
} from '@veilio-inc/engine'
import { main } from '../src/index.js'
import { EXIT_OK, type Io } from '../src/commands.js'
import { STORE_DIR, STORE_FILE, loadMap } from '../src/store.js'
import { RESERVED_FILE, loadAliases } from '../src/reservations.js'
import {
  FakeCloud,
  PASSPHRASE,
  TEAMMATE,
  TEAM_RAW,
  sealTeam,
  signIn,
} from './helpers/fake-cloud.js'

/**
 * Spec 066 US1, the spec's own independent test: a member whose reservation
 * is refused numbers new names in the local family, so a teammate holding the
 * block that starts at the map's highest + 1 never reads that member's text as
 * their own. In the spec 065 benchmark `__CLS__10088` meant a JDK class to the
 * owner and a temp-directory suffix to member m1.
 *
 * Two members, each with their own home and checkout, against one Cloud.
 */

type Member = { home: string; cwd: string }
let a: Member
let b: Member
let cloud: FakeCloud

const member = (name: string): Member => {
  const home = mkdtempSync(join(tmpdir(), `veilio-us1-${name}-home-`))
  const cwd = mkdtempSync(join(tmpdir(), `veilio-us1-${name}-work-`))
  mkdirSync(join(cwd, '.git'), { recursive: true })
  signIn(home, { team: true })
  return { home, cwd }
}

beforeEach(() => {
  cloud = new FakeCloud()
  cloud.recordsReservations = true
  vi.stubGlobal('fetch', cloud.fetch)
  a = member('a')
  b = member('b')
})
afterEach(() => {
  vi.unstubAllGlobals()
  for (const m of [a, b]) {
    rmSync(m.home, { recursive: true, force: true })
    rmSync(m.cwd, { recursive: true, force: true })
  }
})

async function run(
  m: Member,
  argv: string[],
  stdin = ''
): Promise<{ code: number; out: string; err: string }> {
  let out = ''
  let err = ''
  const io: Io = {
    cwd: m.cwd,
    home: m.home,
    stdin: async () => stdin,
    stdinBytes: async () => Buffer.from(stdin),
    stdout: (t) => (out += t),
    stderr: (t) => (err += t),
    prompt: async () => '',
    password: async () => PASSPHRASE,
  }
  return { code: await main(argv, io), out, err }
}

const mapPath = (m: Member) => join(m.cwd, STORE_DIR, STORE_FILE)
const reserved = (m: Member) =>
  JSON.parse(readFileSync(join(m.cwd, STORE_DIR, RESERVED_FILE), 'utf8')) as {
    blocks: Record<string, { start: number; end: number }>
    local?: { tag?: string }
    refused?: { reason?: string }
  }

async function scrub(m: Member, file: string, code: string): Promise<string> {
  writeFileSync(join(m.cwd, file), code)
  const res = await run(m, ['scrub', file])
  expect(res.code, res.err).toBe(EXIT_OK)
  return res.out
}

async function published(id: string): Promise<Record<string, string>> {
  return decryptTeamMap(
    await importTeamKey(toBase64(TEAM_RAW)),
    JSON.parse(cloud.find(id)!.map_data) as TeamMapEnvelope
  )
}
const pushedId = (out: string) => /as (\S+)/.exec(out)?.[1] ?? ''

/** The team's map everyone starts from: highest `__VAR__` is 1. */
async function sharedMap(): Promise<string> {
  return cloud.add({
    owner: TEAMMATE,
    scope: 'team',
    name: 'shared',
    map_data: await sealTeam({ __VAR__1: 'amount', __FN__1: 'chargeCard', __CLS__1: 'Ledger' }),
  }).id
}

describe('spec 066 US1: a name numbered without a block is never read as a teammate’s', () => {
  it('A refused, B holding the next block: B never gets B’s name back from A’s text', async () => {
    const shared = await sharedMap()

    // A's reservation is refused (the day's cap).
    cloud.blocksRefused = true
    expect((await run(a, ['maps', 'pull', shared])).code).toBe(EXIT_OK)
    const tag = reserved(a).local?.tag
    expect(tag).toMatch(/^[A-Z0-9]{6}$/)
    expect(reserved(a).refused?.reason).toBe('cap')

    // B holds the block that starts at the map's highest + 1, and mints there.
    cloud.blocksRefused = false
    expect((await run(b, ['maps', 'pull', shared])).code).toBe(EXIT_OK)
    expect(reserved(b).blocks.__VAR__.start).toBe(2)
    await scrub(b, 'b.ts', 'export const payoutCutoff = amount\n')
    expect(loadMap(mapPath(b)).__VAR__2).toBe('payoutCutoff')

    // A mints a new name through a signed-in `veilio scrub`.
    const aText = await scrub(a, 'a.ts', 'export const holdbackDays = amount\n')
    const local = `__LOCAL_${tag}_VAR__1`
    expect(aText).toContain(local)
    expect(aText).not.toMatch(/__VAR__2(?!\d)/)

    // B publishes the name at its block's start.
    const bPush = await run(b, ['maps', 'push', '--team', 'b-map'])
    expect(bPush.code, bPush.err).toBe(EXIT_OK)
    expect(await published(pushedId(bPush.out))).toMatchObject({ __VAR__2: 'payoutCutoff' })

    // B restores A's text: A's placeholder is left as written and named.
    const bRestore = await run(b, ['restore'], aText)
    expect(bRestore.code, bRestore.err).toBe(EXIT_OK)
    expect(bRestore.out).not.toContain('payoutCutoff')
    expect(bRestore.out).not.toContain('holdbackDays')
    expect(bRestore.out).toContain(local)
    expect(bRestore.err).toContain(localFamilyNote([local]))
    // Counted as left: --strict refuses to write it.
    const strict = await run(b, ['restore', '--strict'], aText)
    expect(strict.out).toBe('')
    expect(strict.err).toContain(local)

    // A's own restore gives A's name.
    const aRestore = await run(a, ['restore'], aText)
    expect(aRestore.out).toContain('holdbackDays')

    // A publishes once a reservation succeeds: a team number, the alias kept,
    // and no local key in what was sealed.
    const aPush = await run(a, ['maps', 'push', '--team', 'a-map'])
    expect(aPush.code, aPush.err).toBe(EXIT_OK)
    const sealed = await published(pushedId(aPush.out))
    expect(Object.keys(sealed).filter(isLocalPlaceholder)).toEqual([])
    const [renumbered] = Object.entries(sealed).find(([, n]) => n === 'holdbackDays') ?? []
    expect(renumbered).toMatch(/^__VAR__\d+$/)
    expect(Number(renumbered!.slice('__VAR__'.length))).toBeGreaterThan(501)
    expect(loadAliases(mapPath(a))).toMatchObject({ [local]: 'holdbackDays' })
    expect(Object.keys(loadMap(mapPath(a))).filter(isLocalPlaceholder)).toEqual([])
    expect((await run(a, ['restore'], aText)).out).toContain('holdbackDays')
  })

  it('A and B both refused: neither ever restores the other’s local placeholder', async () => {
    const shared = await sharedMap()
    cloud.blocksRefused = true
    expect((await run(a, ['maps', 'pull', shared])).code).toBe(EXIT_OK)
    expect((await run(b, ['maps', 'pull', shared])).code).toBe(EXIT_OK)
    const tagA = reserved(a).local!.tag!
    const tagB = reserved(b).local!.tag!
    expect(tagA).not.toBe(tagB)

    const aText = await scrub(a, 'a.ts', 'export const holdbackDays = amount\n')
    const bText = await scrub(b, 'b.ts', 'export const payoutCutoff = amount\n')
    expect(aText).toContain(`__LOCAL_${tagA}_VAR__1`)
    expect(bText).toContain(`__LOCAL_${tagB}_VAR__1`)

    const bReadsA = await run(b, ['restore'], aText)
    expect(bReadsA.out).not.toContain('payoutCutoff')
    expect(bReadsA.out).toContain(`__LOCAL_${tagA}_VAR__1`)
    const aReadsB = await run(a, ['restore'], bText)
    expect(aReadsB.out).not.toContain('holdbackDays')
    expect(aReadsB.out).toContain(`__LOCAL_${tagB}_VAR__1`)
    // Each one's own restore still works.
    expect((await run(a, ['restore'], aText)).out).toContain('holdbackDays')
    expect((await run(b, ['restore'], bText)).out).toContain('payoutCutoff')
  })
})
