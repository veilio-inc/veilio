import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { main } from '../src/index.js'
import { EXIT_FINDINGS, EXIT_OK, type Io } from '../src/commands.js'
import { loadMap, resolveMapPath } from '../src/store.js'
import { readAliases } from '../src/reservations.js'

// Spec 085 L3 (security audit run-1): a cloned repository that commits
// .veilio/map.json chose what `veilio restore` writes back. The guard already
// refuses a tracked map; the CLI now does too, through the one store reader.

const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: { ...GIT_ENV, HOME: home }, stdio: 'ignore' })

const PLANTED = 'PaymentGateway(); injectedCall()'
let home: string
let cwd: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'veilio-trk-home-'))
  cwd = mkdtempSync(join(tmpdir(), 'veilio-trk-work-'))
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
})

function plant(file = 'map.json', dir = '.veilio') {
  mkdirSync(join(cwd, dir), { recursive: true })
  const body =
    file === 'aliases.json'
      ? { version: 1, aliases: { __CLS__1: PLANTED } }
      : { version: 1, map: { __CLS__1: PLANTED } }
  writeFileSync(join(cwd, dir, file), JSON.stringify(body))
}

async function run(argv: string[], stdin = '') {
  let out = ''
  let err = ''
  const io: Io = {
    cwd,
    home,
    stdin: async () => stdin,
    stdout: (t) => (out += t),
    stderr: (t) => (err += t),
    prompt: async () => '',
    password: async () => '',
  }
  const code = await main(argv, io)
  return { code, out, err }
}

describe('a map the repository commits is not restored from (L3)', () => {
  it('restore refuses a tracked .veilio/map.json and prints nothing restored', async () => {
    git(cwd, 'init', '-q')
    plant()
    git(cwd, 'add', '.veilio/map.json')
    const r = await run(['restore'], 'new __CLS__1()')
    expect(r.code).toBe(EXIT_FINDINGS)
    expect(r.out).not.toContain('injectedCall')
    expect(r.err).toContain(
      'veilio: `.veilio/map.json` is tracked by git: a map in the repository is not yours to restore from. Remove it from git (`git rm --cached .veilio/map.json`), then scrub again to build your own.'
    )
  })

  it('restore refuses a tracked .veilio/aliases.json', async () => {
    git(cwd, 'init', '-q')
    plant('aliases.json')
    git(cwd, 'add', '.veilio/aliases.json')
    const r = await run(['restore'], 'new __CLS__1()')
    expect(r.code).toBe(EXIT_FINDINGS)
    expect(r.out).not.toContain('injectedCall')
    expect(r.err).toContain('`.veilio/aliases.json` is tracked by git')
  })

  it('a tracked aliases.json refuses a read of the map beside it too', async () => {
    git(cwd, 'init', '-q')
    plant()
    plant('aliases.json')
    git(cwd, 'add', '.veilio/aliases.json')
    const r = await run(['map'])
    expect(r.code).toBe(EXIT_FINDINGS)
    expect(r.out).not.toContain('injectedCall')
    expect(r.err).toContain('`.veilio/aliases.json` is tracked by git')
  })

  it('scrub refuses a tracked map, and writes nothing into it', async () => {
    git(cwd, 'init', '-q')
    plant()
    git(cwd, 'add', '.veilio/map.json')
    const r = await run(['scrub'], 'export class QuasarLedger {}')
    expect(r.code).toBe(EXIT_FINDINGS)
    expect(r.err).toContain('is tracked by git')
    expect(r.out).toBe('')
  })

  it('a tracked map is refused under a case-folded name too', async () => {
    git(cwd, 'init', '-q')
    git(cwd, 'config', 'core.ignorecase', 'false')
    plant('Map.json', '.Veilio')
    git(cwd, 'add', '.Veilio/Map.json')
    expect(() => loadMap(resolveMapPath(null, cwd))).toThrow(/is tracked by git/)
  })

  it('a map that git does not track restores as before', async () => {
    git(cwd, 'init', '-q')
    plant()
    const r = await run(['restore'], 'new __CLS__1()')
    expect(r.code).toBe(EXIT_OK)
    expect(r.out).toContain(PLANTED)
  })

  it('outside git the CLI cannot tell, and restores as before (the documented limit)', async () => {
    plant()
    const r = await run(['restore'], 'new __CLS__1()')
    expect(r.code).toBe(EXIT_OK)
    expect(r.out).toContain(PLANTED)
  })
})

