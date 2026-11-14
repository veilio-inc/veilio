// Spec 093 item 6: two writers of one project's map. The finding was "two
// sessions can give one placeholder to two names"; these are its validation
// tests. What must hold (FR-007): a writer that was told its save worked finds
// its entries in the file as it wrote them, a placeholder never ends up
// meaning another writer's name, and the file is never a partial map. The
// second of two clashing writers being refused is the designed outcome.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

// Lets a test run a second writer inside the first one's save: after its
// check of what is on disk, before its write.
const between = vi.hoisted(() => ({ run: null as null | (() => void) }))
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>()
  const mkdirSync = ((...args: Parameters<typeof actual.mkdirSync>) => {
    const run = between.run
    between.run = null
    run?.()
    return actual.mkdirSync(...args)
  }) as typeof actual.mkdirSync
  return { ...actual, mkdirSync }
})

const { MapOverwriteError, STORE_DIR, STORE_FILE, loadMap, saveMap } =
  await import('../src/store.js')

let home: string
let cwd: string
let path: string
const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'veilio-conc-home-'))
  cwd = mkdtempSync(join(tmpdir(), 'veilio-conc-work-'))
  mkdirSync(join(cwd, '.git'))
  path = join(cwd, STORE_DIR, STORE_FILE)
  // saveMap records what it wrote under the home directory.
  process.env.HOME = home
  process.env.USERPROFILE = home
})
afterEach(() => {
  between.run = null
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(home, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
})

const ALPHA = { __CLS__1: 'QuasarLedgerFake' }
const BETA = { __CLS__1: 'NebulaRouterFake' }
const OTHER = { __FN__1: 'settleNebulaFake' }

describe('both read the map before either wrote', () => {
  it('the same placeholder for another name: the second writer is refused and the first one’s map is whole', () => {
    const a = loadMap(path)
    const b = loadMap(path)
    saveMap(path, { ...a, ...ALPHA })
    expect(() => saveMap(path, { ...b, ...BETA })).toThrow(MapOverwriteError)
    expect(loadMap(path)).toEqual(ALPHA)
  })

  // Review round 1 (US5 scenario 1): nothing clashes, so both are saved.
  it('another placeholder: both writers’ names are in the file', () => {
    const a = loadMap(path)
    const b = loadMap(path)
    saveMap(path, { ...a, ...ALPHA })
    saveMap(path, { ...b, ...OTHER })
    expect(loadMap(path)).toEqual({ ...ALPHA, ...OTHER })
  })

  it('the same name under another placeholder: refused, one name keeps one placeholder', () => {
    saveMap(path, ALPHA)
    expect(() => saveMap(path, { __CLS__2: ALPHA.__CLS__1 })).toThrow(MapOverwriteError)
    expect(loadMap(path)).toEqual(ALPHA)
  })
})

describe('the second writer saves between the first one’s check and its write', () => {
  it.each([
    ['the same placeholder for another name', BETA],
    ['another placeholder', OTHER],
  ])('%s: whoever was told the save worked finds its entries in the file', (_, second) => {
    const outcome = { first: 'saved', second: 'saved' }
    between.run = () => {
      try {
        saveMap(path, second)
      } catch {
        outcome.second = 'refused'
      }
    }
    try {
      saveMap(path, ALPHA)
    } catch (err) {
      expect(err).toBeInstanceOf(MapOverwriteError)
      outcome.first = 'refused'
    }
    const file = loadMap(path)
    if (outcome.first === 'saved') expect(file).toMatchObject(ALPHA)
    if (outcome.second === 'saved') expect(file).toMatchObject(second)
    expect([outcome.first, outcome.second]).toContain('saved')
    // Nothing clashes between ALPHA and OTHER: neither writer is refused.
    if (second === OTHER) expect(outcome).toEqual({ first: 'saved', second: 'saved' })
  })
})

describe('a write that is cut short', () => {
  it('a reader holding the old map reads it whole; nothing is left beside the new one', () => {
    saveMap(path, ALPHA)
    const before = readFileSync(path, 'utf8')
    const reader = openSync(path, 'r')
    try {
      saveMap(path, { ...ALPHA, ...OTHER })
      expect(readFileSync(reader, 'utf8')).toBe(before)
    } finally {
      closeSync(reader)
    }
    expect(loadMap(path)).toEqual({ ...ALPHA, ...OTHER })
    expect(readdirSync(join(cwd, STORE_DIR)).sort()).toEqual(['.gitignore', STORE_FILE])
  })

  it('a lock a crashed run left behind does not stop the next save', () => {
    saveMap(path, ALPHA)
    const lock = `${path}.lock`
    writeFileSync(lock, '')
    const longAgo = new Date(Date.now() - 60_000)
    utimesSync(lock, longAgo, longAgo)
    saveMap(path, { ...ALPHA, ...OTHER })
    expect(loadMap(path)).toEqual({ ...ALPHA, ...OTHER })
    expect(readdirSync(join(cwd, STORE_DIR)).sort()).toEqual(['.gitignore', STORE_FILE])
  })
})

// The real thing: separate processes, each masking one new class name. Not
// every run collides, so on code without the fix this fails most times, not
// every time; with it, it never does.
describe('scrub run by several processes at once', () => {
  const CLI = resolve(import.meta.dirname, '..', 'dist', 'index.js')
  const NAMES = ['Quasar', 'Nebula', 'Pulsar', 'Zenith', 'Vortex', 'Meteor', 'Photon', 'Galaxy']

  const scrub = (real: string): Promise<{ real: string; code: number | null; out: string }> =>
    new Promise((done) => {
      const child = spawn(process.execPath, [CLI, 'scrub', '--language', 'typescript', '--quiet'], {
        cwd,
        env: { ...process.env, HOME: home, USERPROFILE: home },
      })
      let out = ''
      child.stdout.on('data', (d: Buffer) => (out += d.toString()))
      child.on('close', (code) => done({ real, code, out }))
      child.stdin.end(`export class ${real} {}\n`)
    })

  it('every run that exits 0 printed a placeholder the map gives its own name', async () => {
    for (let round = 0; round < 6; round++) {
      rmSync(join(cwd, STORE_DIR), { recursive: true, force: true })
      const runs = await Promise.all(NAMES.map((n) => scrub(`${n}LedgerFake${round}`)))
      const map = loadMap(path)
      const done = runs.filter((r) => r.code === 0)
      expect(done.length).toBeGreaterThan(0)
      for (const r of done) {
        const placeholder = /__[A-Z]+__\d+/.exec(r.out)?.[0]
        expect(placeholder, r.out).toBeDefined()
        expect(map[placeholder!], `${placeholder} of ${r.real}`).toBe(r.real)
      }
    }
  }, 120_000)
})
