/**
 * The encrypted `.veilio` file format, and the key derivation behind it.
 *
 * This lives in the engine because two editions have to agree on it byte for
 * byte. A map sealed in the browser and opened from a terminal is the point of
 * the feature; two implementations of one format is the arrangement where one
 * gets a parameter change and the other does not, and the symptom is a file
 * nobody can open. The engine is already public, already zero-dependency, and
 * already owns the map type, so it is the one place both callers can reach.
 *
 * Everything here runs on WebCrypto through `globalThis.crypto`, which is
 * present in browsers and in Node from 19 onward. Deliberately NOT
 * `node:crypto`: importing it would give the engine a Node-only module and cost
 * it the browser, which is half its audience.
 */

import { isPlaceholder } from './engine.js'
import type { SymbolMap } from './types.js'

// ─── Key derivation ──────────────────────────────────────────────────────────

/**
 * Parameters recorded alongside every artifact they produced.
 *
 * A KDF's cost is expected to rise, and PBKDF2 is expected to give way to a
 * memory-hard KDF entirely. Neither is possible unless each artifact records
 * what it was created under: raising a hardcoded constant re-derives a DIFFERENT
 * key from the same passphrase, which silently orphans every file encrypted
 * under the old one. Recording it makes that change a migration rather than data
 * loss.
 */
export interface KdfParams {
  name: 'PBKDF2-SHA256'
  iterations: number
}

/** What new files are created with. Safe to raise — every existing file carries
 *  its own parameters, or falls back to the frozen legacy value below. */
export const CURRENT_FILE_KDF: KdfParams = { name: 'PBKDF2-SHA256', iterations: 600_000 }

/** What files written BEFORE parameters were recorded must be read with. A
 *  historical fact, not policy: editing it to track CURRENT_FILE_KDF stops
 *  previously exported files decrypting. Files were raised from 100k to 600k,
 *  and this is exactly what keeps the older ones importable. */
export const LEGACY_FILE_KDF: KdfParams = { name: 'PBKDF2-SHA256', iterations: 100_000 }

/**
 * An imported file is untrusted input, and its iteration count drives a loop in
 * the reader's process. A hostile file claiming a billion iterations would pin
 * the tab, so the value is bounded rather than believed.
 *
 * The ceiling comes from what an artifact could legitimately need, not from what
 * a machine survives: nothing has ever exceeded 600,000, and this leaves ~6x
 * headroom for any plausible raise before PBKDF2 is replaced outright.
 */
const MIN_ITERATIONS = 1
const MAX_ITERATIONS = 4_000_000

export class KdfParamsError extends Error {
  constructor(message = 'Unsupported key-derivation parameters') {
    super(message)
    this.name = 'KdfParamsError'
  }
}

/**
 * Validate KDF parameters read off an artifact.
 *
 * `raw` absent means the artifact predates parameter recording, so `fallback`
 * applies. Anything present but unrecognised throws rather than silently
 * deriving the wrong key — a wrong key surfaces as "decryption failed", which
 * reads to a user as a corrupt file rather than a version mismatch.
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

// ─── Passphrase floor ────────────────────────────────────────────────────────

/**
 * NIST SP 800-63B puts the lever on length rather than composition rules:
 * mandated symbol-and-digit recipes push people toward predictable
 * substitutions without adding entropy. Twelve is above the 8-character minimum
 * that guidance sets, warranted because this artifact is offline-attackable
 * rather than rate-limited by a server.
 */
export const MIN_PASSPHRASE_LENGTH = 12

export class WeakPassphraseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WeakPassphraseError'
  }
}

/**
 * A floor, not a strength meter, and the difference is worth being blunt about.
 * It rejects choices that are bad by construction. It cannot tell that
 * `correcthorse1` is poor, and does not pretend to — a green tick on a mediocre
 * passphrase is worse than no tick, because it converts the user's own judgement
 * into misplaced confidence.
 *
 * Called inside `sealMap` rather than at the call site, so no future caller can
 * write a file that skips the floor.
 */
