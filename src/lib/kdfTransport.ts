import type { KdfParams } from './kdf.js'

/**
 * Asks for a derived key's raw bits without saying where the work happens.
 * `localCrypto.ts` calls through this instead of `crypto.subtle.deriveBits`
 * directly, so where derivation runs (main thread vs. Worker) is a choice
 * `getKdfTransport` makes once, not something every caller decides.
 */
export interface KdfTransport {
  derive(
    passphrase: string,
    salt: Uint8Array<ArrayBuffer>,
    kdf: KdfParams,
    signal?: AbortSignal
  ): Promise<ArrayBuffer>
}

async function deriveBitsHere(
  passphrase: string,
  salt: Uint8Array<ArrayBuffer>,
  kdf: KdfParams
): Promise<ArrayBuffer> {
  const enc = new TextEncoder()
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(passphrase),
    'PBKDF2',
    false,
    ['deriveBits']
  )
  return crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: kdf.iterations, hash: 'SHA-256' },
    keyMaterial,
    256
  )
}

/**
 * Derives on the calling thread — today's behavior, kept as the fallback for
 * a context with no `Worker` (research.md R-003) and as the correctness
 * reference the worker path is checked against (R-004).
 */
export class InlineKdfTransport implements KdfTransport {
  async derive(
    passphrase: string,
    salt: Uint8Array<ArrayBuffer>,
    kdf: KdfParams,
    signal?: AbortSignal
  ): Promise<ArrayBuffer> {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    // Nothing to interrupt once this call starts — no browser exposes a way
    // to preempt an in-flight deriveBits. Best-effort only (research.md R-005).
    return deriveBitsHere(passphrase, salt, kdf)
  }
}

interface DeriveRequest {
  requestId: number
  passphrase: string
  salt: ArrayBuffer
  kdf: KdfParams
}

type DeriveResponse =
  | { requestId: number; ok: true; bits: ArrayBuffer }
  | { requestId: number; ok: false; error: string }

/** The minimal Worker surface this transport needs, so a test can supply a
 *  fake without jsdom having to support real Workers (contracts/worker-protocol.md). */
export interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void
  terminate(): void
  onmessage: ((ev: MessageEvent<DeriveResponse>) => void) | null
  onerror: ((ev: ErrorEvent) => void) | null
}

function createRealWorker(): WorkerLike {
  return new Worker(new URL('./kdf.worker.ts', import.meta.url), {
    type: 'module',
  }) as unknown as WorkerLike
}

/**
 * Derives inside a Worker, so the 600k-plus-iteration PBKDF2 call never runs
 * on the main thread (SC-001). Request/response are correlated by id so two
 * overlapping `derive()` calls against one worker resolve to the right
 * caller; cancellation terminates the worker outright, since a running
 * `deriveBits` has no interruption point a message could reach.
 */
export class WorkerKdfTransport implements KdfTransport {
  private worker: WorkerLike | null = null
  private nextRequestId = 1
  private readonly pending = new Map<
    number,
    { resolve: (bits: ArrayBuffer) => void; reject: (err: Error) => void }
  >()

  constructor(private readonly createWorker: () => WorkerLike = createRealWorker) {}

  private ensureWorker(): WorkerLike {
    if (this.worker) return this.worker
    const worker = this.createWorker()
    worker.onmessage = (ev) => {
      const msg = ev.data
      const request = this.pending.get(msg.requestId)
      if (!request) return
      this.pending.delete(msg.requestId)
      if (msg.ok) request.resolve(msg.bits)
      else request.reject(new Error(msg.error))
    }
    worker.onerror = () => {
      // An uncaught exception in the worker script itself (not a rejected
      // derive) — every still-pending request would otherwise hang forever,
      // which is the one outcome contracts/worker-protocol.md rules out.
      for (const request of this.pending.values()) {
        request.reject(new Error('Key-derivation worker failed'))
      }
      this.pending.clear()
      this.terminate()
    }
    this.worker = worker
    return worker
  }

  private terminate(): void {
    this.worker?.terminate()
    this.worker = null
  }

  async derive(
    passphrase: string,
    salt: Uint8Array<ArrayBuffer>,
    kdf: KdfParams,
    signal?: AbortSignal
  ): Promise<ArrayBuffer> {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const worker = this.ensureWorker()
    const requestId = this.nextRequestId++
    // Copied, not the caller's own view: the buffer is transferred to the
    // worker (detached from this side), and the caller's `salt` must stay
    // usable after this call returns.
    const saltBuffer = salt.slice().buffer

    return new Promise<ArrayBuffer>((resolve, reject) => {
      const onAbort = () => {
        this.pending.delete(requestId)
        this.terminate()
        reject(new DOMException('Aborted', 'AbortError'))
      }
      this.pending.set(requestId, {
        resolve: (bits) => {
          signal?.removeEventListener('abort', onAbort)
          resolve(bits)
        },
        reject: (err) => {
          signal?.removeEventListener('abort', onAbort)
          reject(err)
        },
      })
      signal?.addEventListener('abort', onAbort, { once: true })
      const request: DeriveRequest = { requestId, passphrase, salt: saltBuffer, kdf }
      worker.postMessage(request, [saltBuffer])
    })
  }
}

let cachedTransport: KdfTransport | null = null

/** Worker when one is available (every real browser target); the direct
 *  call otherwise (research.md R-003). Cached so repeated exports/imports
 *  reuse one worker instead of spinning up a new one each time. */
export function getKdfTransport(): KdfTransport {
  if (!cachedTransport) {
    cachedTransport =
      typeof Worker !== 'undefined' ? new WorkerKdfTransport() : new InlineKdfTransport()
  }
  return cachedTransport
}

/** Test-only: forces the next `getKdfTransport()` call to recompute. */
export function resetKdfTransportForTests(): void {
  cachedTransport = null
}
