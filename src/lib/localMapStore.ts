import type { SymbolMap } from '@veilio-inc/engine'
import { CURRENT_FILE_KDF, parseKdfParams, type KdfParams } from './kdf.js'
import { getKdfTransport } from './kdfTransport.js'
import { assertUsablePassphrase } from './passphrase.js'

/**
 * Local symbol maps, encrypted at rest (spec 018).
 *
 * "Save locally" used to keep maps in localStorage as plain JSON - the real
 * identifier names this product exists to protect, readable by any extension,
 * anyone else on the machine, or a copied disk. Now only ciphertext is stored,
 * under a key derived from a local passphrase with the same derivation as the
 * .veilio export - derived off the main thread, like the export, so the page
 * does not freeze for the second it takes.
 *
 * Every ciphertext carries the additional data `veilio-local-map:v1`, so it can
 * only ever open as a local map.
 *
 * The picker needs names, counts and dates without a key, so those stay
 * readable. Contents never do. Nothing here talks to a server.
 */

const MAPS_KEY = 'veilio_local_maps_v2'
const LEGACY_KEY = 'veilio_local_maps'
const LOCAL_KEY_RECORD = 'veilio_local_key'
const ALG = 'AES-GCM'
const AAD = new TextEncoder().encode('veilio-local-map:v1')
const CHECK_AAD = new TextEncoder().encode('veilio-local-key-check:v1')
const CHECK_PLAINTEXT = 'veilio-local-key'

export interface LocalMapMeta {
  id: string
  name: string
  savedAt: string
  identifierCount: number
}

interface StoredEntry extends LocalMapMeta {
  iv: string
  data: string
}

interface LocalKeyRecord {
  v: 1
  kdf: KdfParams
  salt: string
  verifier: { iv: string; data: string }
}

interface LegacyEntry {
  id: string
  name: string
  map: SymbolMap
  savedAt: string
  identifierCount: number
}

export class LocalKeyLockedError extends Error {
  constructor() {
    super('Enter your local passphrase to open local maps')
    this.name = 'LocalKeyLockedError'
  }
}

/** The key's derivation settings. Mutable only so tests need not run 600,000
 *  iterations; the stored record carries what was used, so unlock follows it. */
export const localKeyConfig = { kdf: CURRENT_FILE_KDF as KdfParams }

// The local key lives here and nowhere else: never in storage, never in state
// that is serialised. A reload asks again, as the vault does.
let localKey: CryptoKey | null = null

// ─── storage ─────────────────────────────────────────────────────────────────

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw === null ? fallback : (JSON.parse(raw) as T)
  } catch {
    return fallback
  }
}

function readEntries(): StoredEntry[] {
  const list = readJson<unknown>(MAPS_KEY, [])
  return Array.isArray(list) ? (list as StoredEntry[]) : []
}

function writeEntries(entries: StoredEntry[]): void {
  // No catch: a full or blocked storage must fail the save loudly. There is
  // no plaintext fallback to fall back to.
  localStorage.setItem(MAPS_KEY, JSON.stringify(entries))
}

function readLegacy(): LegacyEntry[] {
  const list = readJson<unknown>(LEGACY_KEY, [])
  return Array.isArray(list) ? (list as LegacyEntry[]) : []
}

function readKeyRecord(): LocalKeyRecord | null {
  const r = readJson<LocalKeyRecord | null>(LOCAL_KEY_RECORD, null)
  return r && r.v === 1 && typeof r.salt === 'string' && r.verifier ? r : null
}

// ─── crypto ──────────────────────────────────────────────────────────────────

function toBase64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = ArrayBuffer.isView(buf) ? (buf as Uint8Array) : new Uint8Array(buf)
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(s)
}

function fromBase64(s: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)) as Uint8Array<ArrayBuffer>
}

async function deriveLocalKey(
  passphrase: string,
  salt: Uint8Array<ArrayBuffer>,
  kdf: KdfParams
): Promise<CryptoKey> {
  const bits = await getKdfTransport().derive(passphrase, salt, kdf)
  return crypto.subtle.importKey('raw', bits, { name: ALG }, false, ['encrypt', 'decrypt'])
}

async function seal(key: CryptoKey, plaintext: string, aad: Uint8Array) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt(
    { name: ALG, iv, additionalData: aad as BufferSource },
    key,
    new TextEncoder().encode(plaintext)
  )
  return { iv: toBase64(iv), data: toBase64(ct) }
}

async function open(key: CryptoKey, sealed: { iv: string; data: string }, aad: Uint8Array) {
  const pt = await crypto.subtle.decrypt(
    { name: ALG, iv: fromBase64(sealed.iv), additionalData: aad as BufferSource },
    key,
    fromBase64(sealed.data)
  )
  return new TextDecoder().decode(pt)
}

