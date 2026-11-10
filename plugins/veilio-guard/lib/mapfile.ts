// The project's symbol map, .veilio/map.json, in the format the CLI and the
// MCP server use (packages/cli/src/store.ts). The guard shares the file with
// them and with other sessions, so it reads what is on disk now, adds only its
// own new entries, and treats a placeholder that would mean two names as a
// conflict to resolve by masking again - never by overwriting.

import { isLocalTag, isName, isRolePlaceholder, isSaneBlock } from '../vendor/engine/index.js'

export type SymbolMap = Record<string, string>
export type StoredMap = {
  version: 1
  map: SymbolMap
  remote?: { id: string; updatedAt: string; pulledAt?: string; pushedAt?: string }
}

export type Parsed = { ok: true; stored: StoredMap } | { ok: false; reason: string }

export function parseMapFile(text: string): Parsed {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'it is not valid JSON' }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'it is not a map file' }
  }
  const { version, map, remote } = parsed as Record<string, unknown>
  if (version !== 1)
    return { ok: false, reason: `its version is ${JSON.stringify(version)}, not 1` }
  if (typeof map !== 'object' || map === null || Array.isArray(map)) {
    return { ok: false, reason: 'it has no map' }
  }
  if (!Object.values(map).every((v) => typeof v === 'string')) {
    return { ok: false, reason: 'a map entry is not text' }
  }
  // Spec 085 R2-18: the CLI's rule - no control character or line break, which
  // would drive the terminal it is drawn in or break a line restored into.
  if (!Object.values(map).every(isName)) {
    return { ok: false, reason: 'a map entry is not a name (a control character or line break)' }
  }
  const stored: StoredMap = { version: 1, map: map as SymbolMap }
  if (remote && typeof remote === 'object') stored.remote = remote as StoredMap['remote']
  return { ok: true, stored }
}

export function mergeAdditions(
  onDisk: SymbolMap,
  additions: SymbolMap
): { merged: SymbolMap; conflicts: string[] } {
  const merged: SymbolMap = { ...onDisk }
  // A name's non-role placeholder wins the lookup, so a second rule
  // placeholder for it is still a clash whatever the key order.
  const entries = Object.entries(onDisk)
  const byName = new Map(
    [
      ...entries.filter(([p]) => isRolePlaceholder(p)),
      ...entries.filter(([p]) => !isRolePlaceholder(p)),
    ].map(([p, v]) => [v, p])
  )
  const conflicts: string[] = []
  for (const [placeholder, name] of Object.entries(additions)) {
    const there = onDisk[placeholder]
    if (there === name) continue
    const other = byName.get(name)
    // Spec 064/065: a custom rule's placeholder for a name the engine once
    // gave a role placeholder (an ordinary word, now readable) is the engine's
    // own behaviour, not a clash: the old entry stays, so old text restores.
    const ruleOverEngine =
      other !== undefined && isRolePlaceholder(other) && !isRolePlaceholder(placeholder)
    if (there !== undefined || (other !== undefined && other !== placeholder && !ruleOverEngine)) {
      conflicts.push(placeholder)
      continue
    }
    merged[placeholder] = name
    byName.set(name, placeholder)
  }
  return { merged, conflicts }
}

export function serialiseMapFile(stored: StoredMap): string {
  const payload: StoredMap = {
    version: 1,
    map: stored.map,
    ...(stored.remote ? { remote: stored.remote } : {}),
  }
  return `${JSON.stringify(payload, null, 2)}\n`
}

// Spec 063: this member's blocks of the team's placeholder numbers, written by
// the CLI or the MCP server (`veilio maps pull`, `veilio team unlock`) to
// .veilio/reserved.json beside the map. The guard only reads it, and numbers
// new names inside a block offline; it never asks for numbers itself.
// Spec 066: it also holds the checkout's local tag, and why the last
// reservation failed - shown on the band for the whole session.

export type Block = { start: number; end: number }
export type ReservedRefusal = {
  reason: 'cap' | 'payment' | 'offline' | 'server'
  at: string
  nextAt?: string
  detail?: string
}
export type Reserved =
  | { ok: true; blocks: Record<string, Block>; tag?: string; refused?: ReservedRefusal }
  | { ok: false; reason: string }

const REASONS: readonly string[] = ['cap', 'payment', 'offline', 'server']
const isIsoTime = (v: unknown): v is string =>
  typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) && !Number.isNaN(Date.parse(v))

const BASE = /^__[A-Z][A-Z0-9_]*__$/

export function parseReservedFile(text: string): Reserved {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'it is not valid JSON' }
  }
  const r = parsed as { version?: unknown; blocks?: unknown; local?: unknown; refused?: unknown }
  if (r?.version !== 1)
    return { ok: false, reason: `its version is ${JSON.stringify(r?.version)}, not 1` }
  if (typeof r.blocks !== 'object' || r.blocks === null || Array.isArray(r.blocks))
    return { ok: false, reason: 'it has no blocks' }
  const blocks: Record<string, Block> = {}
  for (const [base, b] of Object.entries(r.blocks as Record<string, Partial<Block>>)) {
    // Quoted and cut short: a planted file's key must not put control
    // characters into the band (security review, 2026-10-30).
    if (!BASE.test(base))
      return { ok: false, reason: `${JSON.stringify(base).slice(0, 40)} is not a placeholder kind` }
    // At most 1e8 and 10000 long (security audit): near 2^53 two names share a number.
    if (!isSaneBlock(b))
      return { ok: false, reason: `the ${base} block is not a run of whole numbers` }
    blocks[base] = { start: b!.start!, end: b!.end! }
  }
  // A malformed tag or refusal makes the whole file unreadable: never numbered
  // from, and the band says so (spec 066 data model).
  let tag: string | undefined
  if (r.local !== undefined) {
    const t = (r.local as { tag?: unknown } | null)?.tag
    if (!isLocalTag(t)) return { ok: false, reason: 'its local tag is not six of A-Z0-9' }
    tag = t
  }
  if (r.refused === undefined) return { ok: true, blocks, ...(tag ? { tag } : {}) }
  const f = r.refused as Partial<Record<keyof ReservedRefusal, unknown>> | null
  if (typeof f?.reason !== 'string' || !REASONS.includes(f.reason))
    return { ok: false, reason: 'its refusal has no known reason' }
  if (!isIsoTime(f.at) || (f.nextAt !== undefined && !isIsoTime(f.nextAt)))
    return { ok: false, reason: 'its refusal time is not an ISO time' }
  if (f.detail !== undefined && (typeof f.detail !== 'string' || f.detail.length > 200))
    return { ok: false, reason: 'its refusal detail is not a short text' }
  const refused: ReservedRefusal = {
    reason: f.reason as ReservedRefusal['reason'],
    at: f.at,
    ...(f.nextAt !== undefined ? { nextAt: f.nextAt as string } : {}),
    ...(f.detail !== undefined ? { detail: f.detail as string } : {}),
  }
  return { ok: true, blocks, ...(tag ? { tag } : {}), refused }
}
