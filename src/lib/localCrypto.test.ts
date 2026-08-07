import { describe, it, expect } from 'vitest'
import { exportMap, importMap } from './localCrypto.js'

// PBKDF2 with 100k iterations costs a few hundred ms per derive, so keep the
// round-trip count low and give these a longer timeout.

describe('exportMap / importMap', () => {
  it('round-trips a map with the correct passphrase', { timeout: 15_000 }, async () => {
    const plain = { __P1__: 'PaymentService', __P2__: 'chargeCard' }
    expect(await importMap(await exportMap(plain, 'pw'), 'pw')).toEqual(plain)
  })

  it('throws when imported with the wrong passphrase', { timeout: 15_000 }, async () => {
    const file = await exportMap({ __P1__: 'Secret' }, 'right-passphrase')
    await expect(importMap(file, 'wrong-passphrase')).rejects.toThrow()
  })

  // A real export — a whole project's symbol map — is far larger than the
  // handful of entries above, and the base64 step used to be written in a way
  // that blew the call stack once the ciphertext passed a few tens of KB.
  it('round-trips a map large enough to overflow a spread call', { timeout: 30_000 }, async () => {
    const big: Record<string, string> = {}
    for (let i = 0; i < 5000; i++) big[`__P${i}__`] = `VeryDescriptiveIdentifierName_${i}`
    const file = await exportMap(big, 'pw')
    expect(JSON.parse(file).data.length).toBeGreaterThan(64_000)
    expect(await importMap(file, 'pw')).toEqual(big)
  })
})
