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
 * Guard against patterns that backtrack catastrophically (ReDoS).
 *
 * The engine has no dependencies, so it cannot run patterns on a linear-time
 * engine. Instead:
 *
 * 1. Static, a small parser: no repeated group may hold a quantifier or an
 *    alternation at any depth - (a+)+, ((a+))+, (a|aa)+ - and no
 *    backreference. That is star height one, which rules out the exponential
 *    cases. (A security review found the two regexes this replaced let a
 *    nested group through.)
 * 2. Runtime: the compiled pattern runs on short strings under a 100 ms budget.
 *
 * What is left - polynomial backtracking such as \w*\w*$ - is bounded by
 * the engine matching rules only against names of 200 characters or fewer.
 */
const BUDGET_MS = 100
const FUZZ_STRINGS = ['a'.repeat(20) + 'b', 'a'.repeat(25) + 'b']

interface Group {
  inner: boolean
}

/** True when the pattern repeats a group holding a quantifier or alternation,
 *  or uses a backreference. */
function exceedsStarHeight(pattern: string): boolean {
  const stack: Group[] = [{ inner: false }]
  let last: Group | 'atom' | null = null
  let i = 0
  const top = (): Group => stack[stack.length - 1]!
  while (i < pattern.length) {
    const c = pattern[i]!
    if (c === '\\') {
      const next = pattern[i + 1] ?? ''
      if (/[1-9]/.test(next) || next === 'k') return true
      last = 'atom'
      i += 2
      continue
    }
    if (c === '[') {
      i++
      if (pattern[i] === '^') i++
      if (pattern[i] === ']') i++
      while (i < pattern.length && pattern[i] !== ']') i += pattern[i] === '\\' ? 2 : 1
      i++
      last = 'atom'
      continue
    }
    if (c === '(') {
      stack.push({ inner: false })
      i++
      if (pattern[i] === '?') {
        // (?: (?= (?! (?<= (?<! (?<name>
        i++
        if (pattern[i] === '<' && pattern[i + 1] !== '=' && pattern[i + 1] !== '!') {
          while (i < pattern.length && pattern[i] !== '>') i++
        }
        i++
        if (pattern[i - 1] === '<') i++
      }
      last = null
      continue
    }
    if (c === ')') {
      const closed = stack.length > 1 ? stack.pop()! : top()
      if (closed.inner) top().inner = true
      last = closed
      i++
      continue
    }
    if (c === '|') {
      top().inner = true
      last = null
      i++
      continue
    }
    const quant = /^(?:[*+?]|\{(\d+)(,(\d*))?\})/.exec(pattern.slice(i))
    if (quant && last !== null) {
      const [whole, min, comma, max] = quant
      const repeats =
        whole === '*' ||
        whole === '+' ||
        (whole !== '?' && (comma !== undefined ? max === '' || Number(max) > 1 : Number(min) > 1))
      if (repeats && last !== 'atom' && last.inner) return true
      top().inner = true
      i += whole.length
      if (pattern[i] === '?') i++
      last = null
      continue
    }
    last = 'atom'
    i++
  }
  return false
}

export function isSafeRegex(pattern: string): boolean {
  let compiled: RegExp
  try {
    compiled = new RegExp(pattern)
  } catch {
    return false
  }
  if (exceedsStarHeight(pattern)) return false
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
