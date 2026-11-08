import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { delimiter, join } from 'node:path'
import { tmpdir } from 'node:os'
import { findProjectRoot, loadMap, resolveMapPath, saveMap } from '../src/store.js'

// The owner a file reads as. CI runs these tests as real root, where every
// file the test makes is uid 0 (act, 2026-11-08): so the sudo cases give
// their files a made-up owner, whatever the real uid. VEILIO_TEST_AS_ROOT=1
// runs the whole file as root would: getuid 0, every file owned by 0.
const owner = vi.hoisted(() => ({ uid: undefined as number | undefined }))
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  const lstatSync = ((...args: Parameters<typeof real.lstatSync>) => {
    const st = real.lstatSync(...args)
    if (owner.uid === undefined || !st) return st
    return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { uid: owner.uid })
  }) as typeof real.lstatSync
  return { ...real, lstatSync, default: { ...real, lstatSync } }
})
const AS_ROOT = process.env.VEILIO_TEST_AS_ROOT === '1'
beforeEach(() => {
  owner.uid = AS_ROOT ? 0 : undefined
  if (AS_ROOT) vi.spyOn(process, 'getuid').mockReturnValue(0)
})
afterEach(() => vi.restoreAllMocks())

// Security audit 2026-11-01 (LOW, confirmed): saveMap followed links, so a
// repository that committed .veilio/map.json (or .veilio itself) as a link
// made `veilio scrub` and the MCP anonymize tools write the real names to a
// file outside the project.
describe('the map is never written through a link', () => {
  const setup = () => {
    const base = mkdtempSync(join(tmpdir(), 'veilio-link-'))
    const cwd = join(base, 'proj')
    const outside = join(base, 'outside')
    mkdirSync(cwd, { recursive: true })
    mkdirSync(outside)
    return { cwd, outside }
  }

  it('refuses when map.json is a link', () => {
    const { cwd, outside } = setup()
    mkdirSync(join(cwd, '.veilio'))
    symlinkSync(join(outside, 'stolen.json'), join(cwd, '.veilio', 'map.json'))
    expect(() => saveMap(resolveMapPath(null, cwd), { __CLS__1: 'QuasarLedger' })).toThrow(/link/i)
    expect(existsSync(join(outside, 'stolen.json'))).toBe(false)
  })

  it('refuses when the .veilio directory is a link', () => {
    const { cwd, outside } = setup()
    symlinkSync(outside, join(cwd, '.veilio'))
    expect(() => saveMap(resolveMapPath(null, cwd), { __CLS__1: 'QuasarLedger' })).toThrow(/link/i)
    expect(existsSync(join(outside, 'map.json'))).toBe(false)
  })

  it('still writes a normal store', () => {
    const { cwd } = setup()
    saveMap(resolveMapPath(null, cwd), { __CLS__1: 'QuasarLedger' })
    expect(existsSync(join(cwd, '.veilio', 'map.json'))).toBe(true)
  })
})

describe('the side files are never written through a link', () => {
  it('refuses when reserved.json is a link', async () => {
    const { saveReserved } = await import('../src/reservations.js')
    const base = mkdtempSync(join(tmpdir(), 'veilio-link-'))
    const cwd = join(base, 'proj')
    const outside = join(base, 'outside')
    mkdirSync(join(cwd, '.veilio'), { recursive: true })
    mkdirSync(outside)
    symlinkSync(join(outside, 'r.json'), join(cwd, '.veilio', 'reserved.json'))
    expect(() =>
      saveReserved(resolveMapPath(null, cwd), {
        version: 1,
        instance: 'https://x',
        account: 'a',
        teamId: 't',
        blocks: {},
        local: { tag: 'ABCDEF' },
      } as never)
    ).toThrow(/link/i)
    expect(existsSync(join(outside, 'r.json'))).toBe(false)
  })
})

