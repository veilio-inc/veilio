// Spec 063: this member's blocks of the team's placeholder numbers, and the
// old placeholders a publish renumbered.
//
// Both live beside the project's map, in files of their own rather than as
// fields of map.json: the guard (and every older CLI and guard) writes map.json
// back with only `version`, `map` and `remote`, and would silently drop a field
// it does not know. Nothing else writes these two files, and only the CLI and
// the MCP server write them; the guard only reads `reserved.json`.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { SymbolMap } from '@veilio-inc/engine'

export const RESERVED_FILE = 'reserved.json'
export const ALIASES_FILE = 'aliases.json'

/** The placeholder kinds a guard or scrub mints, besides any already in the map. */
export const CORE_BASES = ['__VAR__', '__FN__', '__CLS__'] as const

const BASE = /^__[A-Z][A-Z0-9_]*__$/
const NUMBERED = /^(__[A-Z][A-Z0-9_]*__)(\d+)$/

export type Block = { start: number; end: number }
export type ReservedFile = {
  version: 1
  instance: string
  account: string
  teamId: string
  blocks: Record<string, Block>
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
    if (!BASE.test(base)) throw new ReservedFileError(path, `${base} is not a placeholder kind`)
    if (!Number.isInteger(b?.start) || !Number.isInteger(b?.end) || b.start < 1 || b.end < b.start)
      throw new ReservedFileError(path, `the ${base} block is not a run of whole numbers`)
  }
  return r as ReservedFile
}

export function saveReserved(mapPath: string, reserved: ReservedFile): void {
  writePrivate(reservedPath(mapPath), reserved)
}

/** Highest number per kind in a map. */
function highest(map: SymbolMap): Record<string, number> {
  const out: Record<string, number> = {}
  for (const p of Object.keys(map)) {
    const m = NUMBERED.exec(p)
    if (m && Number(m[2]) > (out[m[1]] ?? 0)) out[m[1]] = Number(m[2])
  }
  return out
}

/**
 * The kinds that need a fresh block: those asked for or present in the map,
 * with no block, a used-up one, or one below a number the map already holds.
 * The engine numbers above the map's highest number of a kind, never into a
 * gap, so a block under a teammate's newer number can no longer be used
 * (spec 063 research R1).
 */
export function basesNeedingBlocks(
  map: SymbolMap,
  blocks: Record<string, Block>,
  wanted: readonly string[]
): string[] {
  const top = highest(map)
  const bases = new Set([...wanted, ...Object.keys(top)])
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
