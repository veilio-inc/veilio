import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadMap, resolveMapPath, saveMap } from '../src/store.js'

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
