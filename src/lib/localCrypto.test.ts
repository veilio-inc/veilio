// @vitest-environment jsdom
//
// This module is browser code, so it is exercised in a browser-like realm
// rather than bare Node. That matters beyond realism: values crossing the
// jsdom realm boundary fail `instanceof` checks against Node's own globals, so
// a node-environment run silently skips the very code paths that break in
// practice. The rest of the suite (the engine) stays on the default env.
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

  it('records the KDF parameters it used', async () => {
    const file = JSON.parse(await exportMap({ __P1__: 'X' }, 'pw'))
    expect(file.kdf).toEqual({ name: 'PBKDF2-SHA256', iterations: 100_000 })
  })

  // Files exported before the parameters were recorded have no kdf field. They
  // were written at the legacy iteration count and must keep importing, or the
  // change orphans every .veilio file already on a user's disk.
  it('imports a legacy file that predates recorded KDF parameters', async () => {
    const plain = { __P1__: 'LegacyService' }
    const file = JSON.parse(await exportMap(plain, 'pw'))
    delete file.kdf
    expect(await importMap(JSON.stringify(file), 'pw')).toEqual(plain)
  })

  it('refuses a file whose KDF parameters would pin the browser', async () => {
    const file = JSON.parse(await exportMap({ __P1__: 'X' }, 'pw'))
    file.kdf = { name: 'PBKDF2-SHA256', iterations: 1_000_000_000 }
    await expect(importMap(JSON.stringify(file), 'pw')).rejects.toThrow(/iteration count/i)
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
