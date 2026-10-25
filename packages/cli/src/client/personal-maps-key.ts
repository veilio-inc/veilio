// The personal-maps key (PMK), wrapped and unwrapped, and kept on this machine
// (spec 052 FR-011, research §1).
//
// WHY A SECOND KEY
//
// An MCP server has nobody to type a vault passphrase, and the founder ruled
// out storing the vault key: it also unwraps the account's private key, which
// opens every team key ever granted to it. So personal maps get a key of their
// own - 32 random bytes, AES-256-GCM - that opens personal maps and nothing
// else. The server keeps it wrapped under the vault key, where it can no more
// read it than it can read the private key; a terminal unwraps it once with the
// passphrase (`veilio vault unlock`) and keeps ONLY this key, 0600, for 7 days.
//
// THE WRAP IS THE BROWSER’S, BYTE FOR BYTE
//
// `JSON.stringify({ v: 1, alg: 'AES-GCM', iv, data })`, a 12-byte IV, the raw
// 32 key bytes as plaintext, and the additional data "veilio-pmk-wrap-v1": the
// envelope shape the web app wraps the private key in (frontend `userKeys.ts`),
// bound to this purpose so neither blob can stand in for the other. The web app
// writes the same bytes; `vault-unlock.test.ts` pins one shared vector, and a
// second built with WebCrypto called directly, not through this file.
//
// THE FILE
//
// Like `team-unlock.ts`: bound to the instance and account that unlocked it,
// with an expiry, and every read tolerates everything - missing, corrupt,
// expired and somebody else's all read as "not unlocked".

import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import {
  STORE_DIR,
  fromBase64,
  randomBytes,
  toBase64,
  webCryptoSubtle,
  type CryptoKeyLike,
} from '@veilio-inc/engine'

export const PMK_FILE = 'personal-maps-key.json'
export const PMK_BYTES = 32
const WRAP_ALG = 'AES-GCM'
/**
 * Additional authenticated data on the wrap: it binds the blob to its purpose.
 * The vault key also wraps the account's private key, in the same envelope
 * shape; without this, a blob wrapped for one purpose would open as the other
 * (key confusion, cloud security review 2026-10-25). The web app's suite pins
 * the same bytes with the same vector.
 */
const WRAP_AAD = new TextEncoder().encode('veilio-pmk-wrap-v1')

export interface StoredPersonalMapsKey {
  v: 1
  instance: string
  account: string
  /** ISO-8601. Past this, reads return null. */
  expiresAt: string
  /** The raw PMK, base64. Never the vault key. */
  key: string
}

export function personalMapsKeyPath(home: string = homedir()): string {
  return join(home, STORE_DIR, PMK_FILE)
}

/** A fresh PMK, as raw bytes. */
export function newPersonalMapsKey(): Uint8Array {
  return randomBytes(PMK_BYTES)
}

/** The raw bytes as a key that can seal and open a vault envelope. */
export async function importPersonalMapsKey(raw: Uint8Array): Promise<CryptoKeyLike> {
  if (raw.byteLength !== PMK_BYTES) {
    throw new Error(`a personal-maps key must be ${PMK_BYTES} bytes (got ${raw.byteLength})`)
  }
  return webCryptoSubtle().importKey('raw', raw, { name: WRAP_ALG, length: 256 }, false, [
    'encrypt',
    'decrypt',
  ])
}

/**
 * WebCrypto with `additionalData` in its types. The engine's own accessor
 * declares only the IV, because no engine format uses AAD. This one does.
 */
function aead(): {
  encrypt(
    alg: { name: string; iv: Uint8Array; additionalData: Uint8Array },
    key: CryptoKeyLike,
    data: Uint8Array
  ): Promise<ArrayBuffer>
  decrypt(
    alg: { name: string; iv: Uint8Array; additionalData: Uint8Array },
    key: CryptoKeyLike,
    data: Uint8Array
  ): Promise<ArrayBuffer>
} {
  return webCryptoSubtle() as unknown as ReturnType<typeof aead>
}

