import { describe, it, expect } from 'vitest'
import {
  anonymize,
  highestPerKind,
  isSaneBlock,
  MAX_PLACEHOLDER_NUMBER,
  restore,
} from '../src/index.js'

// Security audit: past 2^53 adding one stops changing a number, so a block
// or a map key up there made two names share one placeholder, and restore
// wrote the wrong name. Numbers above 1e8 are never trusted or minted.

const CODE =
  'const ledgerAlpha = 1\nconst berthQuorum = 2\nfunction keelHaul() {}\nfunction tarnBridge() {}\n'

function roundTrips(r: ReturnType<typeof anonymize>, code = CODE, given = {}): void {
  const placeholders = Object.keys(r.map)
  expect(new Set(Object.values(r.map)).size).toBe(placeholders.length)
  for (const p of placeholders)
    if (!(p in given)) expect(Number(/\d+$/.exec(p)?.[0])).toBeLessThanOrEqual(1e8)
  expect(restore(r.anonymized, r.map).restored).toBe(code)
}

describe('blocks', () => {
  it.each([2 ** 53 - 1, 2 ** 53, 1e21, 1e9 + 1, 1e8 + 1])(
    'a block starting at %d is not numbered from: the names go to the local family',
    (start) => {
      const r = anonymize(CODE, {
        team: {
          tag: 'ABC123',
          blocks: { __VAR__: { start, end: start + 100 }, __FN__: { start, end: start + 100 } },
        },
      })
      roundTrips(r)
      expect(Object.keys(r.map).every((p) => p.startsWith('__LOCAL_ABC123_'))).toBe(true)
    }
  )

  // Cloud 450a93ce: the server's numbers stop at 1e8.
  it('a block reaching past 1e8 is not numbered from at all', () => {
    const r = anonymize(CODE, {
      team: { tag: 'ABC123', blocks: { __VAR__: { start: 1e8, end: 1e8 + 5 } } },
    })
    roundTrips(r)
    expect(Object.keys(r.map).every((p) => p.startsWith('__LOCAL_ABC123_'))).toBe(true)
  })

  it('isSaneBlock: whole safe numbers in [1, 1e8], start <= end, at most 10000 apart', () => {
    expect(MAX_PLACEHOLDER_NUMBER).toBe(1e8)
    expect(isSaneBlock({ start: 1, end: 500 })).toBe(true)
    expect(isSaneBlock({ start: 1e8 - 10, end: 1e8 })).toBe(true)
    for (const b of [
      { start: 0, end: 5 },
      { start: 5, end: 4 },
      { start: 1, end: 10_002 },
      { start: 2 ** 53, end: 2 ** 53 },
      { start: 1e21, end: 1e21 },
      { start: 1e8, end: 1e8 + 1 },
      { start: 1.5, end: 3 },
      { start: '1', end: 3 },
      null,
    ])
      expect(isSaneBlock(b), JSON.stringify(b)).toBe(false)
  })
})

describe('map keys', () => {
  it('a key at 2^53 - 1 does not push the highest: new names keep their own placeholders', () => {
    const existingMap = { __VAR__9007199254740991: 'planted' }
    const r = anonymize(CODE, { existingMap })
    roundTrips(r, CODE, existingMap)
    expect(r.map.__VAR__9007199254740991).toBe('planted')
  })

  it('a key at 1e9 does not make two calls mint the same placeholder for different names', () => {
    const first = anonymize('const ledgerAlpha = 1\n', { existingMap: { __VAR__1000000000: 'x' } })
    const second = anonymize('const berthQuorum = 2\n', { existingMap: first.map })
    const merged = { ...first.map, ...second.map }
    expect(new Set(Object.values(merged)).size).toBe(Object.keys(merged).length)
    expect(second.map).toMatchObject(first.map)
  })

  it('a placeholder at 2^53 - 1 in the text does not push the highest either', () => {
    const code = '// __VAR__9007199254740991\nconst ledgerAlpha = 1\nconst berthQuorum = 2\n'
    const r = anonymize(code)
    expect(new Set(Object.keys(r.map)).size).toBe(2)
    expect(new Set(Object.values(r.map)).size).toBe(2)
    expect(restore(r.anonymized, r.map).restored).toBe(code)
  })
})

// Cloud 450a93ce: a number in the text above 1e8 is ignored for the highest,
// so it never becomes a floor; one at or below it is still counted.
describe('placeholders pasted into the text', () => {
  it('__FN__100000001 raises nothing; past __FN__99999999 no number is ever a floor above 1e8', () => {
    const above = anonymize('// __FN__100000001\nfunction alphaBeta() {}\n')
    expect(Object.keys(above.map)).toEqual(['__FN__1'])
    const code = '// __FN__99999999\nfunction alphaBeta() {}\nfunction gammaDelta() {}\n'
    const below = anonymize(code)
    roundTrips(below, code)
    expect(highestPerKind(below.map).__FN__).toBeLessThanOrEqual(1e8)
  })
})
