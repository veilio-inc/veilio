import { describe, it, expect } from 'vitest'
import { anonymize, restore } from '../src/index.js'
import type { Language, SymbolMap } from '../src/index.js'

// Every comment form of every language the engine reads: a name the code
// declares is written as the code's placeholder in the comment, and the file
// restores exactly.

interface Sample {
  code: string
  cls: string
  fn: string
}

const SAMPLES: Record<Language, Sample> = {
  typescript: {
    code: 'export class QuasarLedger {\n  settleInvoice() { return 1 }\n}\n',
    cls: 'QuasarLedger',
    fn: 'settleInvoice',
  },
  go: {
    code: 'type QuasarLedger struct{}\n\nfunc SettleInvoice(q QuasarLedger) int { return 1 }\n',
    cls: 'QuasarLedger',
    fn: 'SettleInvoice',
  },
  java: {
    code: 'public class QuasarLedger {\n  int settleInvoice() { return 1; }\n}\n',
    cls: 'QuasarLedger',
    fn: 'settleInvoice',
  },
  csharp: {
    code: 'public class QuasarLedger {\n  int settleInvoice() { return 1; }\n}\n',
    cls: 'QuasarLedger',
    fn: 'settleInvoice',
  },
  rust: {
    code: 'struct QuasarLedger;\n\nfn settle_invoice(q: QuasarLedger) -> i32 { 1 }\n',
    cls: 'QuasarLedger',
    fn: 'settle_invoice',
  },
  c: {
    code: 'struct QuasarLedger { int id; };\n\nint settleInvoice(struct QuasarLedger *q) { return 1; }\n',
    cls: 'QuasarLedger',
    fn: 'settleInvoice',
  },
  python: {
    code: 'class QuasarLedger:\n    def settle_invoice(self):\n        return 1\n',
    cls: 'QuasarLedger',
    fn: 'settle_invoice',
  },
  ruby: {
    code: 'class QuasarLedger\n  def settle_invoice\n    1\n  end\nend\n',
    cls: 'QuasarLedger',
    fn: 'settle_invoice',
  },
  php: {
    code: '<?php\nclass QuasarLedger {\n  function settleInvoice() { return 1; }\n}\n',
    cls: 'QuasarLedger',
    fn: 'settleInvoice',
  },
  sql: {
    code: 'CREATE TABLE quasar_ledger (settled_total INT);\n',
    cls: 'quasar_ledger',
    fn: 'settled_total',
  },
}

const FORMS: Record<string, (text: string) => string> = {
  '//': (t) => `// ${t}\n`,
  '///': (t) => `/// ${t}\n`,
  '/* */': (t) => `/* ${t} */\n`,
  '/** */': (t) => `/**\n * ${t}\n */\n`,
  '#': (t) => `# ${t}\n`,
  '--': (t) => `-- ${t}\n`,
  '"""': (t) => `"""${t}."""\n`,
  "'''": (t) => `'''${t}.'''\n`,
  '=begin': (t) => `=begin\n${t}\n=end\n`,
}

const CELLS: Array<[Language, string]> = [
  ['typescript', '//'],
  ['typescript', '/* */'],
  ['typescript', '/** */'],
  ['go', '//'],
  ['go', '/* */'],
  ['java', '//'],
  ['java', '/* */'],
  ['java', '/** */'],
  ['csharp', '//'],
  ['csharp', '/* */'],
  ['csharp', '///'],
  ['rust', '//'],
  ['rust', '/* */'],
  ['rust', '///'],
  ['c', '//'],
  ['c', '/* */'],
  ['python', '#'],
  ['python', '"""'],
  ['python', "'''"],
  ['ruby', '#'],
  ['ruby', '=begin'],
  ['php', '//'],
  ['php', '#'],
  ['php', '/* */'],
  ['php', '/** */'],
  ['sql', '--'],
  ['sql', '/* */'],
]