export function assertUsablePassphrase(passphrase: string): void {
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new WeakPassphraseError(
      `Passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters. This file can be ` +
        `attacked offline for as long as somebody cares to, so length is the only defence.`
    )
  }
}

// ─── Map validation ──────────────────────────────────────────────────────────

export class InvalidMapError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidMapError'
  }
}

/** Upper bounds for one file. Not security boundaries — a map under both can
 *  still be hostile. They stop one file exhausting memory, and sit far above any
 *  real project: the largest maps seen are in the low hundreds of entries. */
const MAX_ENTRIES = 50_000
const MAX_VALUE_LENGTH = 10_000

/**
 * A decrypted file is authenticated, not trusted.
 *
 * Authentication proves the author knew the passphrase. Where maps move between
 * teammates that proves the author is a colleague, not that the contents are
 * benign — whatever a map holds is substituted into restored source, which the
 * reader then pastes into an editor.
 *
 * This cannot make an imported map safe and does not pretend to. It makes a
 * malformed or hostile one fail loudly at the boundary instead of quietly
 * deforming the restore.
 */
export function parseSymbolMap(raw: unknown): SymbolMap {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new InvalidMapError('Map must be a JSON object of placeholder → name.')
  }
  const entries = Object.entries(raw as Record<string, unknown>)
  if (entries.length > MAX_ENTRIES) {
    throw new InvalidMapError(`Map has ${entries.length} entries; the limit is ${MAX_ENTRIES}.`)
  }
  const out: SymbolMap = {}
  for (const [key, value] of entries) {
    if (!isPlaceholder(key)) {
      throw new InvalidMapError(`"${key}" is not a Veilio placeholder.`)
    }
    if (typeof value !== 'string') {
      throw new InvalidMapError(`"${key}" maps to a ${typeof value}, not a string.`)
    }
    if (value.length > MAX_VALUE_LENGTH) {
      throw new InvalidMapError(
        `"${key}" maps to ${value.length} characters; the limit is ${MAX_VALUE_LENGTH}.`
      )
    }
    out[key] = value
  }
  return out
}

// ─── The envelope ────────────────────────────────────────────────────────────

const ALG = 'AES-GCM'
const ENVELOPE_ALG = 'AES-256-GCM-PBKDF2'

export interface VeilioFile {
  v: 1
  alg: typeof ENVELOPE_ALG
  /** Absent in files written before parameters were recorded; those are read
   *  with LEGACY_FILE_KDF, which is why that constant stays frozen. */
  kdf?: KdfParams
  salt: string
  iv: string
  data: string
}

/**
 * The host surface this module needs, declared rather than imported.
 *
 * The engine's tsconfig sets `lib: ["ES2022"]` with no DOM, on purpose — it runs
 * in a browser, in Node, and in a worker, and none of those should be assumed.
 * Adding "DOM" to satisfy four type names would pull a whole browser API surface
 * into a package that touches none of it, and `@types/node` would be a
 * dependency in a package whose selling point is having none.
 *
 * So the contract is written out. It is four methods, it is what WebCrypto
 * guarantees in every environment listed above, and a host missing any of them
 * fails at `subtle()` with a sentence saying which environments qualify.
 */
interface WebCryptoKey {
  readonly type: string
}
interface WebCryptoSubtle {
  importKey(
    format: 'raw',
    keyData: Uint8Array,
    algorithm: string,
    extractable: boolean,
    usages: string[]
  ): Promise<WebCryptoKey>
  deriveKey(
    algorithm: { name: string; salt: Uint8Array; iterations: number; hash: string },
    baseKey: WebCryptoKey,
    derived: { name: string; length: number },
    extractable: boolean,
    usages: string[]
  ): Promise<WebCryptoKey>
  encrypt(
    algorithm: { name: string; iv: Uint8Array },
    key: WebCryptoKey,
    data: Uint8Array
  ): Promise<ArrayBuffer>
  decrypt(
    algorithm: { name: string; iv: Uint8Array },
    key: WebCryptoKey,
    data: Uint8Array
  ): Promise<ArrayBuffer>
}
interface WebCryptoHost {
  subtle: WebCryptoSubtle
  getRandomValues<T extends Uint8Array>(array: T): T
}

