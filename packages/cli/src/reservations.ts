// Spec 063: this member's blocks of the team's placeholder numbers, and the
// old placeholders a publish renumbered.
//
// Both live beside the project's map, in files of their own rather than as
// fields of map.json: the guard (and every older CLI and guard) writes map.json
// back with only `version`, `map` and `remote`, and would silently drop a field
// it does not know. Nothing else writes these two files, and only the CLI and
// the MCP server write them; the guard only reads `reserved.json`.

import { randomInt } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import {
  isName,
  openStoreFile,
  prepareStoreWrite,
  recordWritten,
  refuseNonNames,
  StoreRefusal,
  writeStoreFile,
} from './store.js'
import {
  highestPerKind,
  isLocalTag,
  isPlaceholder,
  isSaneBlock,
  REDACTION_TOKENS,
  teamBaseOf,
  usedInBlock,
  type SymbolMap,
} from '@veilio-inc/engine'

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
  prepareStoreWrite(basename(path), path)
  writeStoreFile(basename(path), path, `${JSON.stringify(value, null, 2)}\n`)
}

/** The member's blocks, or null before any was reserved. A malformed file is refused, never numbered from. */
export function loadReserved(mapPath: string): ReservedFile | null {
  const path = reservedPath(mapPath)
  const text = openStoreFile(RESERVED_FILE, path)
  if (text === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
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
    // At most 1e8 and 10000 long (security audit): near 2^53 two names share a number.
    if (!isSaneBlock(b))
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
): { blocks: Record<string, Block>; tag: string; retired: string[]; refused?: Refused } {
  // Read on every call (code review): a publish in another process retires
  // local placeholders into aliases.json and may rewrite the tag.
  let retired: string[] = []
  try {
    retired = Object.keys(loadAliases(mapPath))
  } catch {
    // unreadable: numbering is still floored by the map itself
  }
  const own = sessionTag
  if (own && retired.some((p) => p.startsWith(`__LOCAL_${own}_`))) sessionTag = null
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
      retired,
      ...(held.refused ? { refused: held.refused } : {}),
    }
  return { blocks: {}, tag: tag(), retired }
}

/**
 * Spec 066 FR-001 (code review): numbering for a signed-in checkout in a team,
 * whether or not the team's maps could be read. The file's blocks and tag when
 * it is this account's (for `teamId`, or for any team when that is unknown);
 * otherwise no blocks - and with `write` and a known team, a fresh file
 * holding a new tag, so the tag outlives this run; with the team never seen,
 * a tag held for this process. A signed-in account is never numbered above
 * its map without a block (code review).
 */
export function localNumbering(
  mapPath: string,
  who: { instance: string; account: string },
  teamId: string | null,
  opts: { write: boolean }
): ReturnType<typeof teamNumbering> {
  let held: ReservedFile | null = null
  try {
    held = loadReserved(mapPath)
  } catch (err) {
    // A refused store (tracked, a link, another user's) is not malformed: it
    // is never replaced (spec 085 R2-16).
    if (err instanceof StoreRefusal) throw err
    // malformed: replaced below when allowed, never numbered from
  }
  if (
    held &&
    held.instance === who.instance &&
    held.account === who.account &&
    (teamId === null || held.teamId === teamId)
  )
    return teamNumbering(mapPath, { ...who, teamId: held.teamId })
  if (!teamId) return teamNumbering(mapPath, { ...who, teamId: '' }) // matches no file: session tag
  if (opts.write)
    saveReserved(mapPath, {
      version: 1,
      ...who,
      teamId,
      blocks: {},
      local: { tag: drawTag() },
    })
  return teamNumbering(mapPath, { ...who, teamId })
}

/** Said by `maps pull` (CLI and MCP) when the map held numbers above 1e8. */
export function outOfRangeNote(n: number): string {
  return (
    `${n} placeholder${n === 1 ? '' : 's'} in this map ${n === 1 ? 'is' : 'are'} numbered above 100,000,000: ` +
    `kept for restore, but never numbered after - no Veilio client mints that high.`
  )
}

