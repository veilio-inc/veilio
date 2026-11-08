import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { anonymizeOverTeam } from '../src/team-anonymize.js'
import { main } from '../src/index.js'
import { EXIT_OK, type Io } from '../src/commands.js'
import { STORE_DIR, STORE_FILE, loadMap, saveMap } from '../src/store.js'
import { RESERVED_FILE } from '../src/reservations.js'
import { FakeCloud, INSTANCE, ME, PASSPHRASE, TEAM_ID, signIn } from './helpers/fake-cloud.js'

/**
 * Spec 066 R3 (and tracker e46's collision half): signed-in `veilio scrub`
 * numbers like the guard - inside this checkout's usable block, else in its
 * local family - never above the team's highest, which is where the next
 * teammate's block starts.
 */

const CODE = 'export const holdbackDays = 3\nexport const payoutCutoff = 5\n'
const noTeam = { namespace: {}, highest: {} }

describe('anonymizeOverTeam with numbering', () => {
  it('mints inside a usable block', () => {
    const { result } = anonymizeOverTeam(
      CODE,
      {},
      noTeam,
      {},
      {
        blocks: { __VAR__: { start: 41, end: 540 } },
        tag: 'K7Q2XA',
      }
    )
    expect(Object.keys(result.map).sort()).toEqual(['__VAR__41', '__VAR__42'])
  })

  it('goes local past the block’s end, within one call', () => {
    const { result } = anonymizeOverTeam(
      CODE,
      {},
      noTeam,
      {},
      {
        blocks: { __VAR__: { start: 41, end: 41 } },
        tag: 'K7Q2XA',
      }
    )
    expect(Object.keys(result.map).sort()).toEqual(['__LOCAL_K7Q2XA_VAR__1', '__VAR__41'])
  })

  it('goes local for a kind with no block, whatever the team’s highest', () => {
    const { result } = anonymizeOverTeam(
      CODE,
      {},
      { namespace: {}, highest: { __VAR__: 9 } },
      {},
      { blocks: {}, tag: 'K7Q2XA' }
    )
    expect(Object.keys(result.map).sort()).toEqual([
      '__LOCAL_K7Q2XA_VAR__1',
      '__LOCAL_K7Q2XA_VAR__2',
    ])
  })

  it('without numbering, numbers above the team’s highest as before', () => {
    const { result } = anonymizeOverTeam(CODE, {}, { namespace: {}, highest: { __VAR__: 9 } }, {})
    expect(Object.keys(result.map).sort()).toEqual(['__VAR__10', '__VAR__11'])
  })
})

describe('signed-in veilio scrub takes its numbering from reserved.json', () => {
  let home: string
  let cwd: string
  let cloud: FakeCloud
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'veilio-tal-home-'))
    cwd = mkdtempSync(join(tmpdir(), 'veilio-tal-work-'))
    mkdirSync(join(cwd, '.git'), { recursive: true })
    writeFileSync(join(cwd, 'a.ts'), CODE)
    cloud = new FakeCloud()
    vi.stubGlobal('fetch', cloud.fetch)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    rmSync(home, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  })
  const mapPath = () => join(cwd, STORE_DIR, STORE_FILE)
  const reserved = (extra: Record<string, unknown>) => {
    mkdirSync(join(cwd, STORE_DIR), { recursive: true })
    writeFileSync(
      join(cwd, STORE_DIR, RESERVED_FILE),
      JSON.stringify({
        version: 1,
        instance: INSTANCE,
        account: ME,
        teamId: TEAM_ID,
        blocks: { __VAR__: { start: 41, end: 540 } },
        local: { tag: 'K7Q2XA' },
        ...extra,
      })
    )
  }
  async function run(argv: string[]): Promise<{ code: number; out: string; err: string }> {
    let out = ''
    let err = ''
    const io: Io = {
      cwd,
      home,
      stdin: async () => '',
      stdinBytes: async function* () {
        yield Buffer.from('')
      },
      stdout: (t) => (out += t),
      stderr: (t) => (err += t),
      prompt: async () => '',
      password: async () => PASSPHRASE,
    }
    return { code: await main(argv, io), out, err }
  }
  const minted = () => Object.keys(loadMap(mapPath())).sort()

  it('a matching file: inside its block', async () => {
    signIn(home, { team: true })
    reserved({})
    expect((await run(['scrub', 'a.ts'])).code).toBe(EXIT_OK)
    expect(minted()).toEqual(['__VAR__41', '__VAR__42'])
  })

  it('a matching file with no block: local under its tag', async () => {
    signIn(home, { team: true })
    reserved({ blocks: {} })
    await run(['scrub', 'a.ts'])
    expect(minted()).toEqual(['__LOCAL_K7Q2XA_VAR__1', '__LOCAL_K7Q2XA_VAR__2'])
  })

  it.each([
    ['another account’s', { account: 'someone@example.test' }],
    ['another team’s', { teamId: 'team-9' }],
    ['another instance’s', { instance: 'https://other.test' }],
  ])('%s file is no blocks: every new name local, never its tag', async (_, other) => {
    signIn(home, { team: true })
    reserved(other)
    await run(['scrub', 'a.ts'])
    const keys = minted()
    expect(keys).toHaveLength(2)
    for (const k of keys) expect(k).toMatch(/^__LOCAL_[A-Z0-9]{6}_VAR__\d+$/)
    expect(keys.join()).not.toContain('K7Q2XA')
  })

  it('no file is no blocks: every new name local', async () => {
    signIn(home, { team: true })
    saveMap(mapPath(), { __VAR__9: 'amount' }, { force: true })
    await run(['scrub', 'a.ts'])
    const fresh = minted().filter((k) => k !== '__VAR__9')
    expect(fresh).toHaveLength(2)
    for (const k of fresh) expect(k).toMatch(/^__LOCAL_[A-Z0-9]{6}_VAR__\d+$/)
  })

  it('signed out: unchanged, and reserved.json is not read', async () => {
    reserved({})
    saveMap(mapPath(), { __VAR__9: 'amount' }, { force: true })
    await run(['scrub', 'a.ts'])
    expect(minted()).toEqual(['__VAR__10', '__VAR__11', '__VAR__9'])
  })

  it('scrub --team still reserves exact numbers, not the block', async () => {
    signIn(home, { team: true })
    reserved({ blocks: {} })
    const res = await run(['scrub', '--team', 'a.ts'])
    expect(res.code, res.err).toBe(EXIT_OK)
    for (const k of minted()) expect(k).toMatch(/^__VAR__\d+$/)
    expect(cloud.requests.some((r) => r.path.endsWith('/placeholders/reserve'))).toBe(true)
  })
})
