// Spec 063 US1: make sure this member holds a block of the team's numbers for
// every kind the guard will mint, above everything the project's map holds.
//
// The guard makes no request (spec 017's rule, kept): it numbers inside the
// block offline. Whoever writes the map from Cloud - a pull, an unlock - is
// what keeps the block usable, because the engine numbers above the map's
// highest number of a kind and never into a gap below it.

import { highestPerKind, isSaneBlock } from '@veilio-inc/engine'
import { reservePlaceholders, CloudError, type PlaceholderReservation } from '../cloud.js'
import { teamKeyBytes, teamKeyUnconfirmed, teamKeyVersion } from '../hashed-bases.js'
import type { Credential } from '../credential.js'
import { StoreRefusal, loadMap } from '../store.js'
import {
  CORE_BASES,
  basesNeedingBlocks,
  drawTag,
  loadReserved,
  saveReserved,
  type Block,
  type RefusalReason,
  type Refused,
  type ReservedFile,
} from '../reservations.js'

export type BlocksOutcome =
  | { status: 'kept' }
  | { status: 'reserved'; blocks: Record<string, Block> }
  /** The pull still succeeded; new names are numbered in the local family
   *  until a block is held (spec 066). */
  | { status: 'failed'; reason: RefusalReason; detail: string; nextAt?: string; tag: string }

/** Why a reservation failed, in the four kinds a member can act on (spec 066 R4). */
function reasonOf(err: unknown): RefusalReason {
  if (!(err instanceof CloudError)) return 'server'
  if (err.kind === 'unentitled') return 'payment'
  if (err.kind === 'unreachable') return 'offline'
  if (err.status === 429 && err.body?.reason === 'cap') return 'cap'
  return 'server'
}

/**
 * Written on every outcome (spec 066 R4): without the file a refused member's
 * guard cannot tell "team, no block" from "no team", and numbers into the next
 * teammate's block. The checkout's tag is drawn once and kept across pulls.
 */
export async function ensureBlocks(
  credential: Credential,
  teamId: string,
  mapPath: string,
  /** Where the team keys are: a rule's base is reserved under its hash. */
  home?: string,
  /** The team's reservations of the map's bases, when the caller listed
   *  them; null when the instance keeps no record. */
  reservations?: PlaceholderReservation[] | null
): Promise<BlocksOutcome> {
  let held: ReservedFile | null
  try {
    held = loadReserved(mapPath)
  } catch (err) {
    // A refused store is not malformed: never replaced (spec 085 R2-16).
    if (err instanceof StoreRefusal) throw err
    held = null // malformed: replaced, never numbered from
  }
  // Blocks taken by another account, team or instance are not this member's,
  // and neither is the tag: two checkouts must never share one.
  const same =
    held !== null &&
    held.instance === credential.instance &&
    held.account === credential.account &&
    held.teamId === teamId
  let mine = same ? held!.blocks : {}
  const tag = (same && held!.local?.tag) || drawTag()
  const save = (blocks: Record<string, Block>, refused?: Refused) =>
    saveReserved(mapPath, {
      version: 1,
      instance: credential.instance,
      account: credential.account,
      teamId,
      blocks,
      local: { tag },
      ...(refused ? { refused } : {}),
    })
  const fail = (reason: RefusalReason, detail: string, nextAt?: string): BlocksOutcome => {
    const short = detail.slice(0, 200)
    save(mine, {
      reason,
      at: new Date().toISOString(),
      ...(nextAt ? { nextAt } : {}),
      detail: short,
    })
    return { status: 'failed', reason, detail: short, ...(nextAt ? { nextAt } : {}), tag }
  }

  const map = loadMap(mapPath)
  const need = basesNeedingBlocks(map, mine, CORE_BASES)
  if (need.length === 0 && same) {
    save(mine) // adds a tag to an older file, and clears a refusal nothing needs now
    return { status: 'kept' }
  }

  // Keyed by base: a local kind's numbers are another family and floor nothing.
  const floors = highestPerKind(map)
  let ranges: { base: string; start: number; end: number }[] = []
  // A rule base the server's key version refuses (Cloud 809444d0): no block
  // for it, the engine bases' blocks kept, and the refusal on the band.
  let refused: { bases: string[]; detail: string } | undefined
  if (need.length) {
    try {
      let sent: Record<string, number> | undefined
      ;({
        ranges,
        refused,
        floors: sent,
      } = await reservePlaceholders(
        credential,
        teamId,
        need.map((base) => ({ base, count: 1, floor: floors[base] ?? 0 })),
        undefined,
        {
          block: true,
          keys: teamKeyBytes(credential, home, teamId),
          keyVersion: teamKeyVersion(credential, home, teamId),
          unconfirmed: teamKeyUnconfirmed(credential, home, teamId),
          ...(reservations !== undefined ? { reservations } : {}),
        }
      ))
      // Round 4 (D): the floor the server was sent, once vouched.
      Object.assign(floors, sent ?? {})
    } catch (err) {
      const retry = err instanceof CloudError ? err.body?.retry_at : undefined
      const nextAt =
        typeof retry === 'string' && !Number.isNaN(Date.parse(retry)) ? retry : undefined
      return fail(reasonOf(err), err instanceof CloudError ? err.message : String(err), nextAt)
    }
  }
  // A reply that is not one sane run per kind asked for is no block: the
  // guard would otherwise number from whatever it said.
  const asked = need.filter((base) => !refused?.bases.includes(base))
  const sane =
    Array.isArray(ranges) &&
    ranges.length === asked.length &&
    ranges.every(
      (r) => asked.includes(r?.base) && isSaneBlock(r) && r.start > (floors[r.base] ?? 0)
    )
  if (!sane) return fail('server', 'the server answered without a usable block')
  const blocks: Record<string, Block> = { ...mine }
  for (const r of ranges) blocks[r.base] = { start: r.start, end: r.end }
  if (refused) {
    mine = blocks
    return fail('server', refused.detail)
  }
  save(blocks)
  return {
    status: 'reserved',
    blocks: Object.fromEntries(ranges.map((r) => [r.base, { start: r.start, end: r.end }])),
  }
}
