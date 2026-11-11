import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { anonymize, restore, measureCommentExposure, isOrdinaryWord } from '../src/index.js'
import type { CustomRule, SymbolMap } from '../src/index.js'

// A name the map holds is written as its placeholder wherever it stands as a
// whole word in a comment; every other word of a comment is left as written,
// and a comment adds nothing to the map. One test per row of the rule (C1-C13).

const TS = { language: 'typescript' } as const

const PROBE = `/** QuasarLedgerReconciler settles Globex invoices via settleInvoice */
export class QuasarLedgerReconciler {
  // calls settleInvoice for AcmePay
  settleInvoice() { return 1 } // QuasarLedgerReconciler inline
}
`

const rule = (type: 'whitelist' | 'replace', pattern: string, placeholder?: string): CustomRule =>
  ({
    id: pattern,
    scope: 'personal',
    team_id: null,
    type,
    name: pattern,
    pattern,
    ...(placeholder ? { placeholder } : {}),
    enabled: true,
    sort_order: 0,
  }) as CustomRule

const exact = (code: string, map: SymbolMap): string =>
  restore(code, map, { strip: 'none' }).restored

/** The line of `text` that starts a comment with `opener`. */
const commentLine = (text: string, opener = '//'): string =>
  text.split('\n').find((l) => l.trimStart().startsWith(opener)) ?? ''

describe('a name the map holds is masked in a comment (C1, C2, C8, C9)', () => {
  it('the probe file: code and comments carry the same placeholders, and it restores exactly', () => {
    const { anonymized, map } = anonymize(PROBE, TS)
    expect(anonymized).toBe(`/** __CLS__1 settles Globex invoices via __FN__1 */
export class __CLS__1 {
  // calls __FN__1 for AcmePay
  __FN__1() { return 1 } // __CLS__1 inline
}
`)
    expect(map).toEqual({ __CLS__1: 'QuasarLedgerReconciler', __FN__1: 'settleInvoice' })
    expect(exact(anonymized, map)).toBe(PROBE)
  })

  it('C2: a name only the given map holds is masked, and the map gains nothing', () => {
    const given = { __CLS__7: 'LegacyBillingAdapter' }
    const code = '// talks to LegacyBillingAdapter and the gateway\nconst x = 1\n'
    const { anonymized, map } = anonymize(code, { ...TS, existingMap: given })
    expect(anonymized).toBe('// talks to __CLS__7 and the gateway\nconst x = 1\n')
    expect(map).toEqual(given)
    expect(exact(anonymized, map)).toBe(code)
  })

  it("C8: a replace rule's placeholder, given in code, stands in the comment too", () => {
    const code = '// Globex pays first\nfunction settleInvoice(Globex) {}\n'
    const { anonymized, map } = anonymize(code, {
      ...TS,
      rules: [rule('replace', 'Globex', '__CLIENT__')],
    })
    expect(map).toMatchObject({ __CLIENT__1: 'Globex' })
    expect(commentLine(anonymized)).toBe('// __CLIENT__1 pays first')
    expect(exact(anonymized, map)).toBe(code)
  })

  it('C9: an ordinary word a replace rule names is masked in the comment as in code', () => {
    expect(isOrdinaryWord('ledger')).toBe(true)
    const code = '// the ledger is closed\nfunction settle(ledger) { return ledger }\n'
    const { anonymized, map } = anonymize(code, {
      ...TS,
      rules: [rule('replace', 'ledger', '__CODENAME__')],
    })
    expect(map).toMatchObject({ __CODENAME__1: 'ledger' })
    expect(commentLine(anonymized)).toBe('// the __CODENAME__1 is closed')
    expect(exact(anonymized, map)).toBe(code)
  })

  it("a name before 's is masked: the apostrophe is not part of a word", () => {
    const code = "// QuasarLedgerReconciler's job\nclass QuasarLedgerReconciler {}\n"
    const { anonymized, map } = anonymize(code, TS)
    expect(commentLine(anonymized)).toBe("// __CLS__1's job")
    expect(exact(anonymized, map)).toBe(code)
  })

  it('masking the output again with the returned map changes nothing', () => {
    const first = anonymize(PROBE, TS)
    const again = anonymize(first.anonymized, { ...TS, existingMap: first.map })
    expect(first.anonymized).not.toContain('QuasarLedgerReconciler')
    expect(again.anonymized).toBe(first.anonymized)
    expect(again.map).toEqual(first.map)
  })
})

