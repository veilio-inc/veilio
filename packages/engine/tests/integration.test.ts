// Tests that import from the package entry point — exercises src/index.ts re-exports
// AND verifies the public API contract that npm consumers will see.

import { describe, it, expect } from 'vitest'
import {
  anonymize,
  restore,
  extractIdentifiers,
  type SymbolMap,
} from '../src/index.js'

describe('public API surface (via package entry point)', () => {
  it('exports anonymize, restore, extractIdentifiers as functions', () => {
    expect(typeof anonymize).toBe('function')
    expect(typeof restore).toBe('function')
    expect(typeof extractIdentifiers).toBe('function')
  })

  it('round-trip via the package entry point', () => {
    const { anonymized, map } = anonymize('class PaymentService { processRefund() {} }')
    const { restored } = restore(anonymized, map)
    expect(restored).toContain('PaymentService')
    expect(restored).toContain('processRefund')
  })
})

describe('SymbolMap type contract', () => {
  it('a SymbolMap is a plain Record<string, string>', () => {
    const m: SymbolMap = { __P1__: 'Foo', __P2__: 'Bar' }
    expect(Object.keys(m)).toHaveLength(2)
    expect(m.__P1__).toBe('Foo')
  })
})
