// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { deriveKeyMaterial, ALG } from './kdfWork.js'

// spec 007-e11-derive-off, SC-002: "Encrypt/decrypt round trips produce
// identical artifacts to the pre-change implementation, proven by a test
// using fixed salt and parameters." Moving derivation into a Worker (kdfWorker.ts)
// must not change a single derived byte — this is the anti-regression that
// matters most, frozen the same way the legacy .veilio fixture in
// localCrypto.test.ts is: computed once, hardcoded, and never regenerated.
// Regenerating it from the current code would make a real algorithm change
// pass silently, which is exactly the failure mode a fixed vector exists to
// catch.
const PASSPHRASE = 'fixed-vector-passphrase'
const SALT = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16])
const IV = new Uint8Array([100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111])
const ITERATIONS = 1000
const PLAINTEXT = 'fixed-vector-plaintext'

const EXPECTED_CIPHERTEXT_BASE64 = 'vOx0VZH5y0obDIjCLBuyNHuKCXpsiiDUW3W2pnSNpPRDpLqGR4Y='

describe('deriveKeyMaterial — fixed vector (spec 007-e11 SC-002)', () => {
  // deriveKeyMaterial derives a non-extractable key by design (it is never
  // meant to leave the worker as raw bytes), so the key itself cannot be
  // exported and compared directly. Encrypting a fixed plaintext under a
  // fixed IV is the byte-for-byte proof instead: AES-GCM's ciphertext is
  // fully determined by key + IV + plaintext, so matching ciphertext is
  // exactly as strong a guarantee as matching key bytes would have been.
  it('produces the exact same ciphertext for a fixed IV and plaintext', async () => {
    const key = await deriveKeyMaterial(PASSPHRASE, SALT, ITERATIONS)
    const ciphertext = await crypto.subtle.encrypt(
      { name: ALG, iv: IV },
      key,
      new TextEncoder().encode(PLAINTEXT)
    )
    expect(Buffer.from(ciphertext).toString('base64')).toBe(EXPECTED_CIPHERTEXT_BASE64)
  })

  it('decrypts the frozen ciphertext back to the known plaintext', async () => {
    // The other direction: proves EXPECTED_CIPHERTEXT_BASE64 isn't just
    // whatever encrypt happened to return, but genuinely round-trips.
    const key = await deriveKeyMaterial(PASSPHRASE, SALT, ITERATIONS)
    const ciphertext = Uint8Array.from(Buffer.from(EXPECTED_CIPHERTEXT_BASE64, 'base64'))
    const plaintext = await crypto.subtle.decrypt({ name: ALG, iv: IV }, key, ciphertext)
    expect(new TextDecoder().decode(plaintext)).toBe(PLAINTEXT)
  })
})