/** Wrap the PMK under the vault key. `iv` is for the test vector only. */
export async function wrapPersonalMapsKey(
  vaultKey: CryptoKeyLike,
  raw: Uint8Array,
  iv: Uint8Array = randomBytes(12)
): Promise<string> {
  const data = await aead().encrypt({ name: WRAP_ALG, iv, additionalData: WRAP_AAD }, vaultKey, raw)
  return JSON.stringify({ v: 1, alg: WRAP_ALG, iv: toBase64(iv), data: toBase64(data) })
}

/** Unwrap it. Throws when the vault key is wrong or the blob was altered -
 *  AES-GCM authenticates, so a wrong key never yields a garbage key. */
export async function unwrapPersonalMapsKey(
  vaultKey: CryptoKeyLike,
  wrapped: string
): Promise<Uint8Array> {
  const env = JSON.parse(wrapped) as { v?: unknown; alg?: unknown; iv?: unknown; data?: unknown }
  if (
    env.v !== 1 ||
    env.alg !== WRAP_ALG ||
    typeof env.iv !== 'string' ||
    typeof env.data !== 'string'
  ) {
    throw new Error('the stored personal-maps key is not an envelope this client knows')
  }
  const raw = new Uint8Array(
    await aead().decrypt(
      { name: WRAP_ALG, iv: fromBase64(env.iv), additionalData: WRAP_AAD },
      vaultKey,
      fromBase64(env.data)
    )
  )
  if (raw.byteLength !== PMK_BYTES)
    throw new Error('the stored personal-maps key has the wrong length')
  return raw
}

function isStored(value: unknown): value is StoredPersonalMapsKey {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  if (v.v !== 1) return false
  for (const f of ['instance', 'account', 'expiresAt', 'key'] as const) {
    if (typeof v[f] !== 'string' || v[f] === '') return false
  }
  return true
}

/**
 * The PMK this machine holds for this sign-in, as raw bytes, or null.
 */
export function readPersonalMapsKey(
  binding: { instance: string; account: string },
  home: string = homedir(),
  now: Date = new Date()
): Uint8Array | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(personalMapsKeyPath(home), 'utf8'))
  } catch {
    return null
  }
  if (!isStored(parsed)) return null
  // A file left by one sign-in is never used by another.
  if (parsed.instance !== binding.instance || parsed.account !== binding.account) return null
  const expires = Date.parse(parsed.expiresAt)
  if (Number.isNaN(expires) || expires <= now.getTime()) return null
  try {
    const raw = fromBase64(parsed.key)
    return raw.byteLength === PMK_BYTES ? raw : null
  } catch {
    return null
  }
}

/** Until when the key on disk for this sign-in lasts, or null when there is
 *  none to use. Never the key itself: this is for saying "unlocked until". */
export function personalMapsKeyExpiry(
  binding: { instance: string; account: string },
  home: string = homedir(),
  now: Date = new Date()
): string | null {
  if (!readPersonalMapsKey(binding, home, now)) return null
  try {
    return (JSON.parse(readFileSync(personalMapsKeyPath(home), 'utf8')) as StoredPersonalMapsKey)
      .expiresAt
  } catch {
    return null
  }
}

/** Write it, readable only by this user. `chmod` after, as `writeCredential`
 *  does, because `mode` applies only to a file being created. */
export function writePersonalMapsKey(
  stored: StoredPersonalMapsKey,
  home: string = homedir()
): void {
  const path = personalMapsKeyPath(home)
  mkdirSync(dirname(path), { recursive: true })
  // Tightened BEFORE the key is written, too: a file left world-readable by
  // some earlier mistake must not hold the key even for a moment.
  try {
    chmodSync(path, 0o600)
  } catch {
    // Not there yet: `mode` below covers a new file.
  }
  writeFileSync(path, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 })
  chmodSync(path, 0o600)
}

/** Remove it. Whether there was one. A failure to delete throws: reporting
 *  "nothing to remove" while key material sits there inverts the call. */
export function removePersonalMapsKey(home: string = homedir()): boolean {
  const path = personalMapsKeyPath(home)
  try {
    statSync(path)
  } catch {
    return false
  }
  rmSync(path, { recursive: true, force: true })
  return true
}
