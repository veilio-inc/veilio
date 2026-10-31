// The local family (spec 066): placeholders a checkout numbers while it holds
// no usable block of team numbers. `__LOCAL_<TAG>_<KIND>__n`, where the tag
// names the checkout, so two checkouts never mint the same string and no team
// map ever holds one. Numbering above the map's highest instead lands exactly
// where the next teammate's block starts (spec 065 benchmark).
//
// No value imports from engine.ts: it imports this file, and a cycle would
// evaluate this one first.
import type { SymbolMap } from './types.js'

/** A range of team numbers reserved for this checkout, inclusive (spec 063). */
export type Block = { start: number; end: number }

export const LOCAL_PREFIX = '__LOCAL_'

const TAG = /^[A-Z0-9]{6}$/
const TEAM_BASE = /^__[A-Z][A-Z0-9_]*__$/
const LOCAL_BASE = /^__LOCAL_[A-Z0-9]{6}_([A-Z][A-Z0-9_]*)__$/
const LOCAL_TOKEN = /^__LOCAL_[A-Z0-9]{6}_[A-Z][A-Z0-9_]*__\d+$/
const ROLE_TOKEN = /^__(?:LOCAL_[A-Z0-9]{6}_)?(?:CLS|FN|PKG|VAR|STR)__\d+$/
const NUMBERED = /^(__[A-Z][A-Z0-9_]*__)(\d+)$/

/** A numbered placeholder of the local family. */
export function isLocalPlaceholder(token: string): boolean {
  return LOCAL_TOKEN.test(token)
}

/** Whether a tag can name a checkout: six of `A-Z0-9`. */
export function isLocalTag(tag: unknown): tag is string {
  return typeof tag === 'string' && TAG.test(tag)
}

/** `__VAR__`, `K7Q2XA` -> `__LOCAL_K7Q2XA_VAR__`. Throws on a bad tag, on
 *  something that is not a base, and on a base already local. */
export function localBaseOf(base: string, tag: string): string {
  if (!isLocalTag(tag))
    throw new TypeError(`localBaseOf: a tag is six of A-Z0-9, got ${JSON.stringify(tag)}`)
  if (!TEAM_BASE.test(base) || base.startsWith(LOCAL_PREFIX))
    throw new TypeError(`localBaseOf: ${JSON.stringify(base)} is not a team placeholder base`)
  return `${LOCAL_PREFIX}${tag}_${base.slice(2)}`
}

/** The team base a local base stands in for, or null for anything else. */
export function teamBaseOf(localBase: string): string | null {
  const m = LOCAL_BASE.exec(localBase)
  return m ? `__${m[1]}__` : null
}

/** A role-typed name (`__CLS__n` and the like) in either family. */
export function isRolePlaceholder(token: string): boolean {
  return ROLE_TOKEN.test(token)
}

/** Highest number per base in a map. */
export function highestPerKind(map: SymbolMap): Record<string, number> {
  const out: Record<string, number> = {}
  for (const p of Object.keys(map)) {
    const m = NUMBERED.exec(p)
    if (!m) continue
    const [, base = '', n = '0'] = m
    if (Number(n) > (out[base] ?? 0)) out[base] = Number(n)
  }
  return out
}

/** A block is usable while nothing in the map sits at or above its end. */
export function usableBlocks(map: SymbolMap, blocks: Record<string, Block>): Record<string, Block> {
  const top = highestPerKind(map)
  return Object.fromEntries(Object.entries(blocks).filter(([base, b]) => (top[base] ?? 0) < b.end))
}

/** Reserved numbers still free, over every usable block. */
export function numbersLeft(map: SymbolMap, blocks: Record<string, Block>): number {
  const top = highestPerKind(map)
  return Object.entries(usableBlocks(map, blocks)).reduce(
    (sum, [base, b]) => sum + b.end - Math.max(top[base] ?? 0, b.start - 1),
    0
  )
}
