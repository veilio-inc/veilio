import type { KdfParams } from './kdf.js'

/**
 * Runs the PBKDF2 derivation kdfTransport.ts's `WorkerKdfTransport` asks for,
 * off the main thread. See contracts/worker-protocol.md (specs/007-e11-derive-off)
 * for the message shapes this file and `WorkerKdfTransport` both implement.
 *
 * Deliberately does not `import type { WorkerLike }` or reference the `self`
 * global by its DOM type: this project's tsconfig includes the "DOM" lib
 * (for the rest of `src/`), and DOM and WebWorker lib globals conflict in one
 * TypeScript program. Casting once here avoids needing a second tsconfig for
 * a single file.
 */

interface DeriveRequest {
  requestId: number
  passphrase: string
  salt: ArrayBuffer
  kdf: KdfParams
}

type DeriveResponse =
  | { requestId: number; ok: true; bits: ArrayBuffer }
  | { requestId: number; ok: false; error: string }

interface WorkerScope {
  onmessage: ((ev: MessageEvent<DeriveRequest>) => void) | null
  postMessage(message: DeriveResponse, transfer?: Transferable[]): void
}

const ctx = self as unknown as WorkerScope

ctx.onmessage = (ev) => {
  const { requestId, passphrase, salt, kdf } = ev.data
  void deriveAndRespond(requestId, passphrase, salt, kdf)
}

async function deriveAndRespond(
  requestId: number,
  passphrase: string,
  salt: ArrayBuffer,
  kdf: KdfParams
): Promise<void> {
  try {
    const enc = new TextEncoder()
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      enc.encode(passphrase),
      'PBKDF2',
      false,
      ['deriveBits']
    )
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt: new Uint8Array(salt), iterations: kdf.iterations, hash: 'SHA-256' },
      keyMaterial,
      256
    )
    const response: DeriveResponse = { requestId, ok: true, bits }
    ctx.postMessage(response, [bits])
  } catch (err) {
    // Never the passphrase, never the salt — a message naming which KDF field
    // was invalid, nothing more (contracts/worker-protocol.md's invariants).
    const response: DeriveResponse = {
      requestId,
      ok: false,
      error: err instanceof Error ? err.message : 'Key derivation failed',
    }
    ctx.postMessage(response)
  }
}