describe('the comment figure is measured on the output', () => {
  it('counts no placeholder: the probe file leaves 67 characters, not 137', () => {
    const { anonymized, comments } = anonymize(PROBE, TS)
    expect(comments).toEqual({ total: 3, inline: 2, characters: 67, severity: 'medium' })
    expect(comments).toEqual(measureCommentExposure(anonymized, 'typescript'))
  })

  it('a comment that held nothing but a masked name is not counted at all', () => {
    const { comments } = anonymize(
      'class QuasarLedgerReconciler {}\n// QuasarLedgerReconciler\n',
      TS
    )
    expect(comments.total).toBe(0)
    expect(comments.characters).toBe(0)
  })
})

describe('comment prose stays readable (C3-C7, C10, C11)', () => {
  const HELD = 'function run(fooBar, foo) { return fooBar + foo }\n'

  it('C3: a name inside a longer word of any script is left', () => {
    const line = '// żfooBar fooBarż Ωfoo fooBars fooBarBaz größe_fooBar $fooBar'
    const { anonymized, map } = anonymize(`${HELD}${line}\n`, TS)
    expect(Object.values(map)).toEqual(expect.arrayContaining(['fooBar', 'foo']))
    expect(commentLine(anonymized)).toBe(line)
  })

  it('C3: in a Polish and German sentence exactly the two whole names change', () => {
    const code = `${HELD}// zażółć gęślą jaźń: fooBar w środku, größer als fooBar\n`
    const { anonymized, map } = anonymize(code, TS)
    expect(commentLine(anonymized)).toBe(
      '// zażółć gęślą jaźń: __VAR__1 w środku, größer als __VAR__1'
    )
    expect(exact(anonymized, map)).toBe(code)
  })

  it('C4: a word that differs in case, or is a plural, is left', () => {
    const line = '// quasarLedgerReconciler, QuasarLedgerReconcilers and QUASAR_LEDGER'
    const { anonymized } = anonymize(`class QuasarLedgerReconciler {}\n${line}\n`, TS)
    expect(commentLine(anonymized)).toBe(line)
  })

  describe('C5: an ordinary word used as a name stays readable in the comment', () => {
    const line = '// the user sends a request; the handler computes the total'
    const code = `${line}\nfunction handler(user, request, total) { return user + request + total }\n`

    it('with no map', () => {
      expect(commentLine(anonymize(code, TS).anonymized)).toBe(line)
    })

    it('with an older map that still holds two of them', () => {
      const given = { __VAR__9: 'user', __FN__9: 'handler' }
      const { anonymized, map } = anonymize(code, { ...TS, existingMap: given })
      expect(commentLine(anonymized)).toBe(line)
      expect(map).toEqual(given)
    })

    it('with an older map, when this file only names them in the comment', () => {
      const given = { __VAR__9: 'user', __FN__9: 'handler' }
      const { anonymized, map } = anonymize(`${line}\nconst x = 1\n`, {
        ...TS,
        existingMap: given,
      })
      expect(commentLine(anonymized)).toBe(line)
      expect(map).toEqual(given)
    })
  })

  describe('C6: a one-word string literal in a comment', () => {
    it('lowercase: stays readable', () => {
      const line = '// each haulier is billed'
      const { anonymized, map } = anonymize(`const kind = 'haulier'\n${line}\n`, TS)
      expect(map).toEqual({ __STR__1: 'haulier' })
      expect(anonymized).toBe(`const kind = '__STR__1'\n${line}\n`)
    })

    it('lowercase, under a checkout-local placeholder: stays readable', () => {
      const line = '// each haulier is billed'
      const given = { __LOCAL_A1B2C3_STR__1: 'haulier' }
      const { anonymized } = anonymize(`const kind = 'haulier'\n${line}\n`, {
        ...TS,
        existingMap: given,
      })
      expect(anonymized).toBe(`const kind = '__LOCAL_A1B2C3_STR__1'\n${line}\n`)
    })

    it('capitalised: masked', () => {
      const code = "const kind = 'Contoso'\n// Contoso is billed\n"
      const { anonymized, map } = anonymize(code, TS)
      expect(anonymized).toBe("const kind = '__STR__1'\n// __STR__1 is billed\n")
      expect(exact(anonymized, map)).toBe(code)
    })
  })

  describe('C7: a name a whitelist rule matches', () => {
    const rules = [rule('whitelist', 'KeepMe')]
    const line = '// KeepMe stays'

    it('used in code: left in the comment as in code', () => {
      const { anonymized } = anonymize(`function run(KeepMe) {}\n${line}\n`, { ...TS, rules })
      expect(anonymized).toBe(`function run(KeepMe) {}\n${line}\n`)
    })

    it('held by the map and used only in the comment: left', () => {
      const given = { __CLS__4: 'KeepMe' }
      const { anonymized, map } = anonymize(`const x = 1\n${line}\n`, {
        ...TS,
        rules,
        existingMap: given,
      })
      expect(commentLine(anonymized)).toBe(line)
      expect(map).toEqual(given)
    })
  })

  it('C10: a keyword, a name in capitals and a two-letter name are left, whatever the map holds', () => {
    const line = '# def a handler; ACME_ID is the id'
    const given = { __FN__5: 'def', __VAR__5: 'ACME_ID', __VAR__6: 'id' }
    const { anonymized, map } = anonymize(`${line}\nx = 1\n`, {
      language: 'python',
      existingMap: given,
    })
    expect(commentLine(anonymized, '#')).toBe(line)
    expect(map).toEqual(given)
  })

  it('C11: a name the map does not hold is left, and nothing is minted for it', () => {
    const code = '// see UnknownBillingThing\nconst x = 1\n'
    const { anonymized, map } = anonymize(code, TS)
    expect(anonymized).toBe(code)
    expect(map).toEqual({})
  })

  it('C11: a replace rule does not reach a word that stands only in a comment', () => {
    const code = '// Globex pays first\nconst x = 1\n'
    const { anonymized, map } = anonymize(code, {
      ...TS,
      rules: [rule('replace', 'Globex', '__CLIENT__')],
    })
    expect(anonymized).toBe(code)
    expect(map).toEqual({})
  })
})

