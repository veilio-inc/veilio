import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { ensureBlocks } from '../src/client/blocks.js'
import { STORE_DIR, STORE_FILE, StoreRefusal, saveMap, writeStoreFile } from '../src/store.js'
import {
  RESERVED_FILE,
  ReservedFileError,
  basesNeedingBlocks,
  loadReserved,
  localNumbering,
} from '../src/reservations.js'
import { FakeCloud, INSTANCE, ME, TEAM_ID } from './helpers/fake-cloud.js'

/**
 * Spec 066 R4: `reserved.json` always exists for a team checkout once a pull or
 * an unlock asked for blocks, refused or not. It carries the checkout's local
 * tag, and on a refusal why and until when, so the guard and the MCP server can
 * number locally - and say so - offline.
 */

let dir: string
let cloud: FakeCloud
const credential = { token: 'tok', account: ME, instance: INSTANCE }
const mapPath = () => join(dir, STORE_DIR, STORE_FILE)
const filePath = () => join(dir, STORE_DIR, RESERVED_FILE)
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the file's raw JSON, read field by field
const raw = () => JSON.parse(readFileSync(filePath(), 'utf8')) as Record<string, any>
const write = (value: unknown) => {
  mkdirSync(join(dir, STORE_DIR), { recursive: true })
  writeFileSync(filePath(), JSON.stringify(value))
}
const base = { version: 1, instance: INSTANCE, account: ME, teamId: TEAM_ID, blocks: {} }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'veilio-resl-'))
  cloud = new FakeCloud()
  vi.stubGlobal('fetch', cloud.fetch)
  saveMap(mapPath(), { __FN__40: 'chargeCard' }, { force: true })
})
afterEach(() => {
  vi.unstubAllGlobals()
  rmSync(dir, { recursive: true, force: true })
})

describe('loadReserved reads the local tag and the refusal', () => {
  it('accepts local.tag and refused', () => {
    write({
      ...base,
      local: { tag: 'K7Q2XA' },
      refused: {
        reason: 'cap',
        at: '2026-10-31T10:00:00.000Z',
        nextAt: '2026-11-01T09:14:00.000Z',
        detail: 'limit',
      },
    })
    const r = loadReserved(mapPath())!
    expect(r.local).toEqual({ tag: 'K7Q2XA' })
    expect(r.refused).toMatchObject({ reason: 'cap', nextAt: '2026-11-01T09:14:00.000Z' })
  })

  it.each([
    ['a bad tag', { local: { tag: 'k7q2xa' } }],
    ['a five-character tag', { local: { tag: 'K7Q2X' } }],
    ['a local without a tag', { local: {} }],
    ['an unknown reason', { refused: { reason: 'tired', at: '2026-10-31T10:00:00.000Z' } }],
    ['a non-ISO time', { refused: { reason: 'cap', at: 'yesterday' } }],
    [
      'a non-ISO next time',
      { refused: { reason: 'cap', at: '2026-10-31T10:00:00.000Z', nextAt: 'soon' } },
    ],
    [
      'a detail that is not text',
      { refused: { reason: 'server', at: '2026-10-31T10:00:00.000Z', detail: 7 } },
    ],
  ])('refuses %s', (_, extra) => {
    write({ ...base, ...extra })
    expect(() => loadReserved(mapPath())).toThrow(ReservedFileError)
  })

  it('accepts a file from an older CLI (no local)', () => {
    write({ ...base, blocks: { __FN__: { start: 41, end: 540 } } })
    expect(loadReserved(mapPath())!.local).toBeUndefined()
  })
})