/** Said by `maps pull` (CLI and MCP) when the map held numbers no run the
 *  server issued vouches for (round 4). */
export function unvouchedNote(n: number): string {
  return (
    `${n} placeholder${n === 1 ? '' : 's'} in this map ${n === 1 ? 'is' : 'are'} numbered outside every run of numbers the server issued: ` +
    `kept, but never a floor for new numbers, and restore leaves ${n === 1 ? 'one' : 'any'} above the highest number issued for its kind.`
  )
}

/** Said by restore (CLI and MCP) for placeholders above every number the
 *  server issued for their kind (round 4). */
export function unissuedNote(placeholders: readonly string[]): string {
  const one = placeholders.length === 1
  return (
    `left as is: ${placeholders.join(', ')}. ${one ? 'Its number is' : 'Their numbers are'} above every number the server ` +
    `has issued for ${one ? 'its' : 'their'} kind, so no reservation vouches for ${one ? 'it' : 'them'} and restoring would be a guess.`
  )
}

/** Said by `maps pull` (CLI and MCP) when a team map held local-family keys. */
export function localDroppedNote(n: number): string {
  return (
    `left out ${n} placeholder${n === 1 ? '' : 's'} numbered on one machine (__LOCAL_…) that the team map held: ` +
    `${n === 1 ? 'it means' : 'they mean'} something only on the checkout that numbered ${n === 1 ? 'it' : 'them'}.`
  )
}

/**
 * A server's words, safe for a terminal: control characters and Unicode format
 * characters (bidi overrides, zero-width) and the line and paragraph separators
 * become `?` (code review of spec 066; spec 080 review).
 */
export function printable(text: string): string {
  // eslint-disable-next-line no-control-regex -- matching them is the point
  return text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\p{Cf}]/gu, '?')
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
  const detail = printable(refused.detail ?? '').trim()
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
 * with no block or a used-up one. Only numbers inside the block count
 * (usedInBlock): a teammate's newer number above it leaves it usable, since the
 * server issued it to this member alone (security audit, round 4; spec 063 R1's
 * "above the map" came from the old marker technique). A local kind (`__LOCAL_<tag>_FN__`) asks for its team
 * kind, never for itself: the server refuses a local base (spec 066 R4).
 */
export function basesNeedingBlocks(
  map: SymbolMap,
  blocks: Record<string, Block>,
  wanted: readonly string[]
): string[] {
  const keys = Object.keys(map)
  const top = highestPerKind(map)
  const bases = new Set([...wanted, ...Object.keys(top).map((b) => teamBaseOf(b) ?? b)])
  return [...bases].filter((base) => {
    const b = blocks[base]
    return !b || usedInBlock(keys, base, b) >= b.end
  })
}

export function loadAliases(mapPath: string): SymbolMap {
  return readAliases(mapPath).aliases
}

/** Bounds on aliases.json, far above any real one. */
const MAX_ALIASES = 1_000_000

/**
 * aliases.json, checked like map.json (security audit), and never thrown on
 * (security review of round 1: one bad entry cost teamNumbering every
 * retired placeholder). An entry whose name is not a name (isName: 1 to 100000
 * characters, no control or line separator), whose key is not a placeholder, or past the entry bound is
 * dropped and counted in `ignored`; the rest are kept. A file that is not an
 * object of aliases is `unreadable`: no aliases, and never written over. The
 * one throw is the store's refusal of a link or a tracked file (spec 085).
 */
