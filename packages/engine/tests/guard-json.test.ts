import { describe, expect, it } from 'vitest'
import { GuardJsonCache, guardJsonRawOnly } from '../src/index.js'

// Spec 078 review round 2 #10: one reader of `.veilio/guard.json`'s rawOnly,
// shared by the Claude Code guard and the MCP server.
describe('guardJsonRawOnly', () => {
  it('keeps the string patterns, as written', () => {
    expect(guardJsonRawOnly('{"rawOnly":["secrets/**",7,"!keep/**",null,"notes/*.txt"]}')).toEqual([
      'secrets/**',
      '!keep/**',
      'notes/*.txt',
    ])
  })
  it.each(['{}', 'null', '{"rawOnly":"secrets/**"}', '[]'])('reads no patterns from %s', (text) => {
    expect(guardJsonRawOnly(text)).toEqual([])
  })
  it('throws on a file that is not JSON', () => {
    expect(() => guardJsonRawOnly('{"rawOnly": [')).toThrow(SyntaxError)
  })
})

describe('GuardJsonCache', () => {
  it('reads a project root again only when its mtime changes', () => {
    const cache = new GuardJsonCache()
    let reads = 0
    const read = (text: string) => () => (reads++, text)
    expect(cache.get('/p', 1, read('{"rawOnly":["a/**"]}'))).toEqual(['a/**'])
    expect(cache.get('/p', 1, read('{"rawOnly":["b/**"]}'))).toEqual(['a/**'])
    expect(reads).toBe(1)
    expect(cache.get('/p', 2, read('{"rawOnly":["b/**"]}'))).toEqual(['b/**'])
    expect(cache.get('/q', 2, read('{"rawOnly":["c/**"]}'))).toEqual(['c/**'])
    expect(reads).toBe(3)
  })
  it('reads no patterns, and caches nothing, when there is no file', () => {
    const cache = new GuardJsonCache()
    expect(cache.get('/p', undefined, () => '{"rawOnly":["a/**"]}')).toEqual([])
  })
})