// Spec 085 L6 (security audit run-1): the link refusal held for writes only, so
// a committed .veilio/map.json link made restore read another project's map.
describe('the store is never read through a link (L6)', () => {
  const setup = () => {
    const base = mkdtempSync(join(tmpdir(), 'veilio-link-read-'))
    const cwd = join(base, 'proj')
    const outside = join(base, 'outside')
    mkdirSync(join(outside, '.veilio'), { recursive: true })
    mkdirSync(cwd, { recursive: true })
    writeFileSync(
      join(outside, '.veilio', 'map.json'),
      JSON.stringify({ version: 1, map: { __CLS__1: 'PaymentGateway' } })
    )
    writeFileSync(
      join(outside, '.veilio', 'aliases.json'),
      JSON.stringify({ version: 1, aliases: { __CLS__2: 'PaymentGateway' } })
    )
    writeFileSync(
      join(outside, '.veilio', 'reserved.json'),
      JSON.stringify({ version: 1, instance: 'https://x', account: 'a', teamId: 't', blocks: {} })
    )
    return { cwd, outside }
  }
  const link = (cwd: string, outside: string, file: string) => {
    mkdirSync(join(cwd, '.veilio'), { recursive: true })
    symlinkSync(join(outside, '.veilio', file), join(cwd, '.veilio', file))
  }
  const refusal = (what: string, path: string) =>
    `refusing to read ${what}: ${path} is a link. The map is read only where it appears to be.`

  it('refuses map.json as a link', () => {
    const { cwd, outside } = setup()
    link(cwd, outside, 'map.json')
    const mapPath = resolveMapPath(null, cwd)
    expect(() => loadMap(mapPath)).toThrow(refusal('the map', mapPath))
  })

  it('refuses aliases.json as a link', async () => {
    const { readAliases } = await import('../src/reservations.js')
    const { cwd, outside } = setup()
    link(cwd, outside, 'aliases.json')
    const mapPath = resolveMapPath(null, cwd)
    expect(() => readAliases(mapPath)).toThrow(
      refusal('aliases.json', join(cwd, '.veilio', 'aliases.json'))
    )
  })

  it('refuses reserved.json as a link', async () => {
    const { loadReserved } = await import('../src/reservations.js')
    const { cwd, outside } = setup()
    link(cwd, outside, 'reserved.json')
    expect(() => loadReserved(resolveMapPath(null, cwd))).toThrow(
      refusal('reserved.json', join(cwd, '.veilio', 'reserved.json'))
    )
  })

  it('refuses a .veilio directory that is a link, for every store file', async () => {
    const { readAliases, loadReserved } = await import('../src/reservations.js')
    const { cwd, outside } = setup()
    symlinkSync(join(outside, '.veilio'), join(cwd, '.veilio'))
    const mapPath = resolveMapPath(null, cwd)
    const dir = join(cwd, '.veilio')
    expect(() => loadMap(mapPath)).toThrow(refusal('the map', dir))
    expect(() => readAliases(mapPath)).toThrow(refusal('aliases.json', dir))
    expect(() => loadReserved(mapPath)).toThrow(refusal('reserved.json', dir))
  })

  it('a dangling map link is refused, not read as no map', () => {
    const { cwd, outside } = setup()
    mkdirSync(join(cwd, '.veilio'))
    symlinkSync(join(outside, 'gone.json'), join(cwd, '.veilio', 'map.json'))
    expect(() => loadMap(resolveMapPath(null, cwd))).toThrow(/is a link/)
  })

  it('a plain store still reads', () => {
    const { cwd } = setup()
    saveMap(resolveMapPath(null, cwd), { __CLS__1: 'QuasarLedger' })
    expect(loadMap(resolveMapPath(null, cwd))).toEqual({ __CLS__1: 'QuasarLedger' })
  })
})

