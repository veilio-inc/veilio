import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { frontmatterDescription } from '../../plugins/veilio-guard/lib/frontmatter.ts'

// Guard decision 1 (code review of d705b14): the description a cached
// plugin file declares, as YAML reads it. Checked against the `yaml` library
// on every form a description takes, and on random ones: where this reader
// answers, it must answer what YAML does; where it cannot, it answers
// nothing, and the entry is masked.
function yamlDescription(file: string): unknown {
  const m = /^---\n([\s\S]*?)\n---/.exec(file)
  if (!m) return undefined
  try {
    const v: unknown = parse(m[1]!, { uniqueKeys: true })
    return v && typeof v === 'object' ? (v as Record<string, unknown>).description : undefined
  } catch {
    return undefined
  }
}

const doc = (body: string) => `---\nname: x\n${body}\nother: 1\n---\nBody.\n`

const FORMS: Record<string, string> = {
  plain: 'description: Use when the user asks.',
  'plain, folded over lines': 'description: Use when\n  the user asks\n\n  twice.',
  'double-quoted': 'description: "Says \\"hi\\"."',
  'double-quoted escapes': 'description: "a\\tb\\\\c\\u00e9\\x41\\/\\n end"',
  'single-quoted': "description: 'It''s here.'",
  'folded block': 'description: >\n  one\n  two\n\n  three\n',
  'folded block, strip': 'description: >-\n  one\n  two',
  'folded block, keep': 'description: >+\n  one\n\n',
  'folded block, more indented': 'description: >\n  one\n    two\n  three',
  'literal block': 'description: |\n  one\n  two',
  'literal block, strip': 'description: |-\n  one\n   two',
  'literal block, indent digit': 'description: |2\n   one\n  two',
}

describe('frontmatterDescription', () => {
  it.each(Object.entries(FORMS))('reads a %s description as YAML does', (_, body) => {
    const file = doc(body)
    const want = yamlDescription(file)
    expect(typeof want).toBe('string')
    expect(frontmatterDescription(file)).toBe(want)
  })

  it.each([
    ['an alias', 'description: *a'],
    ['a tag', 'description: !!str x'],
    ['a flow sequence', 'description: [a, b]'],
    ['a mapping', 'description: a: b'],
    ['an unterminated quote', 'description: "open'],
    ['text after a quote', 'description: "a" b'],
    ['an unknown escape', 'description: "\\q"'],
    ['a key given twice', 'description: a\ndescription: b'],
    ['a comment after a plain value', 'description: Use it. # not this'],
    ['a double-quoted value over lines', 'description: "one\n  two"'],
    ['a single-quoted value over lines', "description: 'one\n  two'"],
    ['a block holding a line of spaces', 'description: |\n  one\n   \n  two'],
    ['a plain value starting with an indicator', 'description: - a'],
  ])('gives nothing for %s', (_, body) => {
    expect(frontmatterDescription(doc(body))).toBeUndefined()
  })

  it('gives nothing without frontmatter, or without the key', () => {
    expect(frontmatterDescription('description: x\n')).toBeUndefined()
    expect(frontmatterDescription('---\nname: x\n---\ndescription: x\n')).toBeUndefined()
  })

  it('never disagrees with YAML on random descriptions', () => {
    let seed = 7
    const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n)
    const ALPHABET = ['a', 'B', ' ', '"', "'", '\\', ':', '#', '-', '\n  ', '\n\n  ', 't', 'u', 'é']
    const wrap = ['', '"', "'", '>\n  ', '>-\n  ', '|\n  ', '|-\n  ']
    let answered = 0
    for (let n = 0; n < 3000; n++) {
      const w = wrap[rand(wrap.length)]!
      let v = ''
      for (let k = 1 + rand(30); k > 0; k--) v += ALPHABET[rand(ALPHABET.length)]
      const close = w === '"' || w === "'" ? w : ''
      const file = doc(`description: ${w}${v}${close}`)
      const got = frontmatterDescription(file)
      if (got === undefined) continue
      answered++
      expect({ file, got }).toEqual({ file, got: yamlDescription(file) })
    }
    expect(answered).toBeGreaterThan(300)
  })
})
