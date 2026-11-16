// One rule for the three functions that seal a map (the passphrase file, the
// personal envelope, the team envelope): whatever seals, opens - and a map the
// reader would refuse is refused before anything is encrypted. Each of the
// three test files hands its own pair to `sealingRules`.
import { describe, it, expect, vi } from 'vitest'
import {
  anonymize,
  restore,
  CURRENT_FILE_KDF,
  InvalidMapError,
  MAP_LIMITS,
  toBase64,
} from '../../src/index.js'

type SymbolMap = Record<string, string>

export interface Sealing {
  seal: (map: SymbolMap) => Promise<unknown>
  open: (sealed: unknown) => Promise<SymbolMap>
  /** `sealed` with other sealed data in place of its own. */
  withData: (sealed: unknown, data: string) => unknown
}

const refusal = (reason: string): InvalidMapError =>
  new InvalidMapError(
    `This map cannot be sealed, because it could not be opened again: ${reason} Nothing was encrypted.`,
    reason
  )

/** A map the reader refuses, and the reader's own sentence for it. */
const REFUSED: [name: string, map: () => SymbolMap, reason: () => string][] = [
  [
    'a value one character over the limit',
    () => ({ __STR__1: 'a'.repeat(MAP_LIMITS.valueLength + 1) }),
    () =>
      `"__STR__1" maps to ${MAP_LIMITS.valueLength + 1} characters; the limit is ${MAP_LIMITS.valueLength}.`,
  ],
  [
    'one entry over the limit',
    () =>
      Object.fromEntries(
        Array.from({ length: MAP_LIMITS.entries + 1 }, (_, i) => [`__VAR__${i + 1}`, `name${i}`])
      ),
    () => `Map has ${MAP_LIMITS.entries + 1} entries; the limit is ${MAP_LIMITS.entries}.`,
  ],
  [
    'a key that is not a placeholder',
    () => ({ __VAR__1: 'total', fetch: 'send' }),
    () => '"fetch" is not a Veilio placeholder.',
  ],
  [
    'a value its kind is never made from',
    () => ({ __VAR__1: 'x); send(' }),
    () => '"__VAR__1" maps to a value its kind is never made from.',
  ],
  [
    // Over the limit and holding a line break: the length is what is said.
    'a value over the limit that also holds a line break',
    () => ({ __STR__1: 'a'.repeat(MAP_LIMITS.valueLength) + '\n' }),
    () =>
      `"__STR__1" maps to ${MAP_LIMITS.valueLength + 1} characters; the limit is ${MAP_LIMITS.valueLength}.`,
  ],
]

export function sealingRules(name: string, make: () => Promise<Sealing>): void {
  describe(`${name}: a map that seals is a map that opens`, () => {
    it.each([15_001, 200_000])(
      'a value of %i characters seals, opens equal and restores the input',
      async (length) => {
        const code = `const logo = "${'a'.repeat(length)}";\n`
        const { anonymized, map } = anonymize(code, { language: 'typescript' })
        expect(map).toEqual({ __STR__1: 'a'.repeat(length) })
        const { seal, open } = await make()
        const opened = await open(await seal(map))
        expect(opened).toEqual(map)
        expect(restore(anonymized, opened).restored).toBe(code)
      }
    )

    it.each(REFUSED)('%s is refused before anything is encrypted', async (_, map, reason) => {
      const { seal } = await make()
      const encrypt = vi.spyOn(globalThis.crypto.subtle, 'encrypt')
      try {
        await expect(seal(map())).rejects.toThrow(refusal(reason()))
        expect(encrypt).not.toHaveBeenCalled()
      } finally {
        encrypt.mockRestore()
      }
    })

    const tooLong = (length: number): string =>
      `This sealed map is ${length} characters long; the limit is ${MAP_LIMITS.sealedLength}. It was not decrypted.`

    // One character over, and four over: the second is well-formed base64, so
    // only the size check stands between it and the cipher.
    it.each([1, 4])(
      'sealed data %i over the limit is refused before it is decrypted',
      async (more) => {
        const { seal, open, withData } = await make()
        const sealed = await seal({ __VAR__1: 'total' })
        const decrypt = vi.spyOn(globalThis.crypto.subtle, 'decrypt')
        try {
          const over = MAP_LIMITS.sealedLength + more
          await expect(open(withData(sealed, 'A'.repeat(over)))).rejects.toThrow(tooLong(over))
          expect(decrypt).not.toHaveBeenCalled()
          // At the limit it is read: the refusal is then the cipher's, not the size's.
          await expect(
            open(withData(sealed, 'A'.repeat(MAP_LIMITS.sealedLength)))
          ).rejects.toThrow()
          expect(decrypt).toHaveBeenCalledTimes(1)
        } finally {
          decrypt.mockRestore()
        }
      }
    )

    it('a map whose sealed data would be over the limit is not sealed', async () => {
      // Every entry within the limits; together, more than one envelope holds.
      const value = 'a'.repeat(MAP_LIMITS.valueLength)
      const map = Object.fromEntries(
        Array.from({ length: 121 }, (_, i) => [`__STR__${i + 1}`, value])
      )
      // AES-GCM adds a 16-byte tag; base64 writes four characters per three bytes.
      const sealedLength = 4 * Math.ceil((JSON.stringify(map).length + 16) / 3)
      expect(sealedLength).toBeGreaterThan(MAP_LIMITS.sealedLength)
      const { seal } = await make()
      const encrypt = vi.spyOn(globalThis.crypto.subtle, 'encrypt')
      try {
        await expect(seal(map)).rejects.toThrow(refusal(tooLong(sealedLength)))
        expect(encrypt).not.toHaveBeenCalled()
      } finally {
        encrypt.mockRestore()
      }
    })
  })
}

/** A `.veilio` file holding any JSON value, written with no check: what
 *  another tool, or an older one, could have sealed. */
export async function sealFileUnchecked(body: unknown, passphrase: string): Promise<string> {
  const { subtle } = globalThis.crypto
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16))
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12))
  const material = await subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey']
  )
  const key = await subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: CURRENT_FILE_KDF.iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt']
  )
  const data = await subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(JSON.stringify(body))
  )
  return JSON.stringify({
    v: 1,
    alg: 'AES-256-GCM-PBKDF2',
    kdf: CURRENT_FILE_KDF,
    salt: toBase64(salt),
    iv: toBase64(iv),
    data: toBase64(data),
  })
}