const exact = (code: string, map: SymbolMap): string =>
  restore(code, map, { strip: 'none' }).restored

const placeholderOf = (map: SymbolMap, name: string): string =>
  Object.keys(map).find((p) => map[p] === name) ?? `<${name} is not in the map>`

/** `text` with each name the map holds, standing whole, as its placeholder. */
const withPlaceholders = (text: string, map: SymbolMap): string =>
  Object.entries(map).reduce(
    (out, [placeholder, name]) =>
      out.replace(
        new RegExp(`(?<![\\p{L}\\p{N}_$])${name}(?![\\p{L}\\p{N}_$])`, 'gu'),
        () => placeholder
      ),
    text
  )

describe('the language matrix', () => {
  it('has 27 cells over ten languages', () => {
    expect(CELLS).toHaveLength(27)
    expect(new Set(CELLS.map(([language]) => language)).size).toBe(10)
  })

  it.each(CELLS)(
    '%s %s: the names in the comment are the placeholders of the code',
    (language, form) => {
      const { code, cls, fn } = SAMPLES[language]
      // (a) the code alone masks both names, so the cell cannot pass by default
      const bare = anonymize(code, { language })
      expect(Object.values(bare.map)).toEqual(expect.arrayContaining([cls, fn]))
      expect(bare.anonymized).not.toContain(cls)
      expect(bare.anonymized).not.toContain(fn)

      const comment = FORMS[form](`${cls} settles what is due through ${fn}`)
      // PHP reads nothing before its opening tag.
      const [head, body] = language === 'php' ? ['<?php\n', code.slice(6)] : ['', code]
      const input = `${head}${comment}${body}`
      const { anonymized, map } = anonymize(input, { language })
      // (b) neither name is in the output
      expect(anonymized).not.toContain(cls)
      expect(anonymized).not.toContain(fn)
      // (c) the comment carries the code's placeholders, and nothing else moved
      expect(map).toEqual(bare.map)
      expect(anonymized).toBe(
        `${head}${FORMS[form](
          `${placeholderOf(map, cls)} settles what is due through ${placeholderOf(map, fn)}`
        )}${bare.anonymized.slice(head.length)}`
      )
      // (d) and it comes back as written
      expect(exact(anonymized, map)).toBe(input)
    }
  )
})

