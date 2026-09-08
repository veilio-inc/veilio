// @vitest-environment jsdom
//
// jsdom has no `Worker` global at all — not a stub, absent entirely. That is
// exactly the fallback case ROADMAP E11 asks for ("a context where the
// worker cannot start... falls back to the current path"), so this suite
// runs `InlineKdfTransport` for real rather than mocking a Worker to force
// it. `WorkerKdfTransport`'s own protocol is tested separately below against
// a fake Worker-shaped object, since jsdom cannot run a real one.
import { describe, it, expect, vi } from 'vitest'
import {
  InlineKdfTransport,
  WorkerKdfTransport,
  getKdfTransport,
  resetKdfTransportForTests,
  type WorkerLike,
} from './kdfTransport.js'
import type { KdfParams } from './kdf.js'

const KDF: KdfParams = { name: 'PBKDF2-SHA256', iterations: 1000 }
const SALT = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16])
const PASSPHRASE = 'fixed-vector-passphrase'

// Computed once against Node's WebCrypto (`crypto.subtle`) directly — the
// same primitive `crypto.subtle.deriveKey` used before this feature existed.
// specs/007-e11-derive-off/research.md R-004: this is the anti-regression
// check that the transport swap did not silently change what gets derived.
const EXPECTED_HEX = 'f8aaf21a32ea76246d2bfd3122f98de80dab81394bbaae6882af0fa5af206161'

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

describe('InlineKdfTransport (the fallback path)', () => {
  it('derives the expected fixed vector', async () => {
    const bits = await new InlineKdfTransport().derive(PASSPHRASE, SALT, KDF)
    expect(toHex(bits)).toBe(EXPECTED_HEX)
  })

  it('is selected when Worker is unavailable', () => {
    // jsdom's actual state, made explicit rather than incidental (T018).
    expect(typeof Worker).toBe('undefined')
    resetKdfTransportForTests()
    expect(getKdfTransport()).toBeInstanceOf(InlineKdfTransport)
  })

  it('rejects immediately if the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      new InlineKdfTransport().derive(PASSPHRASE, SALT, KDF, controller.signal)
    ).rejects.toThrow(/Aborted/)
  })
})

/** A `WorkerLike` double that echoes back a fixed-vector-shaped response
 *  without touching a real Worker, per research.md R-003: this tests this
 *  feature's own message protocol, not whether jsdom can run a Worker. */
function makeFakeWorker(): { worker: WorkerLike; postedMessages: unknown[] } {
  const postedMessages: unknown[] = []
  const worker: WorkerLike = {
    postMessage: vi.fn((message) => postedMessages.push(message)),
    terminate: vi.fn(),
    onmessage: null,
    onerror: null,
  }
  return { worker, postedMessages }
}

describe('WorkerKdfTransport protocol', () => {
  it('resolves when the worker responds with a matching requestId', async () => {
    const { worker, postedMessages } = makeFakeWorker()
    const transport = new WorkerKdfTransport(() => worker)

    const promise = transport.derive(PASSPHRASE, SALT, KDF)
    const sent = postedMessages[0] as { requestId: number }
    const bits = new Uint8Array([9, 9, 9]).buffer
    worker.onmessage?.({ data: { requestId: sent.requestId, ok: true, bits } } as MessageEvent)

    expect(toHex(await promise)).toBe(toHex(bits))
  })

  it('correlates two overlapping requests by id, not by arrival order', async () => {
    const { worker, postedMessages } = makeFakeWorker()
    const transport = new WorkerKdfTransport(() => worker)

    const first = transport.derive('first', SALT, KDF)
    const second = transport.derive('second', SALT, KDF)
    const [firstReq, secondReq] = postedMessages as { requestId: number }[]

    // Respond out of order: second's response arrives first.
    worker.onmessage?.({
      data: { requestId: secondReq.requestId, ok: true, bits: new Uint8Array([2]).buffer },
    } as MessageEvent)
    worker.onmessage?.({
      data: { requestId: firstReq.requestId, ok: true, bits: new Uint8Array([1]).buffer },
    } as MessageEvent)

    expect(toHex(await first)).toBe(toHex(new Uint8Array([1]).buffer))
    expect(toHex(await second)).toBe(toHex(new Uint8Array([2]).buffer))
  })

  it('rejects, rather than hanging, on a worker-reported error', async () => {
    const { worker, postedMessages } = makeFakeWorker()
    const transport = new WorkerKdfTransport(() => worker)

    const promise = transport.derive(PASSPHRASE, SALT, KDF)
    const sent = postedMessages[0] as { requestId: number }
    worker.onmessage?.({
      data: { requestId: sent.requestId, ok: false, error: 'boom' },
    } as MessageEvent)

    await expect(promise).rejects.toThrow('boom')
  })

  it('rejects every pending request, rather than hanging, on onerror', async () => {
    const { worker } = makeFakeWorker()
    const transport = new WorkerKdfTransport(() => worker)

    const promise = transport.derive(PASSPHRASE, SALT, KDF)
    worker.onerror?.({} as ErrorEvent)

    await expect(promise).rejects.toThrow(/failed/i)
  })

  it('terminates the worker and rejects on abort — the only way to stop an in-flight derive', async () => {
    const { worker } = makeFakeWorker()
    const transport = new WorkerKdfTransport(() => worker)
    const controller = new AbortController()

    const promise = transport.derive(PASSPHRASE, SALT, KDF, controller.signal)
    controller.abort()

    await expect(promise).rejects.toThrow(/Aborted/)
    expect(worker.terminate).toHaveBeenCalledOnce()
  })

  it('creates a fresh worker after termination rather than reusing the dead one', async () => {
    let createdCount = 0
    const workers: WorkerLike[] = []
    const transport = new WorkerKdfTransport(() => {
      createdCount++
      const { worker } = makeFakeWorker()
      workers.push(worker)
      return worker
    })

    const controller = new AbortController()
    const aborted = transport.derive(PASSPHRASE, SALT, KDF, controller.signal)
    controller.abort()
    await expect(aborted).rejects.toThrow()

    const second = transport.derive(PASSPHRASE, SALT, KDF)
    const secondWorker = workers[1]
    const [sent] = (secondWorker.postMessage as ReturnType<typeof vi.fn>).mock.calls[0]
    secondWorker.onmessage?.({
      data: { requestId: sent.requestId, ok: true, bits: new Uint8Array([7]).buffer },
    } as MessageEvent)
    await second

    expect(createdCount).toBe(2)
  })
})
