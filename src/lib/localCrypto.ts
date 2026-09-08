import type { SymbolMap } from '@veilio-inc/engine'
import { CURRENT_FILE_KDF, LEGACY_FILE_KDF, parseKdfParams, type KdfParams } from './kdf.js'
import { parseSymbolMap } from './importedMap.js'
import { assertUsablePassphrase } from './passphrase.js'
import { getKdfTransport } from './kdfTransport.js'

const ALG = 'AES-GCM'

// Derives via `getKdfTransport()` (a Worker when one is available, ROADMAP
// E11) rather than calling `crypto.subtle.deriveKey` here directly, so the
// 600k-plus-iteration PBKDF2 call never blocks the thread this function was
// called from. The transport returns raw bits; importing them here (not in
// the worker) keeps the resulting CryptoKey non-extractable exactly as
// before — see specs/007-e11-derive-off/research.md R-002.
async function deriveKey(
  passphrase: string,
  salt: Uint8Array<ArrayBuffer>,
  kdf: KdfParams,
  signal?: AbortSignal
): Promise<CryptoKey> {
  const bits = await getKdfTransport().derive(passphrase, salt, kdf, signal)
  return crypto.subtle.importKey('raw', bits, { name: ALG, length: 256 }, false, [
    'encrypt',
    'decrypt',
  ])
}

function toBase64(buf: ArrayBuffer | Uint8Array<ArrayBuffer>): string {
  // Cross-realm safe: instanceof ArrayBuffer fails when the buffer crossed
  // realms (e.g. jsdom in tests), sending a real ArrayBuffer down the
  // typed-array branch and yielding an empty string. ArrayBuffer.isView returns
  // true for any typed-array view, false for raw ArrayBuffers — flip the check.
  const bytes = (ArrayBuffer.isView(buf) ? buf : new Uint8Array(buf)) as Uint8Array
  // Converted in chunks, not as String.fromCharCode(...bytes): spreading a
  // whole export's worth of bytes passes them as individual arguments and
  // overflows the call stack (~64k args in Safari, ~125k in V8). A real
  // project's symbol map encrypts to far more than that.
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(s)
}

function fromBase64(s: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)) as Uint8Array<ArrayBuffer>
}

export interface VeilioFile {
  v: 1
  alg: 'AES-256-GCM-PBKDF2'
  /** Absent in files written before the parameters were recorded; those are
   *  read with LEGACY_FILE_KDF, which is why that constant must stay frozen. */
  kdf?: KdfParams
  salt: string
  iv: string
  data: string
}

export async function exportMap(
  map: SymbolMap,
  passphrase: string,
  signal?: AbortSignal
): Promise<string> {
  // Enforced here rather than at the call site so no future caller can write a
  // file that skips the floor (ROADMAP E8).
  assertUsablePassphrase(passphrase)
  const enc = new TextEncoder()
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await deriveKey(passphrase, salt, CURRENT_FILE_KDF, signal)
  const ciphertext = await crypto.subtle.encrypt(
    { name: ALG, iv },
    key,
    enc.encode(JSON.stringify(map))
  )
  const file: VeilioFile = {
    v: 1,
    alg: 'AES-256-GCM-PBKDF2',
    kdf: CURRENT_FILE_KDF,
    salt: toBase64(salt),
    iv: toBase64(iv),
    data: toBase64(ciphertext),
  }
  return JSON.stringify(file, null, 2)
}

export async function importMap(
  fileContent: string,
  passphrase: string,
  signal?: AbortSignal
): Promise<SymbolMap> {
  const file = JSON.parse(fileContent) as VeilioFile
  if (file.v !== 1 || file.alg !== 'AES-256-GCM-PBKDF2')
    throw new Error('Invalid .veilio file format')
  const kdf = parseKdfParams(file.kdf, LEGACY_FILE_KDF)
  const salt = fromBase64(file.salt)
  const iv = fromBase64(file.iv)
  const data = fromBase64(file.data)
  const key = await deriveKey(passphrase, salt, kdf, signal)
  const dec = new TextDecoder()
  const plaintext = await crypto.subtle.decrypt({ name: ALG, iv }, key, data)
  // Decryption succeeding proves the author knew the passphrase, which in a
  // workflow built around sharing maps is not the same as proving the contents
  // are well formed. Validate before the map is handed to a restore (ROADMAP E7).
  return parseSymbolMap(JSON.parse(dec.decode(plaintext)))
}
