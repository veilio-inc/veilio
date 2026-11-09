import { describe, it, expect } from 'vitest'
import { anonymize } from '../src/engine.js'

// Spec 085 part 3, R2-6: an existing-map entry whose key is not a placeholder
// (a team map's `PaymentGateway: 'PaymentGateway'`) left that name unmasked.
// anonymize uses only entries keyed by a placeholder, whoever passed them.
describe('anonymize uses only placeholder-keyed existing entries (R2-6)', () => {
  it('a name mapped to itself is still masked', () => {
    const r = anonymize('class PaymentGateway {}\n', {
      existingMap: { PaymentGateway: 'PaymentGateway' },
    })
    expect(r.anonymized).not.toContain('PaymentGateway')
    expect(r.map).not.toHaveProperty('PaymentGateway')
  })

  it('a key that is any other text is not substituted', () => {
    const r = anonymize('const verify = isTrue\n', { existingMap: { verify: 'isTrue' } })
    expect(r.anonymized).not.toContain('= verify')
  })

  it('a placeholder-keyed entry is still used', () => {
    const r = anonymize('class PaymentGateway {}\n', {
      existingMap: { __CLS__7: 'PaymentGateway' },
    })
    expect(r.anonymized).toBe('class __CLS__7 {}\n')
  })
})
