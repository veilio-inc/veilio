// What a custom rule may be (spec 065).
//
// Veilio Cloud used to check every rule on write. Rules are now sealed under
// the customer's keys, so the server cannot read them, and the checks live
// here instead: the web app makes them before sealing, and every tool that
// opens a rule makes them again before applying it - a rule a hostile team
// member or an old client sealed must not corrupt or freeze a teammate's tools.

import { MANUAL_BASE, REGULATED_BASES, ROLE_BASES } from './engine.js'
import { REDACTION_PREFIX } from './product.js'

let bases: Set<string> | null = null

/** A placeholder base the engine uses for its own names. A rule under one
 *  would read as the engine's, and spec 064 shows an ordinary word under an
 *  engine base readable. Built on first use, from the engine's own lists, so a
 *  base the engine adds is reserved too (and so no import cycle runs at load). */
export function isEngineBase(placeholder: string): boolean {
  bases ??= new Set<string>([
    ...Object.values(ROLE_BASES),
    ...(Object.values(REGULATED_BASES) as string[]),
    MANUAL_BASE,
  ])
  return bases.has(placeholder) || placeholder.startsWith(REDACTION_PREFIX)
}

/**
 * Heuristic ReDoS guard, moved from the Cloud backend.
 *
 * 1. Static: refuses a repeated group that itself repeats - (a+)+, (\w+)* - or
 *    that holds an alternation - (a|aa)+. The second was added with the move:
 *    its cost grows with the identifier's length, which the fuzz strings below
 *    are too short to show.
 * 2. Runtime: runs the compiled pattern on short strings under a 100 ms budget.
 *
 * Not a guarantee; defence in depth beside the 500-character cap.
 */
const BUDGET_MS = 100
const NESTED_QUANTIFIER_RE = /\([^)]*[+*][^)]*\)[+*{]|\([^)]*\)[+*]\+/
const REPEATED_ALTERNATION_RE = /\((?:\?:)?[^()]*\|[^()]*\)[+*{]/
const FUZZ_STRINGS = ['a'.repeat(20) + 'b', 'a'.repeat(25) + 'b']

export function isSafeRegex(pattern: string): boolean {
  let compiled: RegExp
  try {
    compiled = new RegExp(pattern)
  } catch {
    return false
  }
  if (NESTED_QUANTIFIER_RE.test(pattern) || REPEATED_ALTERNATION_RE.test(pattern)) return false
  const start = Date.now()
  try {
    for (const fuzz of FUZZ_STRINGS) {
      compiled.test(fuzz)
      if (Date.now() - start >= BUDGET_MS) return false
    }
  } catch {
    return false
  }
  return Date.now() - start < BUDGET_MS
}

/** A rule as its owner wrote it - what is sealed. */
export type RuleBody =
  | { name: string; type: 'replace'; pattern: string; placeholder: string; enabled: boolean }
  | { name: string; type: 'whitelist'; pattern: string; enabled: boolean }

const PLACEHOLDER_RE = /^__[A-Z][A-Z0-9_]*__$/
const RESERVED_RE = /^__P\d+__$/

/** Why this rule may not be saved or applied, in a sentence - or null. The
 *  sentences are the ones Veilio Cloud's server gave. */
export function ruleRefusal(rule: RuleBody): string | null {
  if (typeof rule.name !== 'string' || rule.name.length < 1 || rule.name.length > 80)
    return 'A rule needs a name of 1 to 80 characters'
  if (typeof rule.pattern !== 'string' || rule.pattern.length < 1 || rule.pattern.length > 500)
    return 'A pattern is 1 to 500 characters'
  if (!isSafeRegex(rule.pattern)) return 'Invalid or unsafe regex pattern'
  if (rule.type === 'replace') {
    const p = (rule as { placeholder?: unknown }).placeholder
    if (typeof p !== 'string' || p.length < 3 || p.length > 80 || !PLACEHOLDER_RE.test(p))
      return 'Placeholder must match /^__[A-Z][A-Z0-9_]*__$/'
    if (RESERVED_RE.test(p)) return 'Placeholder __P<n>__ is reserved'
    if (isEngineBase(p))
      return `Placeholder ${p} is reserved for the engine's own names; choose another, such as __CODENAME__`
  }
  return null
}
