import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { main } from '../src/index.js'
import { EXIT_OK, type Io } from '../src/commands.js'
import { STORE_DIR, STORE_FILE } from '../src/store.js'
import { RESERVED_FILE } from '../src/reservations.js'
import {
  FakeCloud,
  INSTANCE,
  ME,
  PASSPHRASE,
  TEAMMATE,
  TEAM_ID,
  sealTeam,
  signIn,
} from './helpers/fake-cloud.js'

/**
 * Spec 066 US2 (FR-005, R7-R8): a refused reservation is seen where the member
 * works. `maps pull` and `team unlock` say it on their normal output, with the
 * reason, the local time of the next block where the server gave one, and
 * what follows; the command still succeeds. In the spec 065 benchmark the
 * refusal went to stderr and nobody read it.
 */

let home: string
let cwd: string
let cloud: FakeCloud
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'veilio-rv-home-'))
  cwd = mkdtempSync(join(tmpdir(), 'veilio-rv-work-'))
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
const mapPath = () => join(cwd, STORE_DIR, STORE_FILE)
async function run(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = ''
  let err = ''
  const io: Io = {
    cwd,
    home,
    stdin: async () => '',
    stdinBytes: async () => Buffer.from(''),
    stdout: (t) => (out += t),
    stderr: (t) => (err += t),
    prompt: async () => '',
    password: async () => PASSPHRASE,
  }
  return { code: await main(argv, io), out, err }
}
const tag = () =>
  (
    JSON.parse(readFileSync(join(cwd, STORE_DIR, RESERVED_FILE), 'utf8')) as {
      local: { tag: string }
    }
  ).local.tag
const hhmm = (iso: string) => {
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
const CONSEQUENCE = (t: string) =>
  `New names are numbered on this machine as __LOCAL_${t}_… until a block is held; your next publish gives them team numbers.`

const cases: [string, () => void, RegExp][] = [
  [
    'the day’s cap (429)',
    () => (cloud.blocksRefused = true),
    /this account's daily limit for this team is reached; the next block is possible at \d{2}:\d{2} \(local time\)/,
  ],
  [
    'payment (402)',
    () => cloud.failWith(402, { error: 'plan lapsed', paywall: true }),
    /the team's plan is not active/,
  ],
  ['offline', () => cloud.failWith('network'), /Veilio Cloud could not be reached/],
  ['a server error (500)', () => cloud.failWith(500, { error: 'boom' }), /: boom\./],
]

describe('maps pull says a refused reservation on stdout', () => {
  it.each(cases)('%s: the reason and the consequence, exit 0', async (_, arrange, reason) => {
    const id = cloud.add({
      owner: TEAMMATE,
      scope: 'team',
      name: 'shared',
      map_data: await sealTeam({ __FN__40: 'chargeCard' }),
    }).id
    arrange()
    const res = await run(['maps', 'pull', id])
    expect(res.code, res.err).toBe(EXIT_OK)
    expect(res.out).toMatch(/could not reserve team numbers: /)
    expect(res.out).toMatch(reason)
    expect(res.out).toContain(CONSEQUENCE(tag()))
    expect(res.err).not.toMatch(/could not reserve/)
  })

  it('the next block’s time is the server’s retry_at, in local time', async () => {
    cloud.blocksRefused = true
    cloud.blocksRetryAt = '2026-11-02T09:14:00.000Z'
    const id = cloud.add({ owner: TEAMMATE, scope: 'team', map_data: await sealTeam({}) }).id
    const res = await run(['maps', 'pull', id])
    expect(res.out).toContain(
      `the next block is possible at ${hhmm('2026-11-02T09:14:00.000Z')} (local time)`
    )
  })

  it('a server detail cannot put control characters on the terminal', async () => {
    cloud.failWith(500, { error: 'boom\u001b[2J' })
    const id = cloud.add({ owner: TEAMMATE, scope: 'team', map_data: await sealTeam({}) }).id
    const res = await run(['maps', 'pull', id])
    // eslint-disable-next-line no-control-regex -- matching control characters is the point
    expect(res.out).not.toMatch(/\u001b/)
  })
})

describe('team unlock says a refused reservation on stdout', () => {
  beforeEach(async () => {
    await cloud.withVault()
    await cloud.withKeypair()
    mkdirSync(join(cwd, STORE_DIR), { recursive: true })
    writeFileSync(mapPath(), JSON.stringify({ version: 1, map: { __VAR__12: 'amount' } }))
  })
  it.each(cases)('%s: the reason and the consequence, exit 0', async (_, arrange, reason) => {
    arrange()
    const res = await run(['team', 'unlock'])
    expect(res.code, res.err).toBe(EXIT_OK)
    expect(res.out).toMatch(reason)
    expect(res.out).toContain(CONSEQUENCE(tag()))
    expect(res.err).not.toMatch(/could not reserve/)
  })
})

describe('signed-in scrub says it while reserved.json holds a refusal', () => {
  const reserved = (refused?: Record<string, unknown>) =>
    writeFileSync(
      join(cwd, STORE_DIR, RESERVED_FILE),
      JSON.stringify({
        version: 1,
        instance: INSTANCE,
        account: ME,
        teamId: TEAM_ID,
        blocks: {},
        local: { tag: 'K7Q2XA' },
        ...(refused ? { refused } : {}),
      })
    )
  beforeEach(() => {
    mkdirSync(join(cwd, STORE_DIR), { recursive: true })
    writeFileSync(join(cwd, 'a.ts'), 'export const holdbackDays = 3\n')
  })

  it.each([[[] as string[]], [['--quiet']]])('on stderr, %j included', async (flags) => {
    reserved({ reason: 'offline', at: '2026-10-31T10:00:00.000Z' })
    const res = await run(['scrub', ...flags, 'a.ts'])
    expect(res.code).toBe(EXIT_OK)
    expect(res.err).toContain(
      `could not reserve team numbers: Veilio Cloud could not be reached. ${CONSEQUENCE('K7Q2XA')}`
    )
    expect(res.out).not.toMatch(/could not reserve/)
  })

  it('without a refusal, nothing is said', async () => {
    reserved()
    const res = await run(['scrub', 'a.ts'])
    expect(res.err).not.toMatch(/could not reserve/)
  })
})

describe('the server’s words cannot reorder or hide what the terminal shows (code review)', () => {
  it('Unicode format characters in the server’s error are replaced', async () => {
    cloud.failWith(500, { error: 'boom\u202Eevil\u2066x\u200By\u200Fz' })
    const id = cloud.add({ owner: TEAMMATE, scope: 'team', map_data: await sealTeam({}) }).id
    const res = await run(['maps', 'pull', id])
    expect(res.out).toContain('boom?evil?x?y?z')
    expect(res.out).not.toMatch(/\p{Cf}/u)
  })
})
