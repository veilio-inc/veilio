import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { restore } from '../src/engine.js'
import type { StrippedItem } from '../src/types.js'

// e69: a JSDoc block is only one where `/**` starts in code - not inside a
// string, a template literal, a regex literal, or a line or block comment.

const JSDOC = { strip: ['jsdoc' as const] }
const unchanged = (text: string) => {
  const r = restore(text, {}, JSDOC)
  expect(r.restored).toBe(text)
  expect(r.strippedItems).toEqual([])
}

describe('restore: /** that is not a JSDoc start is left alone (e69)', () => {
  it('/**/ and */ in two double-quoted strings: the code between them stays', () => {
    unchanged('x = "a/**/b"\ny = 2\nz = "*/"\nw\n')
  })

  it('a glob in a string keeps the rest of its line and the lines after it', () => {
    const r = restore(
      'const g = "src/**/*.ts" // all files\nconst n = 1\n/** doc */\nf()\n',
      {},
      JSDOC
    )
    expect(r.restored).toBe('const g = "src/**/*.ts" // all files\nconst n = 1\nf()\n')
    expect(r.strippedItems).toEqual([{ type: 'jsdoc', content: '/** doc */', lineNumber: 3 }])
  })

  it('single-quoted strings', () => {
    unchanged("x = 'a/**/b'\ny = 2\nz = '*/'\n")
  })

  it('escaped quotes inside a string do not end it', () => {
    unchanged('x = "say \\"/**\\" ok"\ny = 2\nz = "*/"\n')
    unchanged("x = 'it\\'s /**'\ny = 2\nz = '*/'\n")
  })

  it('template literals, one line and several', () => {
    unchanged('const t = `a/**/b`\nconst y = 2\nconst z = `*/`\n')
    unchanged('const t = `\n  /** not a doc\n  ${x} */\n`\nconst y = 2\n')
  })

  it('a regex literal holding /** is code, and a JSDoc after it is still found', () => {
    const r = restore('const re = /[/**]/g\nconst y = 2\n/** doc */\nf()\n', {}, JSDOC)
    expect(r.restored).toBe('const re = /[/**]/g\nconst y = 2\nf()\n')
    expect(r.strippedItems).toEqual([{ type: 'jsdoc', content: '/** doc */', lineNumber: 3 }])
    unchanged('if (ok) return /[/**]/.test(s)\nconst y = 2 // */\n')
  })

  it('a regex literal ends at its line even after a backslash', () => {
    const r = restore('re = /a\\\nb /** doc */ c/\n', {}, JSDOC)
    expect(r.restored).toBe('re = /a\\\nb  c/\n')
  })

  it('a line of slashes that never close a regex is linear, not quadratic', () => {
    for (const line of ['x = ' + '\\/'.repeat(100_000), 'x = ' + '/['.repeat(100_000)]) {
      const t0 = Date.now()
      restore(`${line}\n/** doc */\nf()\n`, {}, JSDOC)
      expect(Date.now() - t0).toBeLessThan(2_000)
    }
  })

  it('a division is not read as a regex: the JSDoc between two divisions goes', () => {
    expect(restore('x = a / b; /** doc */ y = c / d\n', {}, JSDOC).restored).toBe(
      'x = a / b;  y = c / d\n'
    )
  })

  it('a real JSDoc right after such a string, on the same line and on the next', () => {
    const same = restore('x = "a/**/b" /** doc */\ny\n', {}, JSDOC)
    expect(same.restored).toBe('x = "a/**/b"\ny\n')
    expect(same.strippedItems).toEqual([{ type: 'jsdoc', content: '/** doc */', lineNumber: 1 }])
    const next = restore('x = "a/**/b"\n/** doc */\ny\n', {}, JSDOC)
    expect(next.restored).toBe('x = "a/**/b"\ny\n')
    expect(next.strippedItems).toEqual([{ type: 'jsdoc', content: '/** doc */', lineNumber: 2 }])
  })

  it('an empty /**/ in code is a plain block comment', () => {
    unchanged('x = 1 /**/ + 2\n')
  })

  it('a /** */ inside a kept // comment stays in it', () => {
    unchanged('foo() // see /** x */ here\nbar()\n')
    unchanged('foo(); // see /** x */ here\nbar()\n')
    expect(restore('foo() // see /** x */ here\nbar()\n', {}).restored).toBe(
      'foo() // see /** x */ here\nbar()\n'
    )
  })

  it('a /** */ inside a // TODO is part of the TODO, counted once', () => {
    const r = restore('// TODO fix /** x */ later\nb\n', {})
    expect(r.restored).toBe('b\n')
    expect(r.strippedItems).toEqual([
      { type: 'todo', content: '// TODO fix /** x */ later', lineNumber: 1 },
    ])
  })

  it('a nested-looking /* /** */ is one plain block comment', () => {
    unchanged('/* /** */\nx\n')
    unchanged('a /* old /** x */ b\n')
  })

  it('an unterminated /** is not stripped, as before', () => {
    unchanged('x = 1\n/** never closed\ny = 2\n')
  })

  it('a file where nothing should change', () => {
    unchanged(
      [
        "import { glob } from 'glob'",
        "const files = glob('packages/**/*.ts')",
        'const url = "https://example.com/**/x"',
        "const re = /\\/\\*\\*[\\s\\S]*?\\*\\//g // a JSDoc matcher: '*/'",
        'const cls = /[/**]/',
        '/* block /** look-alike */',
        '// line /** look-alike */',
        "const s = 'a */ b'",
        'const t = `${files.length} /** files */`',
        'export const half = (n: number) => n / 2 / 1',
        '',
      ].join('\n')
    )
  })
})