describe('the store reader bounds the values it accepts', () => {
  it('a map value holding a newline is malformed', () => {
    mkdirSync(join(cwd, '.veilio'))
    writeFileSync(
      join(cwd, '.veilio', 'map.json'),
      JSON.stringify({ version: 1, map: { __CLS__1: 'PaymentGateway\ninjectedCall()' } })
    )
    expect(() => loadMap(resolveMapPath(null, cwd))).toThrow(/malformed/)
  })

  it('a map value longer than 100000 characters is malformed', () => {
    mkdirSync(join(cwd, '.veilio'))
    writeFileSync(
      join(cwd, '.veilio', 'map.json'),
      JSON.stringify({ version: 1, map: { __CLS__1: 'P'.repeat(100_001) } })
    )
    expect(() => loadMap(resolveMapPath(null, cwd))).toThrow(/malformed/)
  })

  it('a value of exactly 100000 characters is kept', () => {
    mkdirSync(join(cwd, '.veilio'))
    const long = 'P'.repeat(100_000)
    writeFileSync(
      join(cwd, '.veilio', 'map.json'),
      JSON.stringify({ version: 1, map: { __CLS__1: long } })
    )
    expect(loadMap(resolveMapPath(null, cwd))).toEqual({ __CLS__1: long })
  })
})

// Security review of the store reader (coordinator, 2026-11-08).
describe('security review of the store reader', () => {
  it('a tracked map under an odd path gets no shell command, and no control character', async () => {
    git(cwd, 'init', '-q')
    const odd = "a';b\nc"
    mkdirSync(join(cwd, odd, '.veilio'), { recursive: true })
    writeFileSync(join(cwd, odd, '.veilio', 'map.json'), JSON.stringify({ version: 1, map: {} }))
    git(cwd, 'add', '-f', '--', `${odd}/.veilio/map.json`)
    let message = ''
    try {
      loadMap(join(cwd, odd, '.veilio', 'map.json'))
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toBe(
      "`a';bc/.veilio/map.json` is tracked by git: a map in the repository is not yours to restore from. Remove it from git, then scrub again to build your own."
    )
  })

  const TERMINATORS = ['\u2028', '\u2029', '\u0085', '\v', '\f', '\t', '\u0000', '\u001b', '\u009b']
  for (const t of TERMINATORS) {
    const label = `U+${t.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`
    it(`a map value holding ${label} is malformed`, () => {
      mkdirSync(join(cwd, '.veilio'), { recursive: true })
      writeFileSync(
        join(cwd, '.veilio', 'map.json'),
        JSON.stringify({ version: 1, map: { __CLS__1: `PaymentGateway${t}injectedCall()` } })
      )
      expect(() => loadMap(resolveMapPath(null, cwd))).toThrow(/malformed/)
    })
    it(`an alias holding ${label} is dropped and counted`, () => {
      mkdirSync(join(cwd, '.veilio'), { recursive: true })
      writeFileSync(
        join(cwd, '.veilio', 'aliases.json'),
        JSON.stringify({
          version: 1,
          aliases: { __CLS__1: `PaymentGateway${t}injectedCall()`, __CLS__2: 'QuasarLedger' },
        })
      )
      expect(readAliases(resolveMapPath(null, cwd))).toEqual({
        aliases: { __CLS__2: 'QuasarLedger' },
        ignored: 1,
      })
    })
  }

  it('names in other scripts, with combining marks, and with spaces still read', () => {
    mkdirSync(join(cwd, '.veilio'), { recursive: true })
    const map = {
      __CLS__1: 'ZahlungsTür',
      __CLS__2: 'Платіж',
      __CLS__3: 'Πληρωμή',
      __CLS__4: 'cafe\u0301',
      __MANUAL__1: 'Jan Kowalski',
    }
    writeFileSync(join(cwd, '.veilio', 'map.json'), JSON.stringify({ version: 1, map }))
    expect(loadMap(resolveMapPath(null, cwd))).toEqual(map)
  })
})
