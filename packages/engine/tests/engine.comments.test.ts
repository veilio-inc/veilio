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