describe('restore: a JSDoc inside a markdown answer is still stripped', () => {
  it('a fenced block, with prose and inline code around it', () => {
    const text = [
      "Here's the fix - it matches `src/**/*.ts`:",
      '',
      '```ts',
      '/** Adds two numbers. */',
      'export const add = (a: number, b: number) => a + b',
      '```',
      '',
      "That's all - don't forget `*/`.",
      '',
    ].join('\n')
    const r = restore(text, {}, JSDOC)
    expect(r.restored).toBe(text.replace('/** Adds two numbers. */\n', ''))
    expect(r.strippedItems).toEqual([
      { type: 'jsdoc', content: '/** Adds two numbers. */', lineNumber: 4 },
    ])
  })

  it('a second fence starts clean even when the first one left a quote open', () => {
    const text = '```\nconst s = `unclosed\n```\n\n```ts\n/** doc */\nf()\n```\n'
    expect(restore(text, {}, JSDOC).restored).toBe(text.replace('/** doc */\n', ''))
  })
})

// The repo's own sources, tests included: the tests hold many strings with
// `/**` in them. Every line that is not part of a stripped JSDoc and holds no
// `/**` or `*/` must come back unchanged and in order, and every stripped item
// must look like a JSDoc block - not like code a runaway match swallowed.
describe('restore: the repo corpus loses no code to JSDoc stripping', () => {
  const root = join(import.meta.dirname, '..', '..', '..')
  const dirs = [
    ...readdirSync(join(root, 'packages')).flatMap((p) =>
      ['src', 'tests'].map((d) => join(root, 'packages', p, d))
    ),
    ...['lib', 'hooks', 'tests'].map((d) => join(root, 'plugins', 'veilio-guard', d)),
  ]
  const walk = (dir: string): string[] => {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return []
    }
    return names.flatMap((name) => {
      const path = join(dir, name)
      if (name === 'node_modules' || name === 'fixtures') return []
      if (statSync(path).isDirectory()) return walk(path)
      return name.endsWith('.ts') ? [path] : []
    })
  }
  const files = dirs.flatMap(walk)

  it('finds a corpus', () => {
    expect(files.length).toBeGreaterThan(100)
  })

  it.each(files.map((f) => [f.slice(root.length + 1), f]))('%s', (_name, path) => {
    const text = readFileSync(path, 'utf8')
    const { restored, strippedItems } = restore(text, {}, JSDOC)

    const inJsdoc = new Set<number>()
    for (const item of strippedItems as StrippedItem[]) {
      expect(item.content.startsWith('/**') && item.content.endsWith('*/')).toBe(true)
      const lines = item.content.split('\n')
      for (const inner of lines.slice(1, -1)) expect(inner).toMatch(/^\s*(\*|$)/)
      for (let k = 0; k < lines.length; k++) inJsdoc.add(item.lineNumber + k)
    }

    const kept = text
      .split('\n')
      .filter((l, i) => !inJsdoc.has(i + 1) && l.trim() !== '' && !/\/\*\*|\*\//.test(l))
    const out = restored.split('\n').filter((l) => l.trim() !== '')
    let at = 0
    for (const line of out) if (at < kept.length && line === kept[at]) at++
    expect(kept.slice(at, at + 1)).toEqual([])
  })
})
