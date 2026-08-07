import type { SymbolMap } from '@dlgshi/engine'

const PBKDF2_ITERATIONS = 100_000
const ALG = 'AES-GCM'

async function deriveKey(passphrase: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const enc = new TextEncoder()
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey']
  )
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt.buffer, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    { name: ALG, length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}

function toBase64(buf: ArrayBuffer | Uint8Array<ArrayBuffer>): string {
  const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf
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
  salt: string
  iv: string
  data: string
}

export async function exportMap(map: SymbolMap, passphrase: string): Promise<string> {
  const enc = new TextEncoder()
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await deriveKey(passphrase, salt)
  const ciphertext = await crypto.subtle.encrypt(
    { name: ALG, iv },
    key,
    enc.encode(JSON.stringify(map))
  )
  const file: VeilioFile = {
    v: 1,
    alg: 'AES-256-GCM-PBKDF2',
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
  const salt = fromBase64(file.salt)
  const iv = fromBase64(file.iv)
  const data = fromBase64(file.data)
  const key = await deriveKey(passphrase, salt)
  const dec = new TextDecoder()
  const plaintext = await crypto.subtle.decrypt({ name: ALG, iv }, key, data)
  return JSON.parse(dec.decode(plaintext)) as SymbolMap
}
