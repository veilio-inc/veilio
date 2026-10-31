import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { main } from '../src/index.js'
import { EXIT_OK, type Io } from '../src/commands.js'
import { loadMap, resolveMapPath, saveMap } from '../src/store.js'
import { FakeCloud, PASSPHRASE, TEAMMATE, sealTeam, signIn } from './helpers/fake-cloud.js'

/**
 * Code review of spec 066 (FR-001), the re-review's repro: a signed-in team
 * member, a fresh clone with no reserved.json, no team unlock on this machine
 * (lapsed after 7 days, or never made), and Cloud unreachable. Scrub numbered
 * above the project's map - the next teammate's block. A signed-in run now
 * never does: the team id last seen is kept beside the credential, and with
 * none ever seen new names still take a local family under a session tag.
 */
let home: string
let cloud: FakeCloud
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'veilio-stu-home-'))
  cloud = new FakeCloud()
  vi.stubGlobal('fetch', cloud.fetch)
})
afterEach(() => {
  vi.unstubAllGlobals()
  rmSync(home, { recursive: true, force: true })
})
const unreachable = () =>
  vi.stubGlobal('fetch', async () => {
    throw new TypeError('fetch failed')
  })

async function scrub(cwd: string, argv = ['scrub', 'a.ts']) {
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
  const code = await main(argv, io)
  return { code, out, err }
}
function clone(): { cwd: string; mapPath: string; reserved: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'veilio-stu-work-'))
  mkdirSync(join(cwd, '.git'))
  writeFileSync(join(cwd, 'a.ts'), 'export function reverseEntry() {}\n')
  const mapPath = resolveMapPath(null, cwd)
  saveMap(mapPath, { __FN__3: 'settleInvoice' })
  return { cwd, mapPath, reserved: join(dirname(mapPath), 'reserved.json') }
}
const fresh = (mapPath: string) => Object.keys(loadMap(mapPath)).filter((p) => p !== '__FN__3')

describe('signed in, no unlock, no reserved.json, Cloud unreachable', () => {
  it('with the team seen before: local under a tag kept in a new reserved.json for that team', async () => {
    signIn(home) // no team unlock on this machine
    cloud.add({
      owner: TEAMMATE,
      scope: 'team',
      map_data: await sealTeam({ __FN__3: 'settleInvoice' }),
    })
    // Reachable once: the account's team is learned (here, as locked).
    expect((await scrub(clone().cwd)).code).toBe(EXIT_OK)
    const record = join(home, '.veilio', 'team.json')
    expect(existsSync(record)).toBe(true)
    expect(statSync(record).mode & 0o777).toBe(0o600)

    unreachable()
    const c = clone()
    const r = await scrub(c.cwd)
    expect(r.code, r.err).toBe(EXIT_OK)
    expect(r.out).not.toMatch(/__FN__4\b/)
    expect(fresh(c.mapPath)).toEqual([expect.stringMatching(/^__LOCAL_[A-Z0-9]{6}_FN__1$/)])
    const file = JSON.parse(readFileSync(c.reserved, 'utf8')) as {
      teamId: string
      local: { tag: string }
    }
    expect(file.teamId).toBe('team-1')
    expect(fresh(c.mapPath)[0]).toContain(file.local.tag)
    expect(r.err).toMatch(/__LOCAL_/)
  })

  it('with no team ever seen: local under a session tag, and no reserved.json', async () => {
    signIn(home)
    unreachable()
    const c = clone()
    const r = await scrub(c.cwd)
    expect(r.code, r.err).toBe(EXIT_OK)
    expect(fresh(c.mapPath)).toEqual([expect.stringMatching(/^__LOCAL_[A-Z0-9]{6}_FN__1$/)])
    expect(existsSync(c.reserved)).toBe(false)
  })

  it('sign-out clears the recorded team, and a signed-out run is unchanged', async () => {
    signIn(home)
    cloud.add({ owner: TEAMMATE, scope: 'team', map_data: await sealTeam({}) })
    await scrub(clone().cwd)
    expect(existsSync(join(home, '.veilio', 'team.json'))).toBe(true)
    expect((await scrub(clone().cwd, ['logout'])).code).toBe(EXIT_OK)
    expect(existsSync(join(home, '.veilio', 'team.json'))).toBe(false)
    unreachable()
    const c = clone()
    await scrub(c.cwd)
    expect(fresh(c.mapPath)).toEqual(['__FN__4'])
  })
})

describe('the reason the team’s maps could not be read (code review)', () => {
  it('cannot put control or Unicode format characters on the terminal', async () => {
    signIn(home, { team: true })
    cloud.failing.add('/api/maps')
    cloud.failingBody = { error: 'down\u001b[2J‮evil​z' }
    const r = await scrub(clone().cwd)
    expect(r.err).toMatch(/could not read the team's maps \(down\?\[2J\?evil\?z/)
    // eslint-disable-next-line no-control-regex -- matching control characters is the point
    expect(r.err).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]|\p{Cf}/u)
  })
})
