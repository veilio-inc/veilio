import { describe, it, expect } from 'vitest'
import { DEFAULT_RAW_ONLY, isRawOnly, normaliseRawOnlyPattern } from '../src/raw-only.js'

// Spec 093: a project's `rawOnly` glob was compiled to a backtracking regular
// expression, so a crafted `.veilio/guard.json` could hang the guard and the
// MCP server. Globs are now matched in time linear in pattern and path.

// The matcher as it was, kept here only to show the new one answers the same.
function globToRegExp(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob.charAt(i)
    if (c === '*' && glob[i + 1] === '*') {
      re += '.*'
      i++
      if (glob[i + 1] === '/') i++
    } else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`, 'i')
}
function matchedBefore(path: string, pattern: string): boolean {
  const re = globToRegExp(pattern)
  const parts = path
    .split('/')
    .map((p) => (p === '..' ? p : p.replace(/:.*$/, '').replace(/[. ]+$/, '')))
    .filter((p) => p !== '' && p !== '.')
  if (!pattern.includes('/')) return parts.some((p) => re.test(p))
  for (let i = 0; i < parts.length; i++) if (re.test(parts.slice(i).join('/'))) return true
  return false
}
function rawOnlyBefore(path: string, extra: readonly string[]): boolean {
  const normal = path.replace(/\\/g, '/')
  return [
    ...DEFAULT_RAW_ONLY,
    ...extra.filter((p) => p && !p.startsWith('!')).map((p) => normaliseRawOnlyPattern(p) ?? p),
  ].some((p) => matchedBefore(normal, p))
}

describe('rawOnly globs are matched in linear time (spec 093)', () => {
  it('answers a glob of 24 stars against a 60-character path in under 50 ms', () => {
    const t0 = performance.now()
    const answer = isRawOnly('a'.repeat(60), ['*a'.repeat(24) + '*b'])
    expect(performance.now() - t0).toBeLessThan(50)
    expect(answer).toBe(false)
  })

  it('stays fast on a long path of many folders and a long pattern', () => {
    const path = 'ab/'.repeat(1300) + 'x.txt'
    const t0 = performance.now()
    expect(isRawOnly(path, ['**/' + 'ab/'.repeat(300) + '*a*b*none'])).toBe(false)
    expect(performance.now() - t0).toBeLessThan(1500)
  })

  it.each([
    ['.env', []],
    ['src/.ENV.local', []],
    ['keys/server.PEM', []],
    ['.veilio/map.json', []],
    ['a/.veilio/deep/er/x', []],
    ['home/.kube/config', []],
    ['secrets/prod.yaml', ['secrets/**']],
    ['/work/project/secrets/a/b.yaml', ['secrets/**']],
    ['data/app.sqlite', ['*.sqlite']],
    ['data/v1/a.bin', ['data/v?/*.bin']],
    ['x/ab', ['**/b']],
    ['.env::$DATA', []],
    ['conf/.env. ', []],
  ] as const)('refuses %s', (path, extra) => {
    expect(isRawOnly(path, extra)).toBe(true)
  })

  it.each([
    ['src/a.ts', ['*.sqlite']],
    ['data/v10/a.bin', ['data/v?/*.bin']],
    ['data/v1/x/a.bin', ['data/v?/*.bin']],
    ['secretsx/prod.yaml', ['secrets/**']],
    ['environment.ts', []],
    ['a/b', ['a?b']],
  ] as const)('allows %s', (path, extra) => {
    expect(isRawOnly(path, extra)).toBe(false)
  })

  it('answers as the regular expression did, over generated globs and paths', () => {
    // A fixed sequence, so a failure names the same pair every run.
    let seed = 93
    const next = (n: number): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n
    const pick = (from: readonly string[], most: number): string =>
      Array.from({ length: next(most) + 1 }, () => from[next(from.length)]).join('')
    const GLOB = ['a', 'b', 'A', '.', '/', '/', '*', '*', '**', '**/', '?', 'ż', '-', '(', '+']
    const PATH = ['a', 'b', 'B', '.', '/', '/', 'ż', 'Ż', '-', '(', '+', ':', ' ', '..', '\\']
    let refused = 0
    const differs: string[] = []
    for (let i = 0; i < 20000; i++) {
      const glob = pick(GLOB, 7)
      const path = pick(PATH, 9)
      const before = rawOnlyBefore(path, [glob])
      if (isRawOnly(path, [glob]) !== before) differs.push(`${glob} on ${path}`)
      if (before) refused++
    }
    expect(differs).toEqual([])
    // Both answers occur often enough for the comparison to mean something.
    expect(refused).toBeGreaterThan(2000)
    expect(refused).toBeLessThan(18000)
  }, 60_000)

  it('reads a pattern past the caps as matching every path', () => {
    // Refusing more is the safe side, and no more than `**` already allows.
    expect(isRawOnly('src/a.ts', ['a'.repeat(1025)])).toBe(true)
    expect(isRawOnly('src/a.ts', ['*a'.repeat(65)])).toBe(true)
    expect(isRawOnly('src/a.ts', ['a'.repeat(1024)])).toBe(false)
    expect(isRawOnly('src/a.ts', ['*b'.repeat(64)])).toBe(false)
  })
})
