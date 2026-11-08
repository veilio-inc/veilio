import { describe, it, expect } from 'vitest'
import { anonymize, restore, extractIdentifiers } from '../src/engine.js'

// Comments are natural-language prose; masking their words turns the output into
// what reads as ciphertext (`// → __P5__ __P6__ it …`) and trips downstream-AI
// refusals. Identifiers inside STRING literals are still masked on purpose (see
// engine.edge.test.ts) — that privacy behavior must be preserved.

describe('anonymize leaves comments unmasked', () => {
  it('does not mask words inside a line comment', () => {
    const { anonymized, map } = anonymize(
      'const userToken = grabToken() // resolve the credential later'
    )
    expect(anonymized).toContain('// resolve the credential later')
    // a word that lives ONLY in the comment never enters the map
    expect(Object.values(map)).not.toContain('credential')
  })

  it('does not mask words inside a block comment', () => {
    const { anonymized } = anonymize('/* returns the orderRecord */\nconst valueHolder = compute()')
    expect(anonymized).toContain('/* returns the orderRecord */')
  })

  it('still masks the code around a comment', () => {
    const { anonymized } = anonymize('const secretHandle = 1 // a note')
    expect(anonymized).not.toContain('secretHandle')
    expect(anonymized).toContain('// a note')
  })

  it('round-trips code that contains a comment', () => {
    const original = [
      'function shipOrder(orderId) {',
      '  // look up the order before shipping',
      '  return database.dispatchOrder(orderId)',
      '}',
    ].join('\n')
    const { anonymized, map } = anonymize(original)
    expect(anonymized).toContain('// look up the order before shipping')
    expect(anonymized).not.toContain('shipOrder')
    const { restored } = restore(anonymized, map)
    expect(restored).toBe(original)
  })

  it('treats a quote inside a comment as plain text (scanner recovers)', () => {
    const { anonymized } = anonymize("// the user's payload\nconst greetingBanner = 2")
    expect(anonymized).toContain("// the user's payload")
    expect(anonymized).not.toContain('greetingBanner')
  })
})

describe('anonymize still masks strings (intentional privacy behavior preserved)', () => {
  it('masks an identifier inside a double-quoted string', () => {
    const { anonymized } = anonymize('const logLine = "PaymentService failed"')
    expect(anonymized).not.toContain('PaymentService')
  })

  it('does not treat // inside a string as a comment', () => {
    // If `//` started a comment, PaymentService would be "in a comment" and
    // survive. It must still be masked because it's inside a string literal.
    const { anonymized } = anonymize('const endpoint = "x//PaymentService"')
    expect(anonymized).not.toContain('PaymentService')
  })
})

describe('extractIdentifiers', () => {
  it('excludes words inside comments but keeps words inside strings', () => {
    const ids = extractIdentifiers('const realVariable = "stringName" // commentName')
    expect(ids).toContain('realVariable')
    expect(ids).toContain('stringName')
    expect(ids).not.toContain('commentName')
  })
})

// Spec 085 L7 (security audit run-1): in masking, a regex literal holding `//`
// or `/*`, a PHP 8 attribute and a Ruby `=begin` after other text were read
// as the start of a comment, so the code after them went to the model as
// written. Each fixture with its language and with none.
describe('code that only looks like a comment opener is masked as code (L7)', () => {
  const NAMES = /PaymentGateway|chargeCustomer|Fake-Value-123/
  const cases: [string, string, 'typescript' | 'php' | 'ruby'][] = [
    [
      'a regex literal ending in `\\//`',
      "const host = url.replace(/^https?:\\/\\//, ''); notify(PaymentGateway)\nexport class PaymentGateway {}",
      'typescript',
    ],
    [
      'a regex literal holding `\\/*`',
      "const trim = (p: string) => p.replace(/\\/*$/, '')\nexport class PaymentGateway { chargeCustomer() {} }",
      'typescript',
    ],
    [
      'a credential after the `\\/*` regex',
      "const trim = (p: string) => p.replace(/\\/*$/, '')\nconst apiSecretValue = 'Fake-Value-123'\nexport class PaymentGateway {}",
      'typescript',
    ],
    [
      'a division before a `\\/*` regex on the same line',
      "const half = size / 2; const trim = p.replace(/\\/*$/, '')\nexport class PaymentGateway {}",
      'typescript',
    ],
    [
      'a PHP 8 attribute',
      '<?php\n#[ORM\\Entity(repositoryClass: PaymentGatewayRepository::class)]\nclass PaymentGateway {}',
      'php',
    ],
    [
      'a Ruby `=begin` after other text',
      'state=begin_transfer(PaymentGateway)\nclass PaymentGateway; end',
      'ruby',
    ],
  ]
  for (const [what, code, language] of cases) {
    it(`${what}, as ${language}`, () => {
      expect(anonymize(code, { language }).anonymized).not.toMatch(NAMES)
    })
    it(`${what}, with no language given`, () => {
      expect(anonymize(code).anonymized).not.toMatch(NAMES)
    })
  }

  it('real comments are left as they were', () => {
    const ts = anonymize(
      'const ratio = totalAmount / itemCount // keep the PaymentGateway note\n' +
        '// see https://example.invalid/x for PaymentGateway\n' +
        '/* block about PaymentGateway */\nconst y = 1',
      { language: 'typescript' }
    ).anonymized
    expect(ts).toContain('// keep the PaymentGateway note')
    expect(ts).toContain('// see https://example.invalid/x for PaymentGateway')
    expect(ts).toContain('/* block about PaymentGateway */')
    const rb = anonymize('=begin\nNotes on PaymentGateway.\n=end\nvalue = 1', { language: 'ruby' })
    expect(rb.anonymized).toContain('Notes on PaymentGateway.')
    const php = anonymize('<?php\n# a note on PaymentGateway\n$value = 1;', { language: 'php' })
    expect(php.anonymized).toContain('# a note on PaymentGateway')
  })

  // FR-008 / SC-005: a regex literal with no comment opener reads exactly as
  // on the base engine (ba947f3), quirks included: its quote opens a string.
  it('a regex literal holding only a quote reads as it always did', () => {
    const code =
      "const quoteMark = /'/g; const total = 1 // PaymentGateway note\nexport class PaymentGateway {}"
    expect(anonymize(code, { language: 'typescript' }).anonymized).toBe(
      "const __VAR__1 = /'/g; const __STR__1 = 1 // __CLS__1 __STR__2\nexport class __CLS__1 {}"
    )
  })

  it('a Ruby block opened at a line start closes only at a line-start =end', () => {
    const rb = anonymize(
      '=begin\nstate=end_transfer is prose on PaymentGateway\n=end\nclass PaymentGateway; end',
      {
        language: 'ruby',
      }
    ).anonymized
    expect(rb).toContain('state=end_transfer is prose on PaymentGateway')
    expect(rb).not.toMatch(/class PaymentGateway/)
  })
})
