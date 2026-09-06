// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { handleKdfRequest } from './kdfWorker.js'

describe('handleKdfRequest', () => {
  it('derives a key and reports it as ok', async () => {
    const salt = crypto.getRandomValues(new Uint8Array(16))
    const result = await handleKdfRequest({
      passphrase: 'a-real-passphrase',
      salt,
      iterations: 1000,
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.key).toBeInstanceOf(CryptoKey)
  })

  // The main-thread caller distinguishes a derivation failure from a
  // successful derive by this flag, not by whether the promise settles — the
  // worker boundary means a thrown error inside the worker doesn't
  // automatically become a rejected promise on the other side.
  it('reports a derivation failure as ok:false with a message, rather than throwing', async () => {
    const salt = crypto.getRandomValues(new Uint8Array(16))
    // iterations: 0 is rejected by WebCrypto's PBKDF2 implementation.
    const result = await handleKdfRequest({ passphrase: 'x', salt, iterations: 0 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.length).toBeGreaterThan(0)
  })
})