describe('edge forms', () => {
  const TS = { language: 'typescript' } as const
  const CODE = 'class QuasarLedger {\n  settleInvoice(invoiceId) { return invoiceId }\n}\n'

  /** Masks `comment + CODE` and expects the comment with the code's placeholders. */
  const expectMasked = (comment: string, language: Language = 'typescript'): void => {
    const bare = anonymize(CODE, { language })
    const { anonymized, map } = anonymize(comment + CODE, { language })
    expect(map).toEqual(bare.map)
    expect(anonymized).toBe(withPlaceholders(comment, map) + bare.anonymized)
    expect(anonymized).not.toContain('QuasarLedger')
    expect(anonymized).not.toContain('settleInvoice')
    expect(exact(anonymized, map)).toBe(comment + CODE)
  }

  it('an unterminated block comment runs to the end of the file, names replaced', () => {
    const input = `${CODE}/* QuasarLedger and settleInvoice, never closed\n`
    const { anonymized, map } = anonymize(input, TS)
    expect(anonymized).toBe(
      `${anonymize(CODE, TS).anonymized}/* __CLS__1 and __FN__1, never closed\n`
    )
    expect(exact(anonymized, map)).toBe(input)
  })

  it('a nested block: the comment ends at the first close, the rest is code as before', () => {
    const input = '/* a /* QuasarLedger */ QuasarLedger */\nstruct QuasarLedger;\n'
    const { anonymized, map } = anonymize(input, { language: 'rust' })
    expect(anonymized).toBe('/* a /* __CLS__1 */ __CLS__1 */\nstruct __CLS__1;\n')
    expect(exact(anonymized, map)).toBe(input)
  })

  it.each([
    ['typescript', 'const note = "// QuasarLedger"\nclass QuasarLedger {}\n', '"// __CLS__1"'],
    ['python', "note = '# QuasarLedger'\nclass QuasarLedger:\n    pass\n", "'# __CLS__1'"],
  ] as const)(
    '%s: a string holding a comment opener is a string, masked as before',
    (language, input, masked) => {
      const { anonymized, map, comments } = anonymize(input, { language })
      expect(anonymized).toContain(masked)
      expect(anonymized).not.toContain('QuasarLedger')
      expect(comments.total).toBe(0)
      expect(exact(anonymized, map)).toBe(input)
    }
  )

  it('a string inside a comment', () => {
    expectMasked(`// see "QuasarLedger" and 'settleInvoice'\n`)
  })

  it('backticks in a comment', () => {
    expectMasked('// call `settleInvoice()` on a `QuasarLedger`\n')
  })

  it.each(['typescript', 'java'] as const)(
    '%s: doc tags keep their words, the names after them are masked',
    (language) => {
      const comment =
        '/**\n * @param invoiceId the id\n * {@link QuasarLedger}\n * @see QuasarLedger#settleInvoice\n */\n'
      expectMasked(comment, language)
      const { anonymized } = anonymize(comment + CODE, { language })
      expect(anonymized).toMatch(/@param __VAR__\d+ the id/)
      expect(anonymized).toMatch(/\{@link __CLS__\d+\}/)
      expect(anonymized).toMatch(/@see __CLS__\d+#__FN__\d+/)
    }
  )

  it('a URL, a path and an email address: the held names in them are masked, the rest left', () => {
    expectMasked(
      '// https://acme.example/docs/QuasarLedger.html src/billing/settleInvoice.ts dev@QuasarLedger.example\n'
    )
    const { anonymized } = anonymize(
      '// https://acme.example/docs/QuasarLedger.html src/billing/settleInvoice.ts dev@QuasarLedger.example\n' +
        CODE,
      TS
    )
    expect(anonymized.split('\n')[0]).toBe(
      '// https://acme.example/docs/__CLS__1.html src/billing/__FN__1.ts dev@__CLS__1.example'
    )
  })

  it('a licence header naming a held name: masked, and not counted inside the body', () => {
    expectMasked('// Copyright the QuasarLedger authors. All rights reserved.\n\n')
    const { comments } = anonymize(
      `// Copyright the QuasarLedger authors. All rights reserved.\n\n${CODE}`,
      TS
    )
    expect(comments).toMatchObject({ total: 1, inline: 0 })
  })

  it('a URL in code position is not a comment: masked as code, as before', () => {
    const input = `Fetched https://acme.example/QuasarLedger/settleInvoice today\n${CODE}`
    const { anonymized, map, comments } = anonymize(input, TS)
    expect(anonymized.split('\n')[0]).toMatch(/^Fetched https:\/\/\S+\/__CLS__1\/__FN__1 today$/)
    expect(comments.total).toBe(0)
    expect(exact(anonymized, map)).toBe(input)
  })

  it('limit (spec 082): an identifier with letters outside ASCII is masked nowhere', () => {
    const input = 'const zażółć = 1; const größe = 2 // zażółć and größe\n'
    const { anonymized, map } = anonymize(input, TS)
    expect(anonymized).toBe(input)
    expect(map).toEqual({})
  })

  it('Polish and German prose around a held name: only the whole name changes', () => {
    const input =
      '// zażółć gęślą jaźń: fooBar w środku, größer als fooBar\nfunction run(fooBar) { return fooBar }\n'
    const { anonymized, map } = anonymize(input, TS)
    expect(anonymized.split('\n')[0]).toBe(
      '// zażółć gęślą jaźń: __VAR__1 w środku, größer als __VAR__1'
    )
    expect(exact(anonymized, map)).toBe(input)
  })
})
