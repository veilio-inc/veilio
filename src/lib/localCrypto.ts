import type { SymbolMap } from '@veilio-inc/engine'
import { CURRENT_FILE_KDF, LEGACY_FILE_KDF, parseKdfParams, type KdfParams } from './kdf.js'

const ALG = 'AES-GCM'

async function deriveKey(
  passphrase: string,
  salt: Uint8Array<ArrayBuffer>,
  kdf: KdfParams
): Promise<CryptoKey> {
  const enc = new TextEncoder()
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey']
  )
  return crypto.subtle.deriveKey(
    // Pass the TypedArray view directly, not salt.buffer: a raw ArrayBuffer
    // fails WebCrypto's cross-realm instanceof check under jsdom
    // ("salt is not instance of ArrayBuffer…"). ArrayBufferView checks are
    // realm-agnostic, so the view works everywhere.
    { name: 'PBKDF2', salt, iterations: kdf.iterations, hash: 'SHA-256' },
    keyMaterial,
    { name: ALG, length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
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

export async function exportMap(map: SymbolMap, passphrase: string): Promise<string> {
  const enc = new TextEncoder()
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await deriveKey(passphrase, salt, CURRENT_FILE_KDF)
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

export async function importMap(fileContent: string, passphrase: string): Promise<SymbolMap> {
  const file = JSON.parse(fileContent) as VeilioFile
  if (file.v !== 1 || file.alg !== 'AES-256-GCM-PBKDF2')
    throw new Error('Invalid .veilio file format')
  const kdf = parseKdfParams(file.kdf, LEGACY_FILE_KDF)
  const salt = fromBase64(file.salt)
  const iv = fromBase64(file.iv)
  const data = fromBase64(file.data)
  const key = await deriveKey(passphrase, salt, kdf)
  const dec = new TextDecoder()
  const plaintext = await crypto.subtle.decrypt({ name: ALG, iv }, key, data)
  return JSON.parse(dec.decode(plaintext)) as SymbolMap
}
