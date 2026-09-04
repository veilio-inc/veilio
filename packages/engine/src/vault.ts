// Cloud-map encryption: the zero-knowledge envelope a personal map is stored in.
//
// Distinct from the FILE envelope in `envelope.ts`, and the difference is the
// salt. A `.veilio` file carries its own salt, because it must be openable by
// someone who has nothing but the file and the passphrase. A cloud map is keyed
// off a PER-ACCOUNT salt the server holds and hands out at `GET /api/auth/vault`
// — so one passphrase opens every map on the account, and the server never sees
// the passphrase or the key.
//
// This lives in the engine because two editions now need it. The browser has had
// it since the vault shipped; the CLI needs the identical thing to pull a map
// into a terminal. A second implementation of an encryption format is the
// failure mode the ROADMAP records as divergence-by-copy, and for crypto it is
// worse than usual: the two would not fail loudly when they drifted, they would
// simply stop being able to open each other's maps.
//
// Every parameter here matches `packages/frontend/src/lib/vaultCrypto.ts`
// exactly, and `vault-parity.test.ts` opens a fixture the browser produced.

import type { SymbolMap } from './types.js'
import {
  type KdfParams,
  parseSymbolMap,
  toBase64,
  fromBase64,
  webCryptoSubtle,
  randomBytes,
} from './envelope.js'

const ALG = 'AES-GCM'

/** The envelope's algorithm marker. Stored, checked, never inferred. */
export const VAULT_ENVELOPE_ALG = 'AES-256-GCM-PBKDF2' as const

/** What a NEW vault is created with. Matches the browser's `CURRENT_VAULT_KDF`. */
export const CURRENT_VAULT_KDF: KdfParams = { name: 'PBKDF2-SHA256', iterations: 600_000 }

/**
 * What a vault created before parameters were recorded must be read with.
 *
 * A historical fact, not policy. Editing it to track `CURRENT_VAULT_KDF` would
 * silently orphan every map encrypted under the old value — the derivation
 * yields a DIFFERENT key rather than an error, so nothing would report it.
 */
export const LEGACY_VAULT_KDF: KdfParams = { name: 'PBKDF2-SHA256', iterations: 600_000 }

/** Size of a vault salt, in bytes. 256 bits, per NIST. */
export const VAULT_SALT_BYTES = 32

export class VaultEnvelopeError extends Error {
  constructor(message = 'Unrecognized vault envelope') {
    super(message)
    this.name = 'VaultEnvelopeError'
  }
}

export interface VaultEnvelope {
  v: 1
  alg: typeof VAULT_ENVELOPE_ALG
  /** base64 */
  iv: string
  /** base64 ciphertext */
  data: string
}

/** A fresh vault salt. */
export function randomVaultSalt(): Uint8Array {
  return randomBytes(VAULT_SALT_BYTES)
}

/**
 * Derive the vault key.
 *
 * `kdf` comes from the server alongside the salt for an existing vault, and
 * defaults to the current parameters when minting a new one. Passing the WRONG
 * parameters yields a different key rather than an error — which is why a
 * verifier exists, and why nothing here tries to detect it.
 */
export async function deriveVaultKey(
  passphrase: string,
  salt: Uint8Array,
  kdf: KdfParams = CURRENT_VAULT_KDF
): Promise<CryptoKeyLike> {
  const subtle = webCryptoSubtle()
  const keyMaterial = await subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey']
  )
  return subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: kdf.iterations, hash: 'SHA-256' },
    keyMaterial,
    { name: ALG, length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}

/** An opaque derived key. The engine declares no DOM types; see envelope.ts. */
export type CryptoKeyLike = { readonly type: string }

export async function encryptMapForVault(
  key: CryptoKeyLike,
  map: SymbolMap
): Promise<VaultEnvelope> {
  const iv = randomBytes(12)
  const ciphertext = await webCryptoSubtle().encrypt(
    { name: ALG, iv },
    key,
    new TextEncoder().encode(JSON.stringify(map))
  )
  return { v: 1, alg: VAULT_ENVELOPE_ALG, iv: toBase64(iv), data: toBase64(ciphertext) }
}

/**
 * Open a vault envelope.
 *
 * The version and algorithm are checked BEFORE any decryption is attempted, so
 * a future format arrives as "unrecognized" rather than as a decrypt failure
 * that reads like a wrong passphrase. The result is validated on the way out for
 * the same reason it is in `openMap`: authenticated ciphertext proves the bytes
 * came from the right key, not that they are a symbol map.
 */
export async function decryptMapFromVault(
  key: CryptoKeyLike,
  envelope: VaultEnvelope
): Promise<SymbolMap> {
  if (envelope.v !== 1 || envelope.alg !== VAULT_ENVELOPE_ALG) {
    throw new VaultEnvelopeError()
  }
  const plaintext = await webCryptoSubtle().decrypt(
    { name: ALG, iv: fromBase64(envelope.iv) },
    key,
    fromBase64(envelope.data)
  )
  return parseSymbolMap(JSON.parse(new TextDecoder().decode(plaintext)))
}

/** Parse a stored envelope string, or say plainly that it is not one. */
export function parseVaultEnvelope(raw: string): VaultEnvelope {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new VaultEnvelopeError('That map is not a vault envelope (not JSON).')
  }
  if (typeof parsed !== 'object' || parsed === null) throw new VaultEnvelopeError()
  const e = parsed as Record<string, unknown>
  if (e.v !== 1 || e.alg !== VAULT_ENVELOPE_ALG) throw new VaultEnvelopeError()
  if (typeof e.iv !== 'string' || typeof e.data !== 'string') throw new VaultEnvelopeError()
  return { v: 1, alg: VAULT_ENVELOPE_ALG, iv: e.iv, data: e.data }
}

const VERIFIER_PLAINTEXT = 'veilio-vault-verifier-v1'

/**
 * Check a passphrase without the server learning it.
 *
 * The verifier is a known constant encrypted under the key. Only somebody
 * holding the right passphrase decrypts it back to the constant, and the server
 * stores it opaquely.
 */
export async function checkVaultVerifier(key: CryptoKeyLike, verifier: string): Promise<boolean> {
  try {
    const { iv, data } = JSON.parse(verifier) as { iv: string; data: string }
    const plaintext = await webCryptoSubtle().decrypt(
      { name: ALG, iv: fromBase64(iv) },
      key,
      fromBase64(data)
    )
    return new TextDecoder().decode(plaintext) === VERIFIER_PLAINTEXT
  } catch {
    return false
  }
}
