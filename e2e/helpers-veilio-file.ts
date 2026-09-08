import { webcrypto } from 'node:crypto'

/**
 * Builds a real, decryptable `.veilio` file (src/lib/localCrypto.ts's
 * `VeilioFile` envelope) at an arbitrary iteration count, entirely in Node —
 * so e2e/derive-worker.spec.ts can hand the browser a file declaring
 * `MAX_ITERATIONS` (src/lib/kdf.ts) without the app needing to expose any
 * test-only hook, and without touching CURRENT_FILE_KDF (specs/007-e11-derive-off
 * FR-006: parameter bounds are unchanged by that feature).
 */
export async function buildVeilioFile(
  map: Record<string, string>,
  passphrase: string,
  iterations: number
): Promise<string> {
  const enc = new TextEncoder()
  const salt = webcrypto.getRandomValues(new Uint8Array(16))
  const iv = webcrypto.getRandomValues(new Uint8Array(12))
  const keyMaterial = await webcrypto.subtle.importKey(
    'raw',
    enc.encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey']
  )
  const key = await webcrypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt']
  )
  const ciphertext = await webcrypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    enc.encode(JSON.stringify(map))
  )
  return JSON.stringify({
    v: 1,
    alg: 'AES-256-GCM-PBKDF2',
    kdf: { name: 'PBKDF2-SHA256', iterations },
    salt: Buffer.from(salt).toString('base64'),
    iv: Buffer.from(iv).toString('base64'),
    data: Buffer.from(ciphertext).toString('base64'),
  })
}
