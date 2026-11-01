import { describe, it, expect } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveMapPath, saveMap } from '../src/store.js'

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
