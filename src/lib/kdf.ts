// Key-derivation parameters, recorded in every .veilio file they produced.
//
// A KDF's cost is expected to rise over time, and PBKDF2 is expected to give
// way to a memory-hard KDF (Argon2id) entirely. Neither is possible unless each
// file records the parameters it was created under: raising a hardcoded
// constant re-derives a DIFFERENT key from the same passphrase, which silently
// orphans every map exported under the old one. Recording the parameters is
// what makes that change a migration rather than data loss.

export interface KdfParams {
  name: 'PBKDF2-SHA256'
  iterations: number
}

// What NEW files are written with. Safe to raise: every existing file carries
// its own parameters, or falls back to the frozen legacy value below.
//
// This sits at the OWASP floor for PBKDF2-HMAC-SHA256. Exported files used to be
// derived at 100k, which is weak for the one artifact that actually leaves the
// machine and can be attacked offline at leisure.
export const CURRENT_FILE_KDF: KdfParams = { name: 'PBKDF2-SHA256', iterations: 600_000 }

// What files created BEFORE this recording existed must be read with. This is a
// historical fact, not policy — it must never be edited to track CURRENT_FILE_KDF
// above, or previously exported files stop decrypting. It has already diverged
// from the current value (files were raised from 100k to 600k) and is exactly
// what keeps .veilio files written before that raise importable.
export const LEGACY_FILE_KDF: KdfParams = { name: 'PBKDF2-SHA256', iterations: 100_000 }

// An imported .veilio file is untrusted input, and its iteration count drives a
// loop in the reader's browser. A hostile file claiming a billion iterations
// would pin the tab, so the value is bounded rather than believed.
//
// The ceiling is set from what a file could legitimately need, not from what a
// browser can survive. Nothing this project has ever written exceeds
// CURRENT_FILE_KDF, and the ceiling leaves roughly 6x of headroom above it — far
// more than any plausible raise before PBKDF2 is replaced outright, and the
// constant is editable in the same release as that raise. The old ceiling of
// 10,000,000 was ~17x current cost for no reachable purpose, which on a low-end
// phone is the difference between a pause and an apparent crash.
//
// This bounds a denial of service, nothing more: derivation runs on the main
// thread, so even an accepted value stalls the tab for its duration. Moving it
// to a worker is a responsiveness fix and is tracked separately.
const MIN_ITERATIONS = 1
const MAX_ITERATIONS = 4_000_000

export class KdfParamsError extends Error {
  constructor(message = 'Unsupported key-derivation parameters') {
    super(message)
    this.name = 'KdfParamsError'
  }
}

/**
 * Validate KDF parameters read off a .veilio file.
 *
 * `raw` absent means the file predates parameter recording, so `fallback`
 * (LEGACY_FILE_KDF) applies. Anything present but unrecognized throws rather
 * than silently deriving the wrong key.
 */
export function parseKdfParams(raw: unknown, fallback: KdfParams): KdfParams {
  if (raw === undefined || raw === null) return fallback
  if (typeof raw !== 'object') throw new KdfParamsError()

  const { name, iterations } = raw as Partial<KdfParams>
  if (name !== 'PBKDF2-SHA256') throw new KdfParamsError(`Unsupported KDF: ${String(name)}`)
  if (
    typeof iterations !== 'number' ||
    !Number.isInteger(iterations) ||
    iterations < MIN_ITERATIONS ||
    iterations > MAX_ITERATIONS
  ) {
    throw new KdfParamsError(`Refusing KDF iteration count: ${String(iterations)}`)
  }
  return { name, iterations }
}
