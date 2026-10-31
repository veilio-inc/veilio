// Spec 063: this member's blocks of the team's placeholder numbers, and the
// old placeholders a publish renumbered.
//
// Both live beside the project's map, in files of their own rather than as
// fields of map.json: the guard (and every older CLI and guard) writes map.json
// back with only `version`, `map` and `remote`, and would silently drop a field
// it does not know. Nothing else writes these two files, and only the CLI and
// the MCP server write them; the guard only reads `reserved.json`.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomInt } from 'node:crypto'
import { dirname, join } from 'node:path'
import { highestPerKind, isLocalTag, teamBaseOf, type SymbolMap } from '@veilio-inc/engine'

export const RESERVED_FILE = 'reserved.json'
export const ALIASES_FILE = 'aliases.json'

/** The placeholder kinds a guard or scrub mints, besides any already in the map. */
export const CORE_BASES = ['__VAR__', '__FN__', '__CLS__'] as const

const BASE = /^__[A-Z][A-Z0-9_]*__$/

export type Block = { start: number; end: number }
/** Why the last reservation failed (spec 066 R4). */
export const REFUSAL_REASONS = ['cap', 'payment', 'offline', 'server'] as const
export type RefusalReason = (typeof REFUSAL_REASONS)[number]
export type Refused = { reason: RefusalReason; at: string; nextAt?: string; detail?: string }
export type ReservedFile = {
  version: 1
  instance: string
  account: string
  teamId: string
  blocks: Record<string, Block>
  /** Spec 066: the tag this checkout's local placeholders carry. Absent in a
   *  file from an older CLI; the next `ensureBlocks` adds one. */
  local?: { tag: string }
  /** Spec 066: the last reservation failed. Removed by the next success. */
  refused?: Refused
}

const isIsoTime = (v: unknown): v is string =>
  typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) && !Number.isNaN(Date.parse(v))

const TAG_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
/** A fresh checkout tag: six of A-Z0-9, about 2.2e9 of them (spec 066 R1). */
export function drawTag(): string {
  return Array.from({ length: 6 }, () => TAG_ALPHABET[randomInt(TAG_ALPHABET.length)]).join('')
}

export class ReservedFileError extends Error {
  constructor(path: string, why: string) {
    super(
      `${path} is not a reservation file this version can use (${why}); remove it and run \`veilio maps pull\` again`
    )
    this.name = 'ReservedFileError'
  }
}

const reservedPath = (mapPath: string) => join(dirname(mapPath), RESERVED_FILE)
const aliasesPath = (mapPath: string) => join(dirname(mapPath), ALIASES_FILE)

function writePrivate(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  chmodSync(path, 0o600)
}

/** The member's blocks, or null before any was reserved. A malformed file is refused, never numbered from. */
export function loadReserved(mapPath: string): ReservedFile | null {
  const path = reservedPath(mapPath)
  if (!existsSync(path)) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new ReservedFileError(path, 'it is not valid JSON')
  }
  const r = parsed as Partial<ReservedFile>
  if (r?.version !== 1)
    throw new ReservedFileError(path, `its version is ${JSON.stringify(r?.version)}`)
  for (const k of ['instance', 'account', 'teamId'] as const)
    if (typeof r[k] !== 'string' || !r[k]) throw new ReservedFileError(path, `it has no ${k}`)
  if (typeof r.blocks !== 'object' || r.blocks === null || Array.isArray(r.blocks))
    throw new ReservedFileError(path, 'it has no blocks')
  for (const [base, b] of Object.entries(r.blocks)) {
    if (!BASE.test(base))
      throw new ReservedFileError(
        path,
        `${JSON.stringify(base).slice(0, 40)} is not a placeholder kind`
      )
    if (!Number.isInteger(b?.start) || !Number.isInteger(b?.end) || b.start < 1 || b.end < b.start)
      throw new ReservedFileError(path, `the ${base} block is not a run of whole numbers`)
  }
  if (r.local !== undefined && !isLocalTag(r.local?.tag))
    throw new ReservedFileError(path, 'its local tag is not six of A-Z0-9')
  if (r.refused !== undefined) {
    const f = r.refused as Partial<Refused> | null
    if (!REFUSAL_REASONS.includes(f?.reason as RefusalReason))
      throw new ReservedFileError(path, 'its refusal has no known reason')
    if (!isIsoTime(f?.at) || (f.nextAt !== undefined && !isIsoTime(f.nextAt)))
      throw new ReservedFileError(path, 'its refusal time is not an ISO time')
    if (f.detail !== undefined && (typeof f.detail !== 'string' || f.detail.length > 200))
      throw new ReservedFileError(path, 'its refusal detail is not a short text')
  }
  return r as ReservedFile
}

/** Drawn once per process, for a checkout whose file gives no tag. */
let sessionTag: string | null = null

/** A publish retired this process's local placeholders: the next is drawn
 *  afresh, so a retired one is never minted again for another name (R6). */
export function resetSessionTag(): void {
  sessionTag = null
}

