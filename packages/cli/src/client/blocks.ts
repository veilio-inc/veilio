// Spec 063 US1: make sure this member holds a block of the team's numbers for
// every kind the guard will mint, above everything the project's map holds.
//
// The guard makes no request (spec 017's rule, kept): it numbers inside the
// block offline. Whoever writes the map from Cloud - a pull, an unlock - is
// what keeps the block usable, because the engine numbers above the map's
// highest number of a kind and never into a gap below it.

import { reservePlaceholders, CloudError } from '../cloud.js'
import type { Credential } from '../credential.js'
import { loadMap } from '../store.js'
import {
  CORE_BASES,
  basesNeedingBlocks,
  loadReserved,
  saveReserved,
  type Block,
  type ReservedFile,
} from '../reservations.js'

const NUMBERED = /^(__[A-Z][A-Z0-9_]*__)(\d+)$/

export type BlocksOutcome =
  | { status: 'kept' }
  | { status: 'reserved'; blocks: Record<string, Block> }
  /** The pull still succeeded; the guard numbers new names locally until a block is held. */
  | { status: 'failed'; detail: string }

export async function ensureBlocks(
  credential: Credential,
  teamId: string,
  mapPath: string
): Promise<BlocksOutcome> {
  let held: ReservedFile | null
  try {
    held = loadReserved(mapPath)
  } catch {
    held = null // malformed: replaced, never numbered from
  }
  // Blocks taken by another account, team or instance are not this member's.
  const mine =
    held &&
    held.instance === credential.instance &&
    held.account === credential.account &&
    held.teamId === teamId
      ? held.blocks
      : {}
  const map = loadMap(mapPath)
  const need = basesNeedingBlocks(map, mine, CORE_BASES)
  if (need.length === 0 && held && mine === held.blocks) return { status: 'kept' }

  const floors: Record<string, number> = {}
  for (const p of Object.keys(map)) {
    const m = NUMBERED.exec(p)
    if (m && Number(m[2]) > (floors[m[1]] ?? 0)) floors[m[1]] = Number(m[2])
  }
  let ranges: { base: string; start: number; end: number }[] = []
  if (need.length) {
    try {
      ranges = (
        await reservePlaceholders(
          credential,
          teamId,
          need.map((base) => ({ base, count: 1, floor: floors[base] ?? 0 })),
          undefined,
          { block: true }
        )
      ).ranges
    } catch (err) {
      return {
        status: 'failed',
        detail: err instanceof CloudError ? err.message : String(err),
      }
    }
  }
  // A reply that is not one sane run per kind asked for is no block: the
  // guard would otherwise number from whatever it said.
  const sane =
    Array.isArray(ranges) &&
    ranges.length === need.length &&
    ranges.every(
      (r) =>
        need.includes(r?.base) &&
        Number.isInteger(r.start) &&
        Number.isInteger(r.end) &&
        r.start > (floors[r.base] ?? 0) &&
        r.end >= r.start
    )
  if (!sane) return { status: 'failed', detail: 'the server answered without a usable block' }
  const blocks: Record<string, Block> = { ...mine }
  for (const r of ranges) blocks[r.base] = { start: r.start, end: r.end }
  saveReserved(mapPath, {
    version: 1,
    instance: credential.instance,
    account: credential.account,
    teamId,
    blocks,
  })
  return {
    status: 'reserved',
    blocks: Object.fromEntries(ranges.map((r) => [r.base, { start: r.start, end: r.end }])),
  }
}
