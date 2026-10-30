import { describe, it, expect } from 'vitest'
import { compileRulePattern, isSafeRegex } from '../src/index.js'

// Spec 065, third security review: custom-rule patterns are matched by the
// engine's own linear-time matcher, not by the platform's backtracking one.
// Three rounds of shape heuristics each met a new bypass; a matcher whose cost
// is the name's length times the pattern's size has none to find.

const test = (pattern: string, name: string): boolean => {
  const m = compileRulePattern(pattern)
  if (!m) throw new Error(`not supported: ${pattern}`)
  return m.test(name)
}

describe('the patterns that freeze a backtracking matcher run in linear time', () => {
  // The answer each gives (two match the empty string at the end), checked
  // against the platform on a short name of the same shape.
  it.each([
    ['(a+)+$', 'a', 'b', false],
    ['((a+))+$', 'a', 'b', false],
    ['(a|aa)+$', 'a', 'b', false],
    ['(a|a)(a|a)(a|a)(a|a)(a|a)(a|a)(a|a)(a|a)$', 'a', 'b', false],
    ['(\\w+\\s?)*$', 'a', '!', true],
    ['[^](x+)+]', 'x', 'y', false],
    ['\\w*\\w*\\w*\\w*\\w*$', 'w', '!', true],
  ] as const)('%s', (pattern, run, tail, expected) => {
    expect(new RegExp(pattern).test(run.repeat(8) + tail)).toBe(expected)
    const start = Date.now()
    expect(test(pattern, run.repeat(5000) + tail)).toBe(expected)
    expect(Date.now() - start).toBeLessThan(500)
  })
})

describe('what the matcher refuses: constructs a linear matcher cannot run', () => {
  it.each([
    '(a)\\1',
    '(?<n>a)\\k<n>',
    '(?=a)a',
    '(?!a)b',
    '(?<=a)b',
    '(?<!a)b',
    '\\bword\\b',
    'a{1,1000}',
    '(',
    '[a-',
    'a**',
    '\\p{L}',
  ])('%s', (pattern) => {
    expect(compileRulePattern(pattern)).toBeNull()
    expect(isSafeRegex(pattern)).toBe(false)
  })
})

describe('the same answers as the platform matcher, on the language it accepts', () => {
  it.each([
    ['^phoenix$', 'phoenix', true],
    ['^phoenix$', 'phoenixes', false],
    ['phoenix', 'aphoenixb', true],
    ['KeepMe$', 'x'.repeat(40_000) + 'KeepMe', true],
    ['^[a-z]+_id$', 'user_id', true],
    ['^[a-z]+_id$', 'User_id', false],
    ['^(?:alpha|beta)$', 'beta', true],
    ['^(?:alpha|beta)$', 'gamma', false],
    ['a{2,3}', 'aa', true],
    ['^a{2,3}$', 'aaaa', false],
    ['^a{2,}$', 'aaaaa', true],
    ['^a{2}$', 'aa', true],
    ['^\\d+$', '123', true],
    ['^\\D+$', '12a', false],
    ['^\\w+$', 'a_1', true],
    ['^\\W$', '-', true],
    ['^\\s$', ' ', true],
    ['^\\S$', ' ', false],
    ['^.$', '\n', false],
    ['^.$', 'x', true],
    ['^[^]$', '\n', true],
    ['^[]$', '', false],
    ['[^]]', ']', false],
    ['^[^]]+$', 'abc', false],
    ['^\\.$', '.', true],
    ['^\\.$', 'x', false],
    ['^[\\]]$', ']', true],
    ['^[a\\-z]$', '-', true],
    ['^[\\w.]+$', 'a.b', true],
    ['^(ab)*c$', 'ababc', true],
    ['^(ab)*?c$', 'c', true],
    ['^a+?$', 'aaa', true],
    ['^(?:a|)$', '', true],
    ['^$', '', true],
    ['a|^b', 'xb', false],
    ['a|^b', 'bx', true],
    ['\\$', 'a$b', true],
    ['^\\t$', '\t', true],
    // Mutation pass: overlapping class ranges must merge, or the binary search
    // misses a member; and only an anchored list is a set of whole names.
    ['^[a-zb-c]$', 'x', true],
    ['^[^a-zb-c]$', 'x', false],
    ['^[b-ca-z_]$', 'q', true],
    ['a(?:x|y)b', 'axb', true],
    ['a(?:x|y)b', 'x', false],
    ['^(?:x|y)b$', 'yb', true],
  ])('%s on %j', (pattern, name, expected) => {
    expect(new RegExp(pattern).test(name)).toBe(expected)
    expect(test(pattern, name)).toBe(expected)
  })
})