describe('placeholder-shaped text and credentials in a comment', () => {
  it('literal __CLS__1 with no map: new names are numbered above it and the literal is left', () => {
    const code =
      '// literal __CLS__1 beside QuasarLedgerReconciler\nclass QuasarLedgerReconciler {}\n'
    const { anonymized, map } = anonymize(code, TS)
    expect(map).toEqual({ __CLS__2: 'QuasarLedgerReconciler' })
    expect(anonymized).toBe('// literal __CLS__1 beside __CLS__2\nclass __CLS__2 {}\n')
    expect(exact(anonymized, map)).toBe(code)
  })

  it('unchanged: literal __CLS__1 with a map that holds it is read as masked text', () => {
    const given = { __CLS__1: 'HeldLedger' }
    const code = '// literal __CLS__1 here\nconst x = 1\n'
    const { anonymized, map } = anonymize(code, { ...TS, existingMap: given })
    expect(anonymized).toBe(code)
    expect(map).toEqual(given)
    expect(exact(anonymized, map)).toBe('// literal HeldLedger here\nconst x = 1\n')
  })

  it('C13: a credential in a comment is redacted as before, and the name beside it masked', () => {
    // Built from pieces so no scanner reads a token in this file.
    const token = ['ghp', '016C7e42F292c6912E7710c838347Ae178B4a'].join('_')
    const { anonymized, map } = anonymize(
      `// token ${token} used by fetchLedger\nfunction fetchLedger() {}\n`,
      TS
    )
    expect(anonymized).not.toContain(token)
    expect(anonymized).toMatch(/^\/\/ token __REDACTED_[A-Z0-9_]*__ used by __FN__1\n/)
    expect(map).toEqual({ __FN__1: 'fetchLedger' })
  })
})

