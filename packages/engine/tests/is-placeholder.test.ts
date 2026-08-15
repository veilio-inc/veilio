import { describe, it, expect } from 'vitest'
import { isPlaceholder, anonymize, ROLE_BASES, MANUAL_BASE } from '../src/index.js'

describe('isPlaceholder', () => {
  it('accepts every role base the engine mints', () => {
    for (const base of Object.values(ROLE_BASES)) {
      expect(isPlaceholder(`${base}1`), base).toBe(true)
      expect(isPlaceholder(`${base}42`), base).toBe(true)
    }
  })

  it('accepts a manual mark', () => {
    expect(isPlaceholder(`${MANUAL_BASE}1`)).toBe(true)
  })

  it('accepts the legacy plain style', () => {
    // Maps exported before role-typed placeholders existed use this. Refusing it
    // would make an old .veilio file unimportable, which is data loss.
    expect(isPlaceholder('__P1__')).toBe(true)
    expect(isPlaceholder('__P17__')).toBe(true)
  })

  it('accepts a base with no trailing number', () => {
    expect(isPlaceholder('__DEV__')).toBe(true)
  })

  it('accepts an underscored base', () => {
    expect(isPlaceholder('__API_KEY__7')).toBe(true)
  })

  it('agrees with what anonymize actually produces', () => {
    // The pattern is only useful if it matches the real thing rather than an
    // idea of it, so this asserts against live output instead of literals.
    const { map } = anonymize(
      'class InvoiceLedger { settleInvoice(discountRate) { return discountRate } }',
      { manual: ['InvoiceLedger'] }
    )

    expect(Object.keys(map).length).toBeGreaterThan(0)
    for (const key of Object.keys(map)) {
      expect(isPlaceholder(key), key).toBe(true)
    }
  })

  it('refuses ordinary identifiers and prose', () => {
    for (const token of ['settleInvoice', 'InvoiceLedger', 'foo', '', 'a b', '__lower__1']) {
      expect(isPlaceholder(token), token).toBe(false)
    }
  })

  it('refuses prototype-pollution keys', () => {
    // The uppercase-first rule is what makes this true; it is relied on when
    // validating an imported map, so it is asserted rather than assumed.
    for (const token of ['__proto__', 'constructor', 'prototype', '__PROTO__x']) {
      expect(isPlaceholder(token), token).toBe(false)
    }
  })

  it('refuses a token with surrounding whitespace or affixes', () => {
    for (const token of [' __FN__1', '__FN__1 ', 'x__FN__1', '__FN__1x', '__FN__1.5']) {
      expect(isPlaceholder(token), token).toBe(false)
    }
  })

  it('is stateless across calls', () => {
    // A /g regex reused with .test carries lastIndex between calls and returns
    // alternating answers. This pattern must not, and that is easy to regress.
    for (let i = 0; i < 5; i++) expect(isPlaceholder('__FN__1')).toBe(true)
  })
})
