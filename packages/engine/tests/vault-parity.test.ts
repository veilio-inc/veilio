import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  CURRENT_VAULT_KDF,
  LEGACY_VAULT_KDF,
  VaultEnvelopeError,
  checkVaultVerifier,
  decryptMapFromVault,
  deriveVaultKey,
  encryptMapForVault,
  parseVaultEnvelope,
  randomVaultSalt,
  fromBase64,
  type VaultEnvelope,
} from '../src/index.js'

/**
 * The vault envelope, checked against something the browser actually produced.
 *
 * This is the test that matters, and the only kind that can catch the failure
 * this module exists to prevent. Two implementations of the same encryption
 * format do not fail loudly when they drift — they simply stop being able to
 * open each other's maps, and the first person to notice is a customer whose
 * terminal cannot read a map their browser wrote.
 *
 * `fixtures/browser-vault.json` was produced by running
 * `packages/frontend/src/lib/vaultCrypto.ts` verbatim, and is committed frozen.
 * Regenerating it to make this pass would be deleting the evidence.
 */

interface Fixture {
  passphrase: string
  salt: string
  kdf: { name: 'PBKDF2-SHA256'; iterations: number }
  envelope: VaultEnvelope
  verifier: string
  map: Record<string, string>
}

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/browser-vault.json', import.meta.url), 'utf8')
) as Fixture

describe('the engine opens what the browser sealed', () => {
  it('decrypts a browser-written envelope to the same map', async () => {
    const key = await deriveVaultKey(fixture.passphrase, fromBase64(fixture.salt), fixture.kdf)
    expect(await decryptMapFromVault(key, fixture.envelope)).toEqual(fixture.map)
  })

  it('accepts the browser’s verifier', async () => {
    const key = await deriveVaultKey(fixture.passphrase, fromBase64(fixture.salt), fixture.kdf)
    expect(await checkVaultVerifier(key, fixture.verifier)).toBe(true)
  })

  it('rejects the verifier under a different passphrase', async () => {
    // The allow half above passes against a verifier check that returns true
    // unconditionally, which is exactly the shape a mistake here would take.
    const wrong = await deriveVaultKey('not the passphrase', fromBase64(fixture.salt), fixture.kdf)
    expect(await checkVaultVerifier(wrong, fixture.verifier)).toBe(false)
  })

  it('uses the same parameters the browser does', async () => {
    // A drift in iterations derives a DIFFERENT key from the same passphrase and
    // reports nothing — the map simply stops opening. Pinned as a number so the
    // change is a visible diff rather than a silent re-derivation.
    expect(CURRENT_VAULT_KDF).toEqual({ name: 'PBKDF2-SHA256', iterations: 600_000 })
    expect(LEGACY_VAULT_KDF).toEqual({ name: 'PBKDF2-SHA256', iterations: 600_000 })
    expect(fixture.kdf.iterations).toBe(CURRENT_VAULT_KDF.iterations)
  })
})

describe('round trip and refusals', () => {
  it('seals and opens its own', async () => {
    const salt = randomVaultSalt()
    expect(salt).toHaveLength(32)
    const key = await deriveVaultKey('a perfectly good passphrase', salt)
    const map = { __CLS__1: 'Widget' }
    const sealed = await encryptMapForVault(key, map)
    expect(await decryptMapFromVault(key, sealed)).toEqual(map)
  })

  it('produces a different envelope every time, from the same input', async () => {
    // A fixed IV would make two encryptions of the same map identical, which
    // under AES-GCM is a catastrophic key-recovery failure rather than an
    // aesthetic one.
    const key = await deriveVaultKey('a perfectly good passphrase', randomVaultSalt())
    const a = await encryptMapForVault(key, { __CLS__1: 'Widget' })
    const b = await encryptMapForVault(key, { __CLS__1: 'Widget' })
    expect(a.iv).not.toBe(b.iv)
    expect(a.data).not.toBe(b.data)
  })

  it('refuses a wrong passphrase rather than returning nonsense', async () => {
    const salt = randomVaultSalt()
    const sealed = await encryptMapForVault(await deriveVaultKey('the right one entirely', salt), {
      __CLS__1: 'Widget',
    })
    const wrong = await deriveVaultKey('the wrong one entirely', salt)
    await expect(decryptMapFromVault(wrong, sealed)).rejects.toThrow()
  })

  it('names an unrecognised envelope instead of failing to decrypt it', async () => {
    // A future format must arrive as "unrecognized", not as something that
    // reads like a wrong passphrase and sends somebody hunting for it.
    const key = await deriveVaultKey('a perfectly good passphrase', randomVaultSalt())
    const sealed = await encryptMapForVault(key, { __CLS__1: 'Widget' })
    await expect(
      decryptMapFromVault(key, { ...sealed, v: 2 as unknown as 1 })
    ).rejects.toBeInstanceOf(VaultEnvelopeError)
    await expect(
      decryptMapFromVault(key, { ...sealed, alg: 'ROT13' as unknown as VaultEnvelope['alg'] })
    ).rejects.toBeInstanceOf(VaultEnvelopeError)
  })

  it('validates what comes out, not just that it decrypted', async () => {
    // Authenticated ciphertext proves the bytes came from the right key. It says
    // nothing about them being a symbol map, and a caller handed `["a"]` would
    // discover that somewhere much less convenient.
    const key = await deriveVaultKey('a perfectly good passphrase', randomVaultSalt())
    const notAMap = await encryptMapForVault(key, ['nope'] as unknown as Record<string, string>)
    await expect(decryptMapFromVault(key, notAMap)).rejects.toThrow()
  })

  it('parses a stored envelope string and rejects everything else', () => {
    const ok = parseVaultEnvelope(JSON.stringify(fixture.envelope))
    expect(ok).toEqual(fixture.envelope)
    for (const bad of [
      'not json',
      'null',
      '[]',
      '{"v":2,"alg":"AES-256-GCM-PBKDF2","iv":"a","data":"b"}',
      '{"v":1,"alg":"ROT13","iv":"a","data":"b"}',
      '{"v":1,"alg":"AES-256-GCM-PBKDF2","iv":1,"data":"b"}',
      '{"v":1,"alg":"AES-256-GCM-PBKDF2","iv":"a"}',
    ]) {
      expect(() => parseVaultEnvelope(bad), bad).toThrow(VaultEnvelopeError)
    }
  })
})