describe('ensureBlocks writes reserved.json on every outcome', () => {
  const failures: [string, () => void, string][] = [
    ['a 429 (cap)', () => (cloud.blocksRefused = true), 'cap'],
    [
      'a 402 (payment)',
      () => cloud.failWith(402, { error: 'plan lapsed', paywall: true }),
      'payment',
    ],
    ['a network failure (offline)', () => cloud.failWith('network'), 'offline'],
    ['a 500 (server)', () => cloud.failWith(500, { error: 'boom' }), 'server'],
  ]
  it.each(failures)(
    '%s: the tag, the held blocks and refused, at 0600',
    async (_, arrange, reason) => {
      write({ ...base, local: { tag: 'K7Q2XA' }, blocks: { __VAR__: { start: 1, end: 500 } } })
      arrange()
      const outcome = await ensureBlocks(credential, TEAM_ID, mapPath())
      expect(outcome).toMatchObject({ status: 'failed', reason })
      const r = raw()
      expect(r.local).toEqual({ tag: 'K7Q2XA' })
      expect(r.blocks).toEqual({ __VAR__: { start: 1, end: 500 } })
      expect(r.refused.reason).toBe(reason)
      expect(Number.isNaN(Date.parse(r.refused.at))).toBe(false)
      expect(statSync(filePath()).mode & 0o777).toBe(0o600)
      expect(loadReserved(mapPath())).not.toBeNull()
    }
  )

  it('a first refusal with no file writes empty blocks and a fresh tag', async () => {
    cloud.blocksRefused = true
    await ensureBlocks(credential, TEAM_ID, mapPath())
    const r = raw()
    expect(r.blocks).toEqual({})
    expect(r.local.tag).toMatch(/^[A-Z0-9]{6}$/)
    expect(r).toMatchObject({ instance: INSTANCE, account: ME, teamId: TEAM_ID })
  })

  it('the 429’s retry_at becomes nextAt', async () => {
    cloud.blocksRefused = true
    cloud.blocksRetryAt = '2026-11-02T09:14:00.000Z'
    const outcome = await ensureBlocks(credential, TEAM_ID, mapPath())
    expect(outcome).toMatchObject({ nextAt: '2026-11-02T09:14:00.000Z' })
    expect(raw().refused.nextAt).toBe('2026-11-02T09:14:00.000Z')
  })

  it('a success removes refused and keeps the tag', async () => {
    write({
      ...base,
      local: { tag: 'K7Q2XA' },
      refused: { reason: 'cap', at: '2026-10-31T10:00:00.000Z' },
    })
    expect((await ensureBlocks(credential, TEAM_ID, mapPath())).status).toBe('reserved')
    const r = raw()
    expect(r.refused).toBeUndefined()
    expect(r.local).toEqual({ tag: 'K7Q2XA' })
  })

  it.each([
    ['account', { account: 'someone@example.test' }],
    ['team', { teamId: 'team-9' }],
    ['instance', { instance: 'https://other.test' }],
  ])('a file of another %s is replaced with a new tag', async (_, other) => {
    write({ ...base, ...other, local: { tag: 'K7Q2XA' } })
    await ensureBlocks(credential, TEAM_ID, mapPath())
    const r = raw()
    expect(r).toMatchObject({ instance: INSTANCE, account: ME, teamId: TEAM_ID })
    expect(r.local.tag).toMatch(/^[A-Z0-9]{6}$/)
    expect(r.local.tag).not.toBe('K7Q2XA')
  })

  it('an older file (no local) gets a tag on the next ensureBlocks, even with nothing to reserve', async () => {
    write({
      ...base,
      blocks: {
        __FN__: { start: 41, end: 540 },
        __VAR__: { start: 1, end: 500 },
        __CLS__: { start: 1, end: 500 },
      },
    })
    const outcome = await ensureBlocks(credential, TEAM_ID, mapPath())
    expect(outcome.status).toBe('kept')
    expect(raw().local.tag).toMatch(/^[A-Z0-9]{6}$/)
    expect(raw().blocks.__FN__).toEqual({ start: 41, end: 540 })
  })
})