export function readAliases(mapPath: string): {
  aliases: SymbolMap
  ignored: number
  unreadable?: true
} {
  const path = aliasesPath(mapPath)
  const none = { aliases: {}, ignored: 0, unreadable: true as const }
  // A link or a tracked store is refused, not read as unreadable (spec 085 R1).
  const text = openStoreFile(ALIASES_FILE, path)
  if (text === null) return { aliases: {}, ignored: 0 }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return none
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return none
  const raw = (parsed as { aliases?: unknown }).aliases ?? {}
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return none
  let ignored = 0
  let kept = 0
  const aliases: SymbolMap = {}
  for (const [p, name] of Object.entries(raw)) {
    if (kept < MAX_ALIASES && isName(name) && isPlaceholder(p)) {
      aliases[p] = name
      kept++
    } else ignored++
  }
  return { aliases, ignored }
}

/** Remember renumbered placeholders' old meanings. One old placeholder never gets a second meaning. */
export function addAliases(mapPath: string, entries: SymbolMap): void {
  refuseNonNames(ALIASES_FILE, entries)
  const read = readAliases(mapPath)
  // Written over, an unreadable file would lose every old meaning it holds.
  if (read.unreadable)
    throw new Error(`${ALIASES_FILE} is not a readable aliases file; nothing was changed`)
  const aliases = read.aliases
  for (const [p, name] of Object.entries(entries))
    if (p in aliases && aliases[p] !== name)
      throw new Error(
        `${p} already stands for another name in ${ALIASES_FILE}; nothing was changed`
      )
  writePrivate(aliasesPath(mapPath), { version: 1, aliases: { ...aliases, ...entries } })
  recordWritten(mapPath)
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
 * neither, and the caller names it (code review). Only placeholder-shaped
 * keys are read from either file: anything else is dropped, and counted
 * (`ignored`), so a planted key never reaches a pattern (security audit).
 */
export function ownWithAliases(
  mapPath: string,
  given: SymbolMap
): { own: SymbolMap; contested: string[]; ignored: number } {
  const read = readAliases(mapPath)
  let ignored = read.ignored
  const aliases = read.aliases
  const map = Object.fromEntries(
    Object.entries(given).filter(([p]) => isPlaceholder(p) || (ignored++, false))
  )
  const contested = Object.keys(aliases).filter((p) => p in map && map[p] !== aliases[p])
  const own: SymbolMap = { ...aliases, ...map }
  for (const p of contested) delete own[p]
  return { own, contested, ignored }
}

/** Said by restore (CLI and MCP) when map.json or aliases.json held keys that are not placeholders. */
export function ignoredKeysNote(n: number): string {
  return `ignored ${n} ${n === 1 ? 'entry' : 'entries'} in map.json or ${ALIASES_FILE} whose key is not a placeholder.`
}

export function contestedNote(placeholders: readonly string[]): string {
  const one = placeholders.length === 1
  return (
    `left as is: ${placeholders.join(', ')}. This project's map and its renumbered old placeholders ` +
    `(.veilio/aliases.json) give ${one ? 'it' : 'them'} different identifiers, so restoring would be a guess.`
  )
}

// The engine's redaction tokens wherever they stand - inside a longer name too
// (a rule's residue, `"__REDACTED_AWS_SECRET_1__3"`): a fragment is still a
// value that cannot be restored, so it fails closed.
const REDACTION = new RegExp(REDACTION_TOKENS.source, 'g')

/** The one-way redactions (`__REDACTED_CREDENTIAL_1__`, `__REDACTED_IBAN__`)
 *  in a text, once each, in order of first appearance (spec 067). */
export function redactionsIn(text: string): string[] {
  return [...new Set(text.match(REDACTION) ?? [])]
}

/** Said by restore (CLI and MCP) for the redactions it left (spec 067): a
 *  redacted value is gone for good, so the text is not the original file. */
export function redactedNote(tokens: readonly string[]): string {
  const one = tokens.length === 1
  return (
    `left as is: ${tokens.join(', ')}. ${one ? 'It was' : 'They were'} redacted one-way ` +
    '(a credential or personal data) and cannot be restored, so this text is not the original: ' +
    'do not write it over the file. Make the change in the file itself instead.'
  )
}
