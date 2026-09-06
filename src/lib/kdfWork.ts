// The actual PBKDF2 + AES-GCM key derivation, extracted so both the worker
// entry (kdfWorker.ts) and its main-thread caller (localCrypto.ts) share one
// implementation. Nothing here is worker-specific — `crypto.subtle` is
// available in both realms — which is what makes it directly unit-testable
// without a Worker at all.

export const ALG = 'AES-GCM'

export async function deriveKeyMaterial(
  passphrase: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number
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
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    keyMaterial,
    { name: ALG, length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}
