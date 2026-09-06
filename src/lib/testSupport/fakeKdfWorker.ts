// Stands in for the browser's real Worker under jsdom, which does not
// implement one. Runs the exact same handleKdfRequest the real worker entry
// (kdfWorker.ts) calls, so a regression in the message contract fails here
// the same way it would in a browser — only the "actually off the main
// thread" part is untested, which nothing jsdom can exercise anyway.
import { handleKdfRequest, type KdfWorkerRequest, type KdfWorkerResponse } from '../kdfWorker.js'

export class FakeKdfWorker {
  onmessage: ((e: MessageEvent<KdfWorkerResponse>) => void) | null = null
  onerror: ((e: { message: string; error?: unknown }) => void) | null = null
  terminated = false
  terminateCallCount = 0

  // Matches the `new Worker(url, opts)` signature; both args are ignored,
  // since standing in for the URL resolution isn't what this double tests.
  constructor(
    public url?: string | URL,
    public options?: WorkerOptions
  ) {}

  postMessage(data: KdfWorkerRequest): void {
    queueMicrotask(async () => {
      const response = await handleKdfRequest(data)
      this.onmessage?.({ data: response } as MessageEvent<KdfWorkerResponse>)
    })
  }

  terminate(): void {
    this.terminated = true
    this.terminateCallCount++
  }
}

/** A Worker stand-in whose postMessage always fails via onerror, never onmessage. */
export class FailingKdfWorker {
  onmessage: ((e: MessageEvent<KdfWorkerResponse>) => void) | null = null
  onerror: ((e: { message: string; error?: unknown }) => void) | null = null
  terminated = false

  constructor(
    public url?: string | URL,
    public options?: WorkerOptions
  ) {}

  postMessage(): void {
    queueMicrotask(() => {
      this.onerror?.({ message: 'worker construction failed', error: new Error('boom') })
    })
  }

  terminate(): void {
    this.terminated = true
  }
}
