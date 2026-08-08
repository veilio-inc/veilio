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

  // Hardcoded rather than compared against CURRENT_FILE_KDF, which would make
  // this tautological: a silent change to the constant should fail here.
  it('records the KDF parameters it used', { timeout: 15_000 }, async () => {
    const file = JSON.parse(await exportMap({ __P1__: 'X' }, 'pw'))
    expect(file.kdf).toEqual({ name: 'PBKDF2-SHA256', iterations: 600_000 })
  })

  // A real .veilio file captured from before parameters were recorded:
  // encrypted at the legacy 100k iterations, with no kdf field. FROZEN ON
  // PURPOSE — do not regenerate it. Rebuilding this fixture with the current
  // code would make it re-encrypt at the current cost and quietly stop testing
  // anything, which is precisely how a cost increase would ship having silently
  // orphaned every .veilio file already on a user's disk.
  const LEGACY_FILE = {
    v: 1,
    alg: 'AES-256-GCM-PBKDF2',
    salt: 'tKulO4yTGC7keBxb//eO4Q==',
    iv: 'dFFe2/R28m70GJZ2',
    data: '3Eq4s85IfR6/d7ohzGYEM7ys6lzoB4KTdYsrUQ9V44gf2r25PE8rA99Kf2q8RkyDeWfyE3BEo+6qYkDVR3xIEg==',
  }
  const LEGACY_PASSPHRASE = 'legacy-passphrase'
  const LEGACY_MAP = { __P1__: 'LegacyService', __P2__: 'chargeCard' }

  it(
    'imports a file written before KDF parameters were recorded',
    { timeout: 15_000 },
    async () => {
      expect(await importMap(JSON.stringify(LEGACY_FILE), LEGACY_PASSPHRASE)).toEqual(LEGACY_MAP)
    }
  )

  // The file records 100k while new files are written at a higher cost, so this
  // only passes if the recorded value drives derivation instead of the current
  // constant. That is the whole point of recording them.
  it(
    'derives with the parameters recorded in the file, not the current ones',
    { timeout: 15_000 },
    async () => {
      const recorded = { ...LEGACY_FILE, kdf: { name: 'PBKDF2-SHA256', iterations: 100_000 } }
      expect(await importMap(JSON.stringify(recorded), LEGACY_PASSPHRASE)).toEqual(LEGACY_MAP)
    }
  )

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
