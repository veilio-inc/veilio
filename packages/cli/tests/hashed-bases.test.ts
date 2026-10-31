import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { toBase64, type CustomRule } from '@veilio-inc/engine'
import { main } from '../src/index.js'
import { EXIT_OK, type Io } from '../src/commands.js'
import { STORE_DIR, STORE_FILE, loadMap, saveMap } from '../src/store.js'
import { writeRules } from '../src/rules.js'
import { writeTeamUnlock } from '../src/team-unlock.js'
import { wireBase } from '../src/hashed-bases.js'
import { reservePlaceholders } from '../src/cloud.js'
import {
  FakeCloud,
  INSTANCE,
  ME,
  PASSPHRASE,
  TEAM_ID,
  TEAM_RAW,
  signIn,
} from './helpers/fake-cloud.js'

/**
 * Founder decision (Cloud audit M1): a custom rule's placeholder base never
 * reaches the server in plain text. Reserving numbers for one sends
 * `__H_<16 hex of HMAC-SHA256(team key, base)>__`; the engine's own bases
 * (`__VAR__`, `__FN__`, ...) go as they are. reserved.json and the map keep the
 * real base.
 */

const RULE: CustomRule = {
  id: 'r1',
  scope: 'team',
  team_id: TEAM_ID,
  sort_order: 0,
  name: 'codename',
  type: 'replace',
  pattern: '^acme',
  placeholder: '__CODENAME__',
  enabled: true,
}
const SRC = 'export function acmeLaunch() {}\nexport const acmeTarget = settleLedger()\n'
const OTHER_RAW = new Uint8Array(32).fill(9)

let home: string
let cwd: string
let cloud: FakeCloud
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'veilio-hb-home-'))
  cwd = mkdtempSync(join(tmpdir(), 'veilio-hb-work-'))
  mkdirSync(join(cwd, '.git'), { recursive: true })
  cloud = new FakeCloud()
  cloud.recordsReservations = true
  vi.stubGlobal('fetch', cloud.fetch)
  signIn(home, { team: true, pmk: true })
  writeRules(
    { instance: INSTANCE, account: ME, pulledAt: new Date().toISOString(), rules: [RULE] },
    home
  )
})
afterEach(() => {
  vi.unstubAllGlobals()
  rmSync(home, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
})

const mapPath = (): string => join(cwd, STORE_DIR, STORE_FILE)
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
    stdout: (t) => (out += t),
    stderr: (t) => (err += t),
    prompt: async () => '',
    password: async () => PASSPHRASE,
  }
  return { code: await main(argv, io), out, err }
}
const sent = () => cloud.requests.map((r) => `${r.method} ${r.path}?${r.query} ${r.raw}`).join('\n')

describe('wireBase', () => {
  it('hashes a rule base under the team key; the engine bases go as they are', () => {
    const h = wireBase('__CODENAME__', TEAM_RAW)
    expect(h).toMatch(/^__H_[0-9A-F]{16}__$/)
    // The server's base check (teams.ts reserveSchema).
    expect(h).toMatch(/^__[A-Z][A-Z0-9_]*__$/)
    expect(h.length).toBeLessThanOrEqual(80)
    // Two members holding the same team key send the same base.
    expect(wireBase('__CODENAME__', new Uint8Array(TEAM_RAW))).toBe(h)
    expect(wireBase('__CODENAME__', OTHER_RAW)).not.toBe(h)
    for (const base of ['__VAR__', '__FN__', '__CLS__', '__STR__', '__PKG__'])
      expect(wireBase(base, TEAM_RAW)).toBe(base)
  })
})

describe('reservePlaceholders without the team key', () => {
  it('refuses a rule base rather than send it in plain text, and sends nothing', async () => {
    const credential = { token: 'tok', account: ME, instance: INSTANCE }
    await expect(
      reservePlaceholders(credential, TEAM_ID, [{ base: '__CODENAME__', count: 1, floor: 0 }])
    ).rejects.toThrow(/team key is not unlocked/)
    expect(cloud.requests).toHaveLength(0)
    // An engine base needs no key.
    const r = await reservePlaceholders(credential, TEAM_ID, [
      { base: '__FN__', count: 1, floor: 0 },
    ])
    expect(r.ranges[0]?.base).toBe('__FN__')
  })
})

