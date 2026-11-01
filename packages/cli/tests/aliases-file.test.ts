import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { STORE_DIR, STORE_FILE } from '../src/store.js'
import { readFileSync } from 'node:fs'
import {
  ALIASES_FILE,
  addAliases,
  loadAliases,
  readAliases,
  teamNumbering,
} from '../src/reservations.js'

// Security audit: aliases.json was read as whatever JSON it held. It is
// checked like map.json now: an object of strings, placeholder keys only,
// within size bounds - a malformed file throws, a key that is not a
// placeholder is dropped and counted.

let cwd: string
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'veilio-al-'))
  mkdirSync(join(cwd, STORE_DIR), { recursive: true })
})
afterEach(() => rmSync(cwd, { recursive: true, force: true }))
const mapPath = () => join(cwd, STORE_DIR, STORE_FILE)
const plant = (text: string) => writeFileSync(join(cwd, STORE_DIR, ALIASES_FILE), text)

describe('loadAliases never throws (security review of round 1)', () => {
  it.each([
    ['not JSON', '{'],
    ['no object', '[]'],
    ['aliases is an array', JSON.stringify({ version: 1, aliases: ['__VAR__1'] })],
  ])('%s: no aliases, and the file is unreadable', (_what, text) => {
    plant(text)
    expect(readAliases(mapPath())).toMatchObject({ aliases: {}, unreadable: true })
    expect(loadAliases(mapPath())).toEqual({})
  })

  it.each([
    ['a number as a name', 5],
    ['an empty name', ''],
    ['a name too long', 'a'.repeat(100_001)],
  ])('%s is dropped and counted, and the rest kept', (_what, bad) => {
    plant(JSON.stringify({ version: 1, aliases: { __VAR__1: bad, __FN__2: 'payout' } }))
    expect(readAliases(mapPath())).toEqual({ aliases: { __FN__2: 'payout' }, ignored: 1 })
  })

  it('past the entry bound the rest are dropped and counted', () => {
    const aliases = Object.fromEntries(
      Array.from({ length: 1_000_002 }, (_, i) => [`__VAR__${i + 1}`, 'x'])
    )
    plant(JSON.stringify({ version: 1, aliases }))
    const r = readAliases(mapPath())
    expect(Object.keys(r.aliases)).toHaveLength(1_000_000)
    expect(r.ignored).toBe(2)
  }, 60_000)

  it('a key that is not a placeholder is dropped, and counted', () => {
    plant(
      '{"version":1,"aliases":{"__VAR__1":"amount","(x+x+)+y":"a","__proto__":"b","constructor":"c"}}'
    )
    expect(readAliases(mapPath())).toEqual({ aliases: { __VAR__1: 'amount' }, ignored: 3 })
    expect(Object.getPrototypeOf(loadAliases(mapPath()))).toBe(Object.prototype)
  })

  it('no file is no aliases', () => {
    expect(loadAliases(mapPath())).toEqual({})
  })

  it('one bad entry does not cost teamNumbering the others as retired', () => {
    plant(JSON.stringify({ version: 1, aliases: { __VAR__1: 5, __LOCAL_ABC123_FN__1: 'payout' } }))
    const n = teamNumbering(mapPath(), { instance: 'i', account: 'a', teamId: 't' })
    expect(n.retired).toEqual(['__LOCAL_ABC123_FN__1'])
  })

  it('an unreadable file is never written over: adding refuses and leaves it as it was', () => {
    plant('{')
    expect(() => addAliases(mapPath(), { __FN__3: 'chargeCard' })).toThrow(/aliases/)
    expect(readFileSync(join(cwd, STORE_DIR, ALIASES_FILE), 'utf8')).toBe('{')
  })
})