describe('a comment adds nothing to the map', () => {
  // The names of each file, written again in comments the file did not have:
  // the map must be the one the file gives without them.
  const fixture = (name: string): string =>
    readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')

  it.each([
    ['the probe file', PROBE],
    ['fixtures/restore-cases.ts', fixture('restore-cases.ts')],
    ['fixtures/value-lexer.ts', fixture('value-lexer.ts')],
    ['fixtures/regulated.ts', fixture('regulated.ts')],
  ])('%s: the same map with and without comments naming its names', (_, code) => {
    const bare = anonymize(code, TS)
    const names = Object.values(bare.map).filter((n) => /^[A-Za-z_$][\w$]*$/.test(n))
    expect(names.length).toBeGreaterThan(0)
    const added = `\n// ${names.join(' ')} and UnknownBillingThing\n/* ${names.join(', ')} */\n`
    const { anonymized, map } = anonymize(code + added, TS)
    expect(map).toEqual(bare.map)
    expect(Object.keys(map)).toEqual(Object.keys(bare.map))
    expect(anonymized.startsWith(bare.anonymized)).toBe(true)
    // What a redacted credential makes inexact in the file itself stays so.
    expect(exact(anonymized, map)).toBe(exact(bare.anonymized, bare.map) + added)
  })

  it('the probe file with its comments removed gives the same map', () => {
    const bare = PROBE.replace(/\/\*\*.*\*\/\n/, '').replace(/ *\/\/.*$/gm, '')
    expect(bare).not.toContain('//')
    expect(anonymize(PROBE, TS).map).toEqual(anonymize(bare, TS).map)
  })
})

describe('masking names in comments stays linear', () => {
  const WORDS = 'the quick brown fox jumps over one lazy dog'
  const lines = (n: number): string =>
    `function quasarSettle(quasarLedger) { return quasarLedger }\n${Array.from(
      { length: n },
      (_, k) => `// ${WORDS} quasarSettle${k % 2 ? '' : 's'} quasarLedger`
    ).join('\n')}\n`
  const time = (code: string, existingMap?: SymbolMap): number => {
    const t = performance.now()
    anonymize(code, { ...TS, ...(existingMap ? { existingMap } : {}) })
    return performance.now() - t
  }

  it('2,000 against 8,000 comment lines', () => {
    const small = time(lines(2000))
    const large = time(lines(8000))
    expect(large / Math.max(small, 25)).toBeLessThan(10)
  })

  it('the same with a map of 5,000 names', () => {
    const held: SymbolMap = {}
    for (let k = 0; k < 5000; k++) held[`__VAR__${k + 1}`] = `quasarName${k}`
    const small = time(lines(2000), held)
    const large = time(lines(8000), held)
    expect(large / Math.max(small, 25)).toBeLessThan(10)
  })

  it('one comment line of 200,000 characters without a space', () => {
    const run = (n: number): string =>
      `function quasarSettle() {}\n// ${'quasarSettle_'.repeat(n)}\n`
    const small = time(run(4000))
    const large = time(run(16000))
    expect(run(16000).length).toBeGreaterThan(200_000)
    expect(large / Math.max(small, 25)).toBeLessThan(10)
  })
})