// Spec 085 L4 (security audit run-1): saveMap trusted any existing
// .veilio/.gitignore, so a repository that committed one without `*` left the
// real names unignored, and a dangling link there was followed.
describe('the map is written only where .gitignore keeps it out of git (L4)', () => {
  const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
  const setup = () => {
    const base = mkdtempSync(join(tmpdir(), 'veilio-ign-'))
    const cwd = join(base, 'proj')
    mkdirSync(join(cwd, '.veilio'), { recursive: true })
    return { base, cwd, mapPath: resolveMapPath(null, cwd) }
  }
  const refusal = (dir: string) =>
    `refusing to write the map: ${dir}/.gitignore does not keep it out of git (it must be a plain file whose only pattern is \`*\`). Fix that file, then run again.`

  it('a committed .gitignore without `*` is refused, and no name is written', () => {
    const { cwd, mapPath } = setup()
    execFileSync('git', ['init', '-q'], { cwd, env: GIT_ENV, stdio: 'ignore' })
    writeFileSync(join(cwd, '.veilio', '.gitignore'), '# kept\n')
    execFileSync('git', ['add', '.veilio/.gitignore'], { cwd, env: GIT_ENV, stdio: 'ignore' })
    expect(() => saveMap(mapPath, { __CLS__1: 'PaymentGateway' })).toThrow(
      refusal(join(cwd, '.veilio'))
    )
    expect(existsSync(mapPath)).toBe(false)
  })

  it('a .gitignore that is a dangling link is refused, and its target is not created', () => {
    const { base, cwd, mapPath } = setup()
    symlinkSync(join(base, 'target'), join(cwd, '.veilio', '.gitignore'))
    expect(() => saveMap(mapPath, { __CLS__1: 'PaymentGateway' })).toThrow(
      refusal(join(cwd, '.veilio'))
    )
    expect(existsSync(join(base, 'target'))).toBe(false)
    expect(existsSync(mapPath)).toBe(false)
  })

  it('a .gitignore that is a link to a file holding `*` is refused too', () => {
    const { base, cwd, mapPath } = setup()
    writeFileSync(join(base, 'star'), '*\n')
    symlinkSync(join(base, 'star'), join(cwd, '.veilio', '.gitignore'))
    expect(() => saveMap(mapPath, { __CLS__1: 'PaymentGateway' })).toThrow(
      /does not keep it out of git/
    )
  })

  it("an older CLI's `*` file passes, and so does one with comments and blank lines", () => {
    for (const body of ['*\n', '*', '*\r\n', '# veilio\n*\r\n', '\n*\n\n# kept by veilio\n']) {
      const { cwd, mapPath } = setup()
      writeFileSync(join(cwd, '.veilio', '.gitignore'), body)
      saveMap(mapPath, { __CLS__1: 'PaymentGateway' })
      expect(existsSync(mapPath), JSON.stringify(body)).toBe(true)
    }
  })

  // Security review: `*` then `!map.json` still lets git track the map, and the
  // CLI cannot ask git. So `*` must be the only pattern.
  it('refuses any pattern beside `*`, a `!` line above all, and a file with no pattern', () => {
    for (const body of [
      '*\n!map.json\n',
      '*\n!*.json\n',
      '*\n*.tmp\n',
      '',
      '# only a comment\n\n',
      'map.json\n',
      '  *\n',
      '*\t\n',
      '* \n',
    ]) {
      const { cwd, mapPath } = setup()
      writeFileSync(join(cwd, '.veilio', '.gitignore'), body)
      expect(() => saveMap(mapPath, { __CLS__1: 'PaymentGateway' }), JSON.stringify(body)).toThrow(
        refusal(join(cwd, '.veilio'))
      )
      expect(existsSync(mapPath)).toBe(false)
    }
  })

  it('no .gitignore: one is written, `*`, 0600', () => {
    const { cwd, mapPath } = setup()
    saveMap(mapPath, { __CLS__1: 'PaymentGateway' })
    const ignore = join(cwd, '.veilio', '.gitignore')
    expect(readFileSync(ignore, 'utf8')).toBe('*\n')
    if (process.platform !== 'win32') expect(statSync(ignore).mode & 0o777).toBe(0o600)
  })

  it('the side files are held to the same rule', async () => {
    const { addAliases } = await import('../src/reservations.js')
    const { cwd, mapPath } = setup()
    writeFileSync(join(cwd, '.veilio', '.gitignore'), '# kept\n')
    expect(() => addAliases(mapPath, { __CLS__1: 'PaymentGateway' })).toThrow(
      /does not keep it out of git/
    )
    expect(existsSync(join(cwd, '.veilio', 'aliases.json'))).toBe(false)
  })
})

