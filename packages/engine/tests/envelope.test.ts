import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  sealMap,
  openMap,
  parseKdfParams,
  parseSymbolMap,
  assertUsablePassphrase,
  CURRENT_FILE_KDF,
  LEGACY_FILE_KDF,
  KdfParamsError,
  WeakPassphraseError,
  InvalidMapError,
  MIN_PASSPHRASE_LENGTH,
  fromBase64,
} from '../src/envelope.js'

const PASS = 'correct horse battery staple'
const FIXTURE = join(import.meta.dirname, 'fixtures', 'browser-sealed.veilio')

describe('parity with the browser implementation', () => {
  /**
   * The fixture was sealed by the Cloud frontend's localCrypto.ts, verbatim, and
   * committed. That is the whole reason this module lives in the engine: a map
   * sealed in a browser and opened from a terminal is the feature, and two
   * implementations of one format is the arrangement where one gets a parameter
   * change and the other does not.
   *
   * A live round-trip cannot catch that — it would agree with itself after any
   * change. Only a frozen artifact produced by the OTHER implementation can, and
   * only for as long as nobody regenerates it to make a failure go away. If this
   * test fails, the format changed and every previously exported file just became
   * unopenable; regenerating the fixture hides exactly the thing it exists to
   * show.
   */
  it('opens a file sealed by the browser', async () => {
    const map = await openMap(readFileSync(FIXTURE, 'utf8'), PASS)
    expect(map).toEqual({
      __CLS__1: 'PaymentGateway',
      __FN__1: 'chargeCard',
      __VAR__1: 'customerRef',
    })
  })

  it('seals what it can open again', async () => {
    const map = { __CLS__1: 'Alpha', __FN__2: 'beta' }
    expect(await openMap(await sealMap(map, PASS), PASS)).toEqual(map)
  })

  it('refuses the wrong passphrase rather than returning nonsense', async () => {
    await expect(openMap(readFileSync(FIXTURE, 'utf8'), 'wrong passphrase!')).rejects.toThrow()
  })

  it('writes a 16-byte salt and a 12-byte IV, as the browser does', async () => {
    // Both are recorded in the file, so a divergence here would still
    // interoperate — which is exactly why nothing else catches it. Stated so the
    // two implementations stay the same shape rather than merely compatible.
    const file = JSON.parse(await sealMap({ __CLS__1: 'A' }, PASS))
    expect(fromBase64(file.salt).length).toBe(16)
    expect(fromBase64(file.iv).length).toBe(12)
  })

  it('writes the parameters it used into the file', async () => {
    // The recording is what makes raising the cost a migration instead of data
    // loss. A file without it can only be read by guessing.
    const file = JSON.parse(await sealMap({ __CLS__1: 'A' }, PASS))
    expect(file.kdf).toEqual(CURRENT_FILE_KDF)
    expect(file.v).toBe(1)
    expect(file.alg).toBe('AES-256-GCM-PBKDF2')
  })
})

describe('key-derivation parameters', () => {
  it('falls back to the frozen legacy value when a file records none', () => {
    expect(parseKdfParams(undefined, LEGACY_FILE_KDF)).toEqual(LEGACY_FILE_KDF)
    expect(parseKdfParams(null, LEGACY_FILE_KDF)).toEqual(LEGACY_FILE_KDF)
  })

  it('keeps the legacy file cost frozen at what was actually used', () => {
    // Editing this to track CURRENT_FILE_KDF stops every pre-raise export
    // decrypting. It is a historical fact, not policy.
    expect(LEGACY_FILE_KDF.iterations).toBe(100_000)
    expect(CURRENT_FILE_KDF.iterations).toBe(600_000)
  })

  it('refuses an unknown KDF instead of deriving the wrong key', () => {
    expect(() => parseKdfParams({ name: 'scrypt', iterations: 1 }, LEGACY_FILE_KDF)).toThrow(
      KdfParamsError
    )
  })

  it('bounds an iteration count read off an untrusted file', () => {
    // The count drives a loop in the reader's process. A hostile file claiming a
    // billion would pin it.
    for (const bad of [0, -1, 1.5, 4_000_001, '600000', null]) {
      expect(
        () => parseKdfParams({ name: 'PBKDF2-SHA256', iterations: bad }, LEGACY_FILE_KDF),
        `${String(bad)} must be refused`
      ).toThrow(KdfParamsError)
    }
    expect(
      parseKdfParams({ name: 'PBKDF2-SHA256', iterations: 4_000_000 }, LEGACY_FILE_KDF)
    ).toEqual({ name: 'PBKDF2-SHA256', iterations: 4_000_000 })
  })
})

describe('the passphrase floor', () => {
  it('is enforced inside sealMap, not left to the caller', async () => {
    // Deliberately not at the call site: a future caller could then write a file
    // that skips the floor, and the file is the offline-attackable artifact.
    await expect(sealMap({ __CLS__1: 'A' }, 'short')).rejects.toThrow(WeakPassphraseError)
  })

  it('accepts exactly the minimum and rejects one below', () => {
    expect(() => assertUsablePassphrase('x'.repeat(MIN_PASSPHRASE_LENGTH))).not.toThrow()
    expect(() => assertUsablePassphrase('x'.repeat(MIN_PASSPHRASE_LENGTH - 1))).toThrow(
      WeakPassphraseError
    )
  })

  it('says why length is the lever', () => {
    expect(() => assertUsablePassphrase('short')).toThrow(/offline/)
  })
})

describe('a decrypted map is authenticated, not trusted', () => {
  it('refuses a key that is not a placeholder', () => {
    // Whatever a map holds is substituted into restored source that somebody
    // then pastes into an editor.
    expect(() => parseSymbolMap({ notAPlaceholder: 'x' })).toThrow(InvalidMapError)
  })

  it('refuses a non-string value', () => {
    expect(() => parseSymbolMap({ __CLS__1: 42 })).toThrow(InvalidMapError)
  })

  it('refuses anything that is not an object of entries', () => {
    for (const bad of [null, [], 'a string', 7]) {
      expect(() => parseSymbolMap(bad), `${JSON.stringify(bad)} must be refused`).toThrow(
        InvalidMapError
      )
    }
  })

  it('bounds one file rather than trusting its size', () => {
    const huge: Record<string, string> = {}
    for (let i = 0; i < 50_001; i++) huge[`__CLS__${i}`] = 'x'
    expect(() => parseSymbolMap(huge)).toThrow(/50000/)
    expect(() => parseSymbolMap({ __CLS__1: 'x'.repeat(10_001) })).toThrow(/10000/)
  })

  it('runs on the way OUT of openMap, not only when called directly', async () => {
    // The first version of this test asserted the version check instead, and a
    // mutation proved it: deleting parseSymbolMap from openMap left the whole
    // suite green. The validation has to sit on the path a real file takes, or
    // it is a function nobody calls.
    //
    // sealMap deliberately does not validate on the way in — it seals what it is
    // given — so a hostile map can be sealed and must be caught on open. That is
    // the real shape too: the file was written by someone else's tool.
    const hostile = await sealMap({ notAPlaceholder: 'rm -rf /' } as never, PASS)
    await expect(openMap(hostile, PASS)).rejects.toThrow(InvalidMapError)
  })

  it('still refuses a file whose envelope version it does not know', async () => {
    const sealed = await sealMap({ __CLS__1: 'A' }, PASS)
    await expect(openMap(sealed.replace('"v": 1', '"v": 2'), PASS)).rejects.toThrow(
      /Invalid .veilio file format/
    )
  })
})
