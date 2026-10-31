import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { STORE_DIR, STORE_FILE } from '../src/store.js'
import { ALIASES_FILE, loadAliases, readAliases } from '../src/reservations.js'

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

describe('loadAliases', () => {
  it.each([
    ['not JSON', '{'],
    ['no object', '[]'],
    ['aliases is an array', JSON.stringify({ version: 1, aliases: ['__VAR__1'] })],
    ['a number as a name', JSON.stringify({ version: 1, aliases: { __VAR__1: 5 } })],
    ['an empty name', JSON.stringify({ version: 1, aliases: { __VAR__1: '' } })],
    ['a name too long', JSON.stringify({ version: 1, aliases: { __VAR__1: 'a'.repeat(100_001) } })],
    [
      'too many entries',
      JSON.stringify({
        version: 1,
        aliases: Object.fromEntries(
          Array.from({ length: 1_000_001 }, (_, i) => [`__VAR__${i + 1}`, 'x'])
        ),
      }),
    ],
  ])('%s is malformed', (_what, text) => {
    plant(text)
    expect(() => loadAliases(mapPath())).toThrow(/aliases file .* is malformed/)
  })

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
})