/**
 * What signed-in scrub and the MCP server number new names from (spec 066 R3):
 * this checkout's blocks and tag, when `reserved.json` is this account's for
 * this team. Anything else - no file, a malformed one, another account's - is
 * no blocks, so every new name goes into the local family, under a tag held
 * for this process. Read only: neither surface reserves (spec 011).
 */
export function teamNumbering(
  mapPath: string,
  owner: { instance: string; account: string; teamId: string }
): { blocks: Record<string, Block>; tag: string; refused?: Refused } {
  let held: ReservedFile | null = null
  try {
    held = loadReserved(mapPath)
  } catch {
    // malformed: no blocks, and never its tag
  }
  const tag = () => (sessionTag ??= drawTag())
  if (
    held &&
    held.instance === owner.instance &&
    held.account === owner.account &&
    held.teamId === owner.teamId
  )
    return {
      blocks: held.blocks,
      tag: held.local?.tag ?? tag(),
      ...(held.refused ? { refused: held.refused } : {}),
    }
  return { blocks: {}, tag: tag() }
}

/** HH:MM on this machine's clock. */
function localTime(iso: string): string {
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * Spec 066 R7: a refused reservation, said the same way by the CLI and the
 * MCP server - the reason, and what follows from it.
 */
export function reservationRefusedSentence(
  refused: Pick<Refused, 'reason' | 'nextAt' | 'detail'>,
  tag: string
): string {
  // eslint-disable-next-line no-control-regex -- the server's words reach a terminal
  const detail = (refused.detail ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '?').trim()
  const why =
    refused.reason === 'cap'
      ? "this account's daily limit for this team is reached" +
        (refused.nextAt
          ? `; the next block is possible at ${localTime(refused.nextAt)} (local time)`
          : '')
      : refused.reason === 'payment'
        ? "the team's plan is not active"
        : refused.reason === 'offline'
          ? 'Veilio Cloud could not be reached'
          : detail.replace(/[.!?]+$/, '') || 'the server refused it'
  return (
    `could not reserve team numbers: ${why}. New names are numbered on this machine as ` +
    `__LOCAL_${tag}_… until a block is held; your next publish gives them team numbers.`
  )
}

export function saveReserved(mapPath: string, reserved: ReservedFile): void {
  writePrivate(reservedPath(mapPath), reserved)
}

/**
 * The kinds that need a fresh block: those asked for or present in the map,
 * with no block, a used-up one, or one below a number the map already holds.
 * The engine numbers above the map's highest number of a kind, never into a
 * gap, so a block under a teammate's newer number can no longer be used
 * (spec 063 research R1). A local kind (`__LOCAL_<tag>_FN__`) asks for its team
 * kind, never for itself: the server refuses a local base (spec 066 R4).
 */
export function basesNeedingBlocks(
  map: SymbolMap,
  blocks: Record<string, Block>,
  wanted: readonly string[]
): string[] {
  const top = highestPerKind(map)
  const bases = new Set([...wanted, ...Object.keys(top).map((b) => teamBaseOf(b) ?? b)])
  return [...bases].filter((base) => {
    const b = blocks[base]
    return !b || (top[base] ?? 0) >= b.end
  })
}

export function loadAliases(mapPath: string): SymbolMap {
  const path = aliasesPath(mapPath)
  if (!existsSync(path)) return {}
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { aliases?: SymbolMap }
  return parsed.aliases ?? {}
}

/** Remember renumbered placeholders' old meanings. One old placeholder never gets a second meaning. */
export function addAliases(mapPath: string, entries: SymbolMap): void {
  const aliases = loadAliases(mapPath)
  for (const [p, name] of Object.entries(entries))
    if (p in aliases && aliases[p] !== name)
      throw new Error(
        `${p} already stands for another name in ${ALIASES_FILE}; nothing was changed`
      )
  writePrivate(aliasesPath(mapPath), { version: 1, aliases: { ...aliases, ...entries } })
}

/** How the CLI and the MCP name a placeholder left because its number was another member's. */
export function misattributedNote(placeholders: readonly string[]): string {
  const one = placeholders.length === 1
  return (
    `left as is: ${placeholders.join(', ')}. ${one ? 'Its number was' : 'Their numbers were'} reserved by another member ` +
    `than the one whose map names ${one ? 'it' : 'them'}, so restoring would be a guess.`
  )
}

/**
 * This member's own restore layer: the map, and the old placeholders a publish
 * renumbered (aliases.json). A placeholder the two give different names is
 * contested - text masked under either meaning could hold it - so it is in
 * neither, and the caller names it (code review).
 */
export function ownWithAliases(
  mapPath: string,
  map: SymbolMap
): { own: SymbolMap; contested: string[] } {
  const aliases = loadAliases(mapPath)
  const contested = Object.keys(aliases).filter((p) => p in map && map[p] !== aliases[p])
  const own: SymbolMap = { ...aliases, ...map }
  for (const p of contested) delete own[p]
  return { own, contested }
}

export function contestedNote(placeholders: readonly string[]): string {
  const one = placeholders.length === 1
  return (
    `left as is: ${placeholders.join(', ')}. This project's map and its renumbered old placeholders ` +
    `(.veilio/aliases.json) give ${one ? 'it' : 'them'} different identifiers, so restoring would be a guess.`
  )
}
