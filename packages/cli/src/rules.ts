// The account's custom rules, cached on this machine.
//
// Custom rules are defined in the web app and live in Cloud. Before this file
// the terminal and the MCP server never applied them: the same code masked
// differently in the browser than in `veilio scrub`, and a whitelisted name
// that the browser left readable came back as a placeholder here (found on
// staging, 2026-09-26).
//
// `veilio scrub` must stay offline (see offline.test.ts), so it cannot ask Cloud
// for them. `veilio rules pull` fetches them and writes this cache; `scrub`
// applies what the cache holds and says how old it is. Reads tolerate absence
// and damage the way credential.ts does: a broken cache reads as "no rules",
// never as a failed scrub.

import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { STORE_DIR, type CustomRule } from '@veilio-inc/engine'

export const RULES_FILE = 'rules.json'

export interface CachedRules {
  /** Which account these belong to - a different sign-in does not inherit them. */
  instance: string
  account: string
  /** ISO time of the pull, so `scrub` can say how old they are. */
  pulledAt: string
  /** Already merged into the order the engine applies them in. */
  rules: CustomRule[]
}

export function rulesPath(home: string = homedir()): string {
  return join(home, STORE_DIR, RULES_FILE)
}

/**
 * Personal and team rules in the order the web app applies them:
 * team whitelist, personal whitelist, team replace, personal replace.
 *
 * Whitelists first so a name either list keeps readable is never renamed by a
 * replace rule; team before personal so the team's naming wins on a clash,
 * which is what keeps two members' output interchangeable. Disabled rules are
 * dropped and sort_order renumbered 0..n-1, so the engine sees one sequence.
 * Must match `useMergedRules` in the Cloud frontend.
 */
export function mergeRules(
  personal: readonly CustomRule[],
  team: readonly CustomRule[]
): CustomRule[] {
  const byOrder = (a: CustomRule, b: CustomRule): number => a.sort_order - b.sort_order
  const on = (list: readonly CustomRule[], type: CustomRule['type']): CustomRule[] =>
    list.filter((r) => r.enabled && r.type === type).sort(byOrder)
  return [
    ...on(team, 'whitelist'),
    ...on(personal, 'whitelist'),
    ...on(team, 'replace'),
    ...on(personal, 'replace'),
  ].map((r, i) => ({ ...r, sort_order: i }))
}

function isRule(value: unknown): value is CustomRule {
  if (typeof value !== 'object' || value === null) return false
  const r = value as Record<string, unknown>
  if (typeof r.pattern !== 'string' || typeof r.sort_order !== 'number') return false
  if (r.type === 'whitelist') return true
  return r.type === 'replace' && typeof r.placeholder === 'string'
}

/** The cached rules for this account, or null. Null for every kind of failure. */
export function readRules(
  owner: { instance: string; account: string },
  home: string = homedir()
): CachedRules | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(rulesPath(home), 'utf8'))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const c = parsed as Record<string, unknown>
  if (c.instance !== owner.instance || c.account !== owner.account) return null
  if (typeof c.pulledAt !== 'string' || !Array.isArray(c.rules) || !c.rules.every(isRule)) {
    return null
  }
  return parsed as CachedRules
}

/** 0600: the patterns name what a team considers sensitive. */
export function writeRules(cached: CachedRules, home: string = homedir()): void {
  const path = rulesPath(home)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(cached, null, 2)}\n`, { mode: 0o600 })
  chmodSync(path, 0o600)
}

/** Remove the cache. Missing is not an error; failing to delete is. */
export function removeRules(home: string = homedir()): boolean {
  const path = rulesPath(home)
  try {
    statSync(path)
  } catch {
    return false
  }
  rmSync(path, { recursive: true, force: true })
  return true
}

/** "3 hours ago" - coarse on purpose; it answers "is this stale", no more. */
export function describeAge(pulledAt: string, now: Date = new Date()): string {
  const ms = now.getTime() - new Date(pulledAt).getTime()
  if (!Number.isFinite(ms)) return 'at an unknown time'
  const minutes = Math.max(0, Math.floor(ms / 60_000))
  if (minutes < 60) return minutes <= 1 ? 'just now' : `${minutes} minutes ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  return `${Math.floor(hours / 24)} days ago`
}