// ─── the local passphrase ────────────────────────────────────────────────────

export function localKeyState(): 'none' | 'locked' | 'unlocked' {
  if (localKey) return 'unlocked'
  return readKeyRecord() ? 'locked' : 'none'
}

/** Set the local passphrase for the first time. Unlocks, then migrates any
 *  legacy plaintext under it. */
export async function setLocalPassphrase(passphrase: string, confirm: string): Promise<void> {
  if (readKeyRecord()) throw new Error('A local passphrase is already set')
  if (passphrase !== confirm) throw new Error('The two passphrases do not match')
  assertUsablePassphrase(passphrase)
  const salt = crypto.getRandomValues(new Uint8Array(16)) as Uint8Array<ArrayBuffer>
  const kdf = localKeyConfig.kdf
  const key = await deriveLocalKey(passphrase, salt, kdf)
  const record: LocalKeyRecord = {
    v: 1,
    kdf,
    salt: toBase64(salt),
    verifier: await seal(key, CHECK_PLAINTEXT, CHECK_AAD),
  }
  localStorage.setItem(LOCAL_KEY_RECORD, JSON.stringify(record))
  localKey = key
  await migrateLegacy()
}

/** Unlock for this session. False on a wrong passphrase - nothing decrypted. */
export async function unlockLocal(passphrase: string): Promise<boolean> {
  const record = readKeyRecord()
  if (!record || !passphrase) return false
  const key = await deriveLocalKey(
    passphrase,
    fromBase64(record.salt),
    parseKdfParams(record.kdf, CURRENT_FILE_KDF)
  )
  try {
    if ((await open(key, record.verifier, CHECK_AAD)) !== CHECK_PLAINTEXT) return false
  } catch {
    return false
  }
  localKey = key
  await migrateLegacy()
  return true
}

/** Forgotten passphrase: remove every map it protects, and the key record. */
export function forgetLocal(): void {
  localKey = null
  localStorage.removeItem(MAPS_KEY)
  localStorage.removeItem(LOCAL_KEY_RECORD)
  localStorage.removeItem(LEGACY_KEY)
}

/** Test-only: the in-memory key, to forge ciphertexts under it. */
export function getKeyForTests(): CryptoKey | null {
  return localKey
}

/** Test-only: forget the in-memory key, as a reload does. */
export function lockLocalForTests(): void {
  localKey = null
}

// ─── maps ────────────────────────────────────────────────────────────────────

function requireKey(): CryptoKey {
  if (!localKey) throw new LocalKeyLockedError()
  return localKey
}

export function listLocalMaps(): LocalMapMeta[] {
  return readEntries().map(({ id, name, savedAt, identifierCount }) => ({
    id,
    name,
    savedAt,
    identifierCount,
  }))
}

export function hasLegacyPlaintext(): boolean {
  return readLegacy().length > 0
}

export async function saveLocalMap(
  name: string,
  map: SymbolMap,
  id = `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
  savedAt = new Date().toISOString()
): Promise<LocalMapMeta> {
  const sealed = await seal(requireKey(), JSON.stringify(map), AAD)
  const entry: StoredEntry = {
    id,
    name,
    savedAt,
    identifierCount: Object.keys(map).length,
    ...sealed,
  }
  writeEntries([entry, ...readEntries().filter((e) => e.id !== id)])
  return { id, name, savedAt, identifierCount: entry.identifierCount }
}

export async function openLocalMap(id: string): Promise<SymbolMap> {
  const entry = readEntries().find((e) => e.id === id)
  if (!entry) throw new Error('That local map no longer exists')
  return JSON.parse(await open(requireKey(), entry, AAD)) as SymbolMap
}

export function deleteLocalMap(id: string): void {
  writeEntries(readEntries().filter((e) => e.id !== id))
}

/**
 * Encrypt every legacy plaintext map under the local key, THEN remove the plaintext.
 * In that order: interrupted after the write, the next run finds the ids
 * already stored and only removes the plaintext. Never re-writes plaintext.
 * Returns how many maps were migrated.
 */
export async function migrateLegacy(): Promise<number> {
  const legacy = readLegacy()
  if (legacy.length === 0) return 0
  const have = new Set(readEntries().map((e) => e.id))
  let migrated = 0
  for (const old of legacy) {
    if (have.has(old.id)) continue
    await saveLocalMap(old.name, old.map ?? {}, old.id, old.savedAt)
    migrated++
  }
  localStorage.removeItem(LEGACY_KEY)
  return migrated
}

/** Delete legacy plaintext without migrating it (the user declined a key). */
export function deleteLegacyPlaintext(): void {
  localStorage.removeItem(LEGACY_KEY)
}