describe('differential: random patterns of the accepted language, against the platform', () => {
  // A small seeded generator, so a failure reproduces.
  let seed = 0x5eed065
  const rand = (n: number): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed % n
  }
  const pick = <T>(xs: readonly T[]): T => xs[rand(xs.length)]!
  const atom = (depth: number): string => {
    const r = rand(depth > 2 ? 7 : 10)
    if (r < 3) return pick(['a', 'b', '_', '-', '\\.', '{', '}', ']'])
    if (r === 3) return pick(['.', '\\w', '\\d', '\\s', '\\W', '\\D', '\\S', '\\t'])
    if (r === 4)
      return pick([
        '[ab]',
        '[^a]',
        '[a-b_]',
        '[^]',
        '[]',
        '[\\w-]',
        '[-a]',
        '[a-]',
        '[\\]]',
        '[^]]',
        '[\\b]',
      ])
    if (r === 5) return pick(['^', '$'])
    if (r === 6) return pick(['a{x', 'x}'])
    return `(${rand(2) ? '?:' : ''}${alt(depth + 1)})`
  }
  const quant = (): string =>
    pick(['', '', '', '*', '+', '?', '{2}', '{1,2}', '{0,}', '*?', '+?', '{0,3}?'])
  const seq = (depth: number): string =>
    Array.from({ length: 1 + rand(3) }, () => {
      const a = atom(depth)
      return a === '^' || a === '$' || a.endsWith('{') ? a : a + quant()
    }).join('')
  const alt = (depth: number): string =>
    Array.from({ length: 1 + rand(2) }, () => seq(depth)).join('|')
  const name = (): string =>
    Array.from({ length: rand(12) }, () =>
      pick(['a', 'b', '_', '1', ' ', '\n', '-', '.', '{', '}', ']', '\b', '\t'])
    ).join('')

  it('agrees on 5000 cases', () => {
    let compared = 0
    for (let i = 0; i < 5000; i++) {
      const pattern = alt(0)
      const m = compileRulePattern(pattern)
      expect(m, `refused a pattern of the accepted language: ${pattern}`).not.toBeNull()
      const n = name()
      expect(m!.test(n), `${JSON.stringify(pattern)} on ${JSON.stringify(n)}`).toBe(
        new RegExp(pattern).test(n)
      )
      compared++
    }
    expect(compared).toBe(5000)
  })
})

// Fourth security review, and what fixing it showed.
describe('cost and failure bounds', () => {
  it('a large class repeated is checked in constant-ish time per step', () => {
    const cls = `[${Array.from({ length: 400 }, (_, i) => String.fromCharCode(0x4e00 + i * 2)).join('')}]`
    const m = compileRulePattern(`^${cls}{50}$`)!
    const start = Date.now()
    expect(m.test('一'.repeat(5000) + 'x')).toBe(false)
    expect(Date.now() - start).toBeLessThan(500)
  })

  it('a long chain of optional atoms does not overflow the stack: test never throws', () => {
    const m = compileRulePattern('a?'.repeat(250))!
    expect(() => m.test('a'.repeat(10_000))).not.toThrow()
    expect(m.test('a'.repeat(10_000))).toBe(true)
  })

  it("the guard's keep rule - an anchored list of literal names - is exact and fast at any size", () => {
    const names = Array.from({ length: 5000 }, (_, i) => `pkg_${i}.v`)
    const escape = (n: string) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const m = compileRulePattern(`^(?:${names.map(escape).join('|')})$`)!
    expect(m).not.toBeNull()
    const start = Date.now()
    for (let i = 0; i < 20_000; i++) m.test(`pkg_${i}.v`)
    expect(Date.now() - start).toBeLessThan(500)
    expect(m.test('pkg_4999.v')).toBe(true)
    expect(m.test('pkg_4999xv')).toBe(false)
    expect(m.test('pkg_5000.v')).toBe(false)
    expect(m.test('xpkg_1.v')).toBe(false)
  })
})

describe('the work cap (mutation pass)', () => {
  it('past it a test answers no match - the safe direction - instead of running long', () => {
    const m = compileRulePattern('a{50}c')!
    const name = 'a'.repeat(500_000) + 'c'
    expect(new RegExp('a{50}c').test(name)).toBe(true)
    const start = Date.now()
    expect(m.test(name)).toBe(false)
    expect(Date.now() - start).toBeLessThan(50)
  })
})