function subtle(): WebCryptoSubtle {
  const c = (globalThis as { crypto?: WebCryptoHost }).crypto
  if (!c?.subtle) {
    throw new Error(
      'WebCrypto is unavailable. The envelope needs globalThis.crypto.subtle, present in ' +
        'browsers and in Node 19 or newer.'
    )
  }
  return c.subtle
}

function randomBytes(n: number): Uint8Array {
  return (globalThis as { crypto: WebCryptoHost }).crypto.getRandomValues(new Uint8Array(n))
}

export function toBase64(buf: ArrayBuffer | Uint8Array): string {
  // `ArrayBuffer.isView`, not `instanceof ArrayBuffer`: instanceof fails when the
  // buffer crossed realms (jsdom under test), sending a real ArrayBuffer down the
  // typed-array branch and yielding an empty string.
  const bytes = (ArrayBuffer.isView(buf) ? buf : new Uint8Array(buf)) as Uint8Array
  // Chunked, not String.fromCharCode(...bytes): spreading a whole export's worth
  // of bytes passes them as individual arguments and overflows the call stack
  // (~64k args in Safari, ~125k in V8). A real map exceeds that easily.
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(s)
}

export function fromBase64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
}

async function deriveKey(
  passphrase: string,
  salt: Uint8Array,
  kdf: KdfParams
): Promise<WebCryptoKey> {
  const keyMaterial = await subtle().importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey']
  )
  return subtle().deriveKey(
    // The TypedArray view, not salt.buffer: a raw ArrayBuffer fails WebCrypto's
    // cross-realm instanceof check under jsdom. View checks are realm-agnostic.
    { name: 'PBKDF2', salt, iterations: kdf.iterations, hash: 'SHA-256' },
    keyMaterial,
    { name: ALG, length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}

/** Seal a symbol map into the `.veilio` file format. Returns the file's text. */
export async function sealMap(map: SymbolMap, passphrase: string): Promise<string> {
  assertUsablePassphrase(passphrase)
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const key = await deriveKey(passphrase, salt, CURRENT_FILE_KDF)
  const ciphertext = await subtle().encrypt(
    { name: ALG, iv },
    key,
    new TextEncoder().encode(JSON.stringify(map))
  )
  const file: VeilioFile = {
    v: 1,
    alg: ENVELOPE_ALG,
    kdf: CURRENT_FILE_KDF,
    salt: toBase64(salt),
    iv: toBase64(iv),
    data: toBase64(ciphertext),
  }
  return JSON.stringify(file, null, 2)
}

/** Open a `.veilio` file. Throws on a wrong passphrase, an unknown format, or a
 *  map that decrypts but does not validate. */
export async function openMap(fileContent: string, passphrase: string): Promise<SymbolMap> {
  const file = JSON.parse(fileContent) as VeilioFile
  if (file.v !== 1 || file.alg !== ENVELOPE_ALG) {
    throw new Error('Invalid .veilio file format')
  }
  const kdf = parseKdfParams(file.kdf, LEGACY_FILE_KDF)
  const key = await deriveKey(passphrase, fromBase64(file.salt), kdf)
  const plaintext = await subtle().decrypt(
    { name: ALG, iv: fromBase64(file.iv) },
    key,
    fromBase64(file.data)
  )
  // Decrypting proves the author knew the passphrase, not that the contents are
  // well formed. Validate before the map goes anywhere near a restore.
  return parseSymbolMap(JSON.parse(new TextDecoder().decode(plaintext)))
}