describe('a replace rule base and the server', () => {
  it('scrub --team, publish and pull never send __CODENAME__ in plain text', async () => {
    const scrubbed = await run(['scrub', '--team'])
    expect(scrubbed.code, scrubbed.err).toBe(EXIT_OK)
    expect(scrubbed.out).toMatch(/__CODENAME__\d+/)
    expect(scrubbed.out).not.toContain('acme')

    const pushed = await run(['maps', 'push', '--team', 'mine'])
    expect(pushed.code, pushed.err).toBe(EXIT_OK)
    // The entries are inside this member's own (hashed) reservations: not moved.
    expect(pushed.out + pushed.err).not.toMatch(/renumbered [1-9]/i)
    const id = /as (\S+)/.exec(pushed.out)?.[1] ?? ''

    const pulled = await run(['maps', 'pull', id, '--force'])
    expect(pulled.code, pulled.err).toBe(EXIT_OK)

    expect(sent()).not.toMatch(/CODENAME/)
    const hashed = wireBase('__CODENAME__', TEAM_RAW)
    expect(cloud.reservations.some((r) => r.base === hashed)).toBe(true)
    expect(cloud.reservations.some((r) => r.base === '__FN__')).toBe(true)
    // Locally the real base.
    expect(Object.keys(loadMap(mapPath())).some((p) => p.startsWith('__CODENAME__'))).toBe(true)
  })

  it('after a key rotation the hash changes, and numbering stays above the existing numbers', async () => {
    saveMap(mapPath(), { __CODENAME__7: 'acmeOld' }, { force: true })
    writeTeamUnlock(
      {
        v: 1,
        instance: INSTANCE,
        account: ME,
        teamId: TEAM_ID,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        keys: [
          { version: 1, key: toBase64(TEAM_RAW) },
          { version: 2, key: toBase64(OTHER_RAW) },
        ],
      },
      home
    )
    const res = await run(['scrub', '--team'], 'export function acmeNew() {}\n')
    expect(res.code, res.err).toBe(EXIT_OK)
    const n = Number(/__CODENAME__(\d+)/.exec(res.out)?.[1])
    expect(n).toBeGreaterThan(7)
    expect(cloud.reservations.some((r) => r.base === wireBase('__CODENAME__', OTHER_RAW))).toBe(
      true
    )
    expect(sent()).not.toMatch(/CODENAME/)
  })
})

// Security review of round 1: the server numbers per (team, base), so a block
// reserved under the plain base (an older CLI) or under the old key's hash
// (before a rotation) is invisible to the new hash's counter. A hashed
// reservation is floored above every hashed and plain reservation the team holds.
describe('a hashed base and the numbers the team already holds', () => {
  const credential = { token: 'tok', account: ME, instance: INSTANCE }
  const ask = (floor = 0) => [{ base: '__CODENAME__', count: 500, floor }]

  it('after a rotation the new hash starts above the old hash’s block', async () => {
    const a = await reservePlaceholders(credential, TEAM_ID, ask(), undefined, { keys: [TEAM_RAW] })
    expect(a.ranges[0]).toMatchObject({ start: 1, end: 500 })
    const b = await reservePlaceholders(credential, TEAM_ID, ask(), undefined, {
      keys: [OTHER_RAW, TEAM_RAW],
    })
    expect(b.ranges[0]!.start).toBeGreaterThan(500)
  })

  it('a block an older CLI reserved under the plain base floors the hashed one', async () => {
    cloud.reservations.push({ base: '__CODENAME__', start: 1, end: 500, member: 'old-cli' })
    const r = await reservePlaceholders(credential, TEAM_ID, ask(), undefined, { keys: [TEAM_RAW] })
    expect(r.ranges[0]!.start).toBeGreaterThan(500)
    // The plain base is read from the listing, never sent.
    expect(sent()).not.toMatch(/CODENAME/)
  })

  it('the reservations a caller already holds are used, not fetched again', async () => {
    const r = await reservePlaceholders(credential, TEAM_ID, ask(), undefined, {
      keys: [TEAM_RAW],
      reservations: [{ base: '__H_0000000000000000__', start: 1, end: 900, member: 'x' }],
    })
    expect(r.ranges[0]!.start).toBeGreaterThan(900)
    expect(cloud.requests.some((q) => q.path.endsWith('/placeholders/reservations'))).toBe(false)
  })

  it('an engine base needs no listing', async () => {
    await reservePlaceholders(credential, TEAM_ID, [{ base: '__FN__', count: 1, floor: 0 }])
    expect(cloud.requests.some((q) => q.path.endsWith('/placeholders/reservations'))).toBe(false)
  })

  it('without the listing a hashed base is not reserved: nothing is sent to reserve', async () => {
    cloud.recordsReservations = false
    await expect(
      reservePlaceholders(credential, TEAM_ID, ask(), undefined, { keys: [TEAM_RAW] })
    ).rejects.toThrow()
    expect(cloud.requests.some((q) => q.path.endsWith('/placeholders/reserve'))).toBe(false)
  })
})
