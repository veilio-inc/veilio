import { describe, it, expect } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
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