// Spec 085 L2 (security audit run-1, Q2 = A): on a shared machine the CLI
// walked up to a /tmp/.veilio another user made, and wrote the real names into
// that user's file. No second account in CI: process.getuid is stubbed, so
// every file the test made looks like another user's.
describe('a store another user owns is never used (L2)', () => {
  const posix = process.platform !== 'win32'
  const setup = () => {
    const base = mkdtempSync(join(tmpdir(), 'veilio-own-'))
    const proj = join(base, 'proj')
    mkdirSync(join(proj, '.veilio'), { recursive: true })
    mkdirSync(join(proj, 'work'))
    writeFileSync(join(proj, '.veilio', '.gitignore'), '*\n')
    writeFileSync(join(proj, '.veilio', 'map.json'), '{"version":1,"map":{}}\n', { mode: 0o666 })
    return { base, proj, mapPath: join(proj, '.veilio', 'map.json') }
  }
  const asAnotherUser = () => {
    const me = process.getuid!()
    vi.spyOn(process, 'getuid').mockReturnValue(me + 1)
  }
  const refusal = (dir: string) =>
    `refusing to use ${dir}: it belongs to another user on this machine. Run veilio inside your own project, or remove that directory. If you trust it, add its full path to VEILIO_TRUST_STORE_OWNER.`
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  // Review round 1 (#4), git's rule: root accepts the store of the user who
  // ran sudo; anything else needs the person's explicit opt-in.
  const asRoot = () => vi.spyOn(process, 'getuid').mockReturnValue(0)
  // Under sudo: root runs it, and the files are the invoking user's (1000).
  const SUDO = 1000
  const asSudo = () => {
    owner.uid = SUDO
    vi.stubEnv('SUDO_UID', String(SUDO))
    asRoot()
  }
  // Security review: under sudo only reads are accepted. A file root wrote
  // there would be root's, so writes are refused with a hint.
  it.runIf(posix)('root reads a store owned by SUDO_UID, and refuses to write it', () => {
    const { proj, mapPath } = setup()
    asSudo()
    expect(loadMap(mapPath)).toEqual({})
    expect(() => saveMap(mapPath, { __CLS__1: 'PaymentGateway' }, { force: true })).toThrow(
      `refusing to write ${join(proj, '.veilio')} as root: it belongs to the user who ran sudo, and a file root writes there would be root's. Run veilio without sudo.`
    )
    expect(readFileSync(mapPath, 'utf8')).not.toContain('PaymentGateway')
  })

  // Review round 2 (#1): in a fresh checkout there is no store yet, so the
  // owner checks saw nothing, and root made a .veilio the user could not use.
  it.runIf(posix)(
    'under sudo, no store is made in a project the user who ran sudo owns',
    async () => {
      const { saveReserved } = await import('../src/reservations.js')
      const base = mkdtempSync(join(tmpdir(), 'veilio-own-fresh-'))
      const store = join(base, '.veilio')
      asSudo()
      const hint = `refusing to write ${store} as root: it belongs to the user who ran sudo, and a file root writes there would be root's. Run veilio without sudo.`
      expect(() => saveMap(join(store, 'map.json'), { __CLS__1: 'PaymentGateway' })).toThrow(hint)
      expect(() =>
        saveReserved(join(store, 'map.json'), {
          version: 1,
          instance: 'https://x',
          account: 'a',
          teamId: 't',
          blocks: {},
        })
      ).toThrow(hint)
      expect(existsSync(store)).toBe(false)
    }
  )

  // Review round 2b: the trust list applies to the fresh-checkout check too,
  // as it does to the owner check: a listed store can be written under sudo.
  it.runIf(posix)(
    'under sudo, a store listed in VEILIO_TRUST_STORE_OWNER is writable; an unlisted one is not',
    () => {
      const listed = mkdtempSync(join(tmpdir(), 'veilio-own-fresh-'))
      const unlisted = mkdtempSync(join(tmpdir(), 'veilio-own-fresh-'))
      vi.stubEnv('VEILIO_TRUST_STORE_OWNER', join(listed, '.veilio'))
      asSudo()
      saveMap(join(listed, '.veilio', 'map.json'), { __CLS__1: 'PaymentGateway' })
      expect(loadMap(join(listed, '.veilio', 'map.json'))).toEqual({ __CLS__1: 'PaymentGateway' })
      expect(() =>
        saveMap(join(unlisted, '.veilio', 'map.json'), { __CLS__1: 'PaymentGateway' })
      ).toThrow(/as root: it belongs to the user who ran sudo/)
      expect(existsSync(join(unlisted, '.veilio'))).toBe(false)
    }
  )

  it.runIf(posix)('root with no sudo still writes where it owns the project', () => {
    const base = mkdtempSync(join(tmpdir(), 'veilio-own-fresh-'))
    vi.stubEnv('SUDO_UID', '')
    vi.spyOn(process, 'getuid').mockReturnValue(process.getuid!())
    saveMap(join(base, '.veilio', 'map.json'), { __CLS__1: 'PaymentGateway' })
    expect(existsSync(join(base, '.veilio', 'map.json'))).toBe(true)
  })

  it.runIf(posix)('root without SUDO_UID, or with another one, refuses it', () => {
    const { proj, mapPath } = setup()
    owner.uid = SUDO
    vi.stubEnv('SUDO_UID', '')
    asRoot()
    expect(() => loadMap(mapPath)).toThrow(refusal(join(proj, '.veilio')))
    vi.stubEnv('SUDO_UID', String(SUDO + 7))
    expect(() => loadMap(mapPath)).toThrow(refusal(join(proj, '.veilio')))
  })

  it.runIf(posix)('SUDO_UID counts for root only', () => {
    const { proj, mapPath } = setup()
    owner.uid = SUDO
    vi.stubEnv('SUDO_UID', String(SUDO))
    vi.spyOn(process, 'getuid').mockReturnValue(SUDO + 1)
    expect(() => loadMap(mapPath)).toThrow(refusal(join(proj, '.veilio')))
  })

  // Security review: the opt-in is a list of store paths, as git's
  // safe.directory: a listed store, by its real path, and no other.
  it.runIf(posix)('VEILIO_TRUST_STORE_OWNER lists the stores it accepts, by real path', () => {
    const { proj, mapPath } = setup()
    const other = setup()
    asAnotherUser()
    vi.stubEnv('VEILIO_TRUST_STORE_OWNER', '1')
    expect(() => loadMap(mapPath)).toThrow(refusal(join(proj, '.veilio')))
    // Listed through a path that is not its real one (macOS tmpdir is a link).
    vi.stubEnv(
      'VEILIO_TRUST_STORE_OWNER',
      ['/nowhere/.veilio', join(proj, '.veilio')].join(delimiter)
    )
    expect(loadMap(mapPath)).toEqual({})
    saveMap(mapPath, { __CLS__1: 'PaymentGateway' })
    expect(() => loadMap(other.mapPath)).toThrow(refusal(join(other.proj, '.veilio')))
  })

  it.runIf(posix)('a listed store does not make another store, above or below it, trusted', () => {
    const { proj } = setup()
    mkdirSync(join(proj, 'work', '.veilio'), { recursive: true })
    asAnotherUser()
    vi.stubEnv('VEILIO_TRUST_STORE_OWNER', join(proj, 'work', '.veilio'))
    // The project's own store is not listed: the search skips it.
    expect(findProjectRoot(join(proj, 'work', 'deeper'))).toBe(join(proj, 'work'))
    vi.stubEnv('VEILIO_TRUST_STORE_OWNER', join(proj, '.veilio'))
    // The unlisted inner store is skipped; the listed outer one is found.
    expect(findProjectRoot(join(proj, 'work'))).toBe(proj)
    expect(() => loadMap(join(proj, 'work', '.veilio', 'map.json'))).toThrow(
      refusal(join(proj, 'work', '.veilio'))
    )
  })

  it.runIf(posix)('a store listed through a link to it is the same store', () => {
    const { base, proj, mapPath } = setup()
    symlinkSync(proj, join(base, 'alias'))
    asAnotherUser()
    vi.stubEnv('VEILIO_TRUST_STORE_OWNER', join(base, 'alias', '.veilio'))
    expect(loadMap(mapPath)).toEqual({})
  })

  it.runIf(posix)('a relative entry trusts nothing', () => {
    const { proj, mapPath } = setup()
    asAnotherUser()
    vi.stubEnv('VEILIO_TRUST_STORE_OWNER', '.veilio')
    expect(() => loadMap(mapPath)).toThrow(refusal(join(proj, '.veilio')))
  })

  it.runIf(posix)('findProjectRoot skips a .veilio another user owns', () => {
    const { proj } = setup()
    expect(findProjectRoot(join(proj, 'work'))).toBe(proj)
    asAnotherUser()
    expect(findProjectRoot(join(proj, 'work'))).toBe(join(proj, 'work'))
  })

  it.runIf(posix)("an explicit map in another user's store is refused, read and write", () => {
    const { proj, mapPath } = setup()
    asAnotherUser()
    expect(() => loadMap(mapPath)).toThrow(refusal(join(proj, '.veilio')))
    expect(() => saveMap(mapPath, { __CLS__1: 'PaymentGateway' })).toThrow(
      refusal(join(proj, '.veilio'))
    )
    expect(readFileSync(mapPath, 'utf8')).not.toContain('PaymentGateway')
  })

  it.runIf(posix)(
    "a forced write into another user's store, with no map there yet, is refused",
    () => {
      const { proj, mapPath } = setup()
      rmSync(mapPath)
      asAnotherUser()
      expect(() => saveMap(mapPath, { __CLS__1: 'PaymentGateway' }, { force: true })).toThrow(
        refusal(join(proj, '.veilio'))
      )
      expect(existsSync(mapPath)).toBe(false)
    }
  )

  it.runIf(posix)('reserved.json, written without a read first, is refused there too', async () => {
    const { saveReserved } = await import('../src/reservations.js')
    const { proj, mapPath } = setup()
    asAnotherUser()
    expect(() =>
      saveReserved(mapPath, {
        version: 1,
        instance: 'https://x',
        account: 'a',
        teamId: 't',
        blocks: {},
      })
    ).toThrow(refusal(join(proj, '.veilio')))
    expect(existsSync(join(proj, '.veilio', 'reserved.json'))).toBe(false)
  })

  it.runIf(posix)('the side files are held to the same rule', async () => {
    const { addAliases } = await import('../src/reservations.js')
    const { mapPath } = setup()
    asAnotherUser()
    expect(() => addAliases(mapPath, { __CLS__1: 'PaymentGateway' })).toThrow(/another user/)
  })

  it('the map is replaced by a new file, never written through the one there', () => {
    const { base, mapPath } = setup()
    // A hard link: the same file under two names, which a link check cannot see.
    const outside = join(base, 'outside.json')
    writeFileSync(outside, '{"version":1,"map":{}}\n')
    rmSync(mapPath)
    linkSync(outside, mapPath)
    saveMap(mapPath, { __CLS__1: 'PaymentGateway' })
    expect(readFileSync(outside, 'utf8')).not.toContain('PaymentGateway')
    expect(loadMap(mapPath)).toEqual({ __CLS__1: 'PaymentGateway' })
    if (posix) expect(statSync(mapPath).mode & 0o777).toBe(0o600)
    expect(readdirSync(join(base, 'proj', '.veilio')).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })
})

// Security review: the checks ran before mkdir and the write, so another local
// user could swap .veilio in between. The swap is planted from inside the
// stubbed process.getuid, on its n-th call, i.e. right after an earlier check.
describe('a store swapped between the checks and the write is refused', () => {
  const posix = process.platform !== 'win32'
  afterEach(() => vi.restoreAllMocks())
  const setup = () => {
    const base = mkdtempSync(join(tmpdir(), 'veilio-race-'))
    const proj = join(base, 'proj')
    const outside = join(base, 'outside')
    mkdirSync(join(proj, '.veilio'), { recursive: true })
    mkdirSync(outside)
    writeFileSync(join(proj, '.veilio', '.gitignore'), '*\n')
    writeFileSync(join(outside, '.gitignore'), '*\n')
    return {
      proj,
      outside,
      store: join(proj, '.veilio'),
      mapPath: join(proj, '.veilio', 'map.json'),
    }
  }
  /** On getuid call `at`, run `swap`; from then on, if `foreign`, answer another uid. */
  const plantAt = (at: number, swap: () => void, foreign = false) => {
    const me = process.getuid!()
    let calls = 0
    vi.spyOn(process, 'getuid').mockImplementation(() => {
      calls++
      if (calls === at) swap()
      return foreign && calls >= at ? me + 1 : me
    })
  }
  const RESERVED = {
    version: 1,
    instance: 'https://x',
    account: 'a',
    teamId: 't',
    blocks: {},
  } as const

  it.runIf(posix)('a link planted after the first check (no read before the write)', async () => {
    const { saveReserved } = await import('../src/reservations.js')
    const { store, outside, mapPath } = setup()
    plantAt(2, () => {
      rmSync(store, { recursive: true })
      symlinkSync(outside, store)
    })
    expect(() => saveReserved(mapPath, RESERVED)).toThrow(/is a link/)
    expect(existsSync(join(outside, 'reserved.json'))).toBe(false)
  })

  it.runIf(posix)("another user's directory planted after the first check", async () => {
    const { saveReserved } = await import('../src/reservations.js')
    const { store, mapPath } = setup()
    plantAt(2, () => {}, true)
    expect(() => saveReserved(mapPath, RESERVED)).toThrow(/belongs to another user/)
    expect(existsSync(join(store, 'reserved.json'))).toBe(false)
  })

  it.runIf(posix)('a link planted after mkdir, just before the write', () => {
    const { store, outside, mapPath } = setup()
    // Calls 1-4: the first check and the re-check after mkdir; 5-6: loadRemote.
    plantAt(6, () => {
      rmSync(store, { recursive: true })
      symlinkSync(outside, store)
    })
    expect(() => saveMap(mapPath, { __CLS__1: 'PaymentGateway' })).toThrow(/is a link/)
    expect(existsSync(join(outside, 'map.json'))).toBe(false)
  })

  it.runIf(posix)('a new store directory is made 0700', () => {
    const base = mkdtempSync(join(tmpdir(), 'veilio-race-'))
    saveMap(join(base, '.veilio', 'map.json'), { __CLS__1: 'PaymentGateway' })
    expect(statSync(join(base, '.veilio')).mode & 0o777).toBe(0o700)
  })
})