describe('a local base is never asked for', () => {
  it('basesNeedingBlocks folds a local kind into its team kind, once', () => {
    expect(basesNeedingBlocks({ __LOCAL_K7Q2XA_API_KEY__3: 'x' }, {}, ['__VAR__']).sort()).toEqual([
      '__API_KEY__',
      '__VAR__',
    ])
    expect(basesNeedingBlocks({ __LOCAL_K7Q2XA_FN__3: 'x', __FN__9: 'y' }, {}, []).sort()).toEqual([
      '__FN__',
    ])
  })

  it('ensureBlocks sends the team base, with the team family’s floor', async () => {
    saveMap(
      mapPath(),
      { __LOCAL_K7Q2XA_FN__900: 'refund', __LOCAL_K7Q2XA_IBAN__2: 'PL61', __FN__40: 'chargeCard' },
      { force: true }
    )
    await ensureBlocks(credential, TEAM_ID, mapPath())
    const sent = cloud.requests.find((r) => r.path.endsWith('/placeholders/reserve'))!
    const asked = sent.body!.requests as { base: string; floor: number }[]
    expect(asked.map((x) => x.base).filter((x) => x.startsWith('__LOCAL_'))).toEqual([])
    expect(asked.filter((x) => x.base === '__FN__')).toEqual([
      expect.objectContaining({ floor: 40 }),
    ])
    expect(asked.filter((x) => x.base === '__IBAN__')).toEqual([
      expect.objectContaining({ floor: 0 }),
    ])
  })
})

// Spec 085 part 3, R2-16 (security audit run-2): a reserved.json the
// repository commits was read as "malformed" (the tracked refusal swallowed)
// and then rewritten with the account, team and rule bases, ready for
// `git commit -a`. A tracked store file is now refused on write too.
describe('a reserved.json git tracks is never rewritten (R2-16)', () => {
  const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: dir, env: GIT_ENV, stdio: 'ignore' })
  const TRACKED =
    'it is tracked by git, and what veilio keeps there (account, team and rule data) must not be committed.'
  function commitReserved(): string {
    git('init', '-q')
    write({})
    git('add', '-f', `${STORE_DIR}/${RESERVED_FILE}`)
    return readFileSync(filePath(), 'utf8')
  }

  it('ensureBlocks refuses, and the tracked file is unchanged', async () => {
    const before = commitReserved()
    cloud.blocksRefused = true
    await expect(ensureBlocks(credential, TEAM_ID, mapPath())).rejects.toThrow(TRACKED)
    expect(readFileSync(filePath(), 'utf8')).toBe(before)
  })

  it('ensureBlocks refuses when Cloud grants the blocks, and no account is written', async () => {
    const before = commitReserved()
    await expect(ensureBlocks(credential, TEAM_ID, mapPath())).rejects.toThrow(StoreRefusal)
    expect(readFileSync(filePath(), 'utf8')).toBe(before)
    expect(readFileSync(filePath(), 'utf8')).not.toContain(ME)
    // Refused when read, so nothing is asked of Cloud for a file never written.
    expect(cloud.requests).toHaveLength(0)
  })

  it('localNumbering refuses to write a tracked file', () => {
    const before = commitReserved()
    expect(() =>
      localNumbering(mapPath(), { instance: INSTANCE, account: ME }, TEAM_ID, { write: true })
    ).toThrow(TRACKED)
    // Not even read as someone else's file to number from without a write.
    expect(() =>
      localNumbering(mapPath(), { instance: INSTANCE, account: ME }, TEAM_ID, { write: false })
    ).toThrow(StoreRefusal)
    expect(readFileSync(filePath(), 'utf8')).toBe(before)
  })

  it('an untracked malformed file is still replaced', async () => {
    write('not json at all')
    cloud.blocksRefused = true
    await ensureBlocks(credential, TEAM_ID, mapPath())
    expect(raw()).toMatchObject({ instance: INSTANCE, account: ME, teamId: TEAM_ID })
  })

  it('writeStoreFile refuses any tracked store file', () => {
    commitReserved()
    expect(() => writeStoreFile('reservations', filePath(), '{}')).toThrow(TRACKED)
  })
})
