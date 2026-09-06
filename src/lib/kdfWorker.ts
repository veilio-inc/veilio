// Worker entry for PBKDF2 derivation (ROADMAP E11). Loaded via
// `new Worker(new URL('./kdfWorker.ts', import.meta.url), { type: 'module' })`
// from localCrypto.ts, which is what keeps this a same-origin module chunk
// rather than a `blob:` worker — the app's CSP is `default-src 'self'` (E3),
// and a blob worker would need a CSP change to load at all.
//
// `self` is typed locally (not via the "webworker" lib) because this project's
// tsconfig sets `lib: ["DOM", ...]` for the rest of the app, and TypeScript
// does not let a single program combine "dom" and "webworker" — they define
// conflicting globals for the same names (self, postMessage, MessageEvent…).
// A local `declare const self` shadows the ambient DOM typing for this file
// only, with exactly the two members this file actually calls.
import { deriveKeyMaterial } from './kdfWork.js'

export interface KdfWorkerRequest {
  passphrase: string
  salt: Uint8Array<ArrayBuffer>
  iterations: number
}

export type KdfWorkerResponse = { ok: true; key: CryptoKey } | { ok: false; error: string }

// Exported so both the real onmessage wiring below and the fake Worker tests
// substitute for `Worker` under jsdom call the exact same code — a regression
// here fails the same way in both, rather than only in a real browser.
export async function handleKdfRequest(req: KdfWorkerRequest): Promise<KdfWorkerResponse> {
  try {
    const key = await deriveKeyMaterial(req.passphrase, req.salt, req.iterations)
    return { ok: true, key }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

declare const self: {
  onmessage: ((e: MessageEvent<KdfWorkerRequest>) => void) | null
  postMessage: (data: KdfWorkerResponse) => void
}

self.onmessage = (e) => {
  void handleKdfRequest(e.data).then((response) => self.postMessage(response))
}
