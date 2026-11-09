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
import { STORE_DIR, fromBase64, ruleRefusal, type CustomRule } from '@veilio-inc/engine'
import type { RulesSkipped } from './client/rules-skipped.js'
import { readPersonalMapsKey } from './client/personal-maps-key.js'
import { readTeamUnlock } from './team-unlock.js'

export const RULES_FILE = 'rules.json'

export interface CachedRules {
  /** Which account these belong to - a different sign-in does not inherit them. */
  instance: string
  account: string
  /** ISO time of the pull, so `scrub` can say how old they are. */
  pulledAt: string
  /** Already merged into the order the engine applies them in. */
  rules: CustomRule[]
  /** Served but not applied here, by cause (spec 065). Absent in a cache
   *  written before it, which reads as all zeros. */
  skipped?: RulesSkipped
  /** Team whitelists this member has been told about, by rule id (spec 085
   *  R2-7): each new one is announced once. */
  shownWhitelists?: string[]
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

function readSkipped(value: unknown): RulesSkipped {
  const v = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
  const n = (x: unknown): number => (Number.isInteger(x) && (x as number) >= 0 ? (x as number) : 0)
  return {
    vaultLocked: n(v.vaultLocked),
    teamLocked: n(v.teamLocked),
    unopenable: n(v.unopenable),
    refused: n(v.refused),
    teamUnconfirmed: n(v.teamUnconfirmed),
  }
}

function isRule(value: unknown): value is CustomRule {
  if (typeof value !== 'object' || value === null) return false
  const r = value as Record<string, unknown>
  if (typeof r.pattern !== 'string' || typeof r.sort_order !== 'number') return false
  if (r.type === 'whitelist') return true
  return r.type === 'replace' && typeof r.placeholder === 'string'
}

/**
 * Which keys this machine still holds - THE definition of "held" for applying
 * cached rules (spec 065 FR-006). The guard mirrors it in
 * plugins/veilio-guard/lib/rules.ts; both suites run the same table
 * (rules-lock-purge.test.ts, custom-rules.test.ts).
 *
 * Personal: `personal-maps-key.json` is v1, this instance and account,
 * unexpired, and its key decodes to 32 bytes (readPersonalMapsKey).
 * Team T: `team-keys.json` is v1, this instance and account, unexpired, its
 * teamId is T, and at least one key decodes to 32 bytes - what heldTeamKeys
 * keeps after importTeamKey drops a damaged one. Absent, damaged, expired or
 * somebody else's: not held. `teamConfirmed`: one such key is writable, so its
 * sender was confirmed (spec 085 R2-8): only then do the team's rules apply.
 */
function keysHeld(
  owner: { instance: string; account: string },
  home: string,
  now: Date
): { personal: boolean; team: string | null; teamConfirmed: boolean } {
  const unlock = readTeamUnlock(owner, home, now)
  const usable = (key: string): boolean => {
    try {
      return fromBase64(key).byteLength === 32
    } catch {
      return false
    }
  }
  return {
    personal: readPersonalMapsKey(owner, home, now) !== null,
    team: unlock && unlock.keys.some((k) => usable(k.key)) ? unlock.teamId : null,
    teamConfirmed: !!unlock && unlock.keys.some((k) => k.writable && usable(k.key)),
  }
}

/**
 * The cached rules for this account, or null. Null for every kind of failure.
 *
 * Only the rules whose key is still held are returned: a rule opened while the
 * vault or team key was unlocked must not outlive that key - a lock, an expiry,
 * an unlock of another team. The rest are counted as vaultLocked/teamLocked.
 */
export function readRules(
  owner: { instance: string; account: string },
  home: string = homedir(),
  now: Date = new Date()
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
  const skipped = readSkipped(c.skipped)
  const held = keysHeld(owner, home, now)
  const rules = (c.rules as CustomRule[]).filter((r) => {
    // Anything not marked team is treated as personal: it needs a key either way.
    const ok = r.scope === 'team' ? r.team_id !== null && r.team_id === held.team : held.personal
    if (!ok) {
      skipped[r.scope === 'team' ? 'teamLocked' : 'vaultLocked']++
      return false
    }
    if (r.scope !== 'team') return true
    // Spec 085 R2-7, R2-8: judged again here, so a cache written before the
    // checks, or kept after a key lost its confirmation, applies neither.
    if (!held.teamConfirmed) {
      skipped.teamUnconfirmed++
      return false
    }
    if (ruleRefusal(r, 'team') !== null) {
      skipped.refused++
      return false
    }
    return true
  })
  return { ...(parsed as CachedRules), rules, skipped }
}

/**
 * Remove one scope's rules from the cache when its key is locked, and count
 * them as skipped, so the opened content does not stay readable on disk. Reads
 * the file without the owner check: removing never needs to be ours. Returns
 * how many were removed; a missing or damaged cache removes none. The file is
 * rewritten 0600.
 */
export function purgeRules(scope: 'personal' | 'team', home: string = homedir()): number {
  let parsed: CachedRules
  try {
    parsed = JSON.parse(readFileSync(rulesPath(home), 'utf8')) as CachedRules
  } catch {
    return 0
  }
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray(parsed.rules)) return 0
  const isScope = (r: CustomRule): boolean => (r.scope === 'team') === (scope === 'team')
  const removed = parsed.rules.filter(isScope).length
  if (removed === 0) return 0
  const skipped = readSkipped(parsed.skipped)
  skipped[scope === 'team' ? 'teamLocked' : 'vaultLocked'] += removed
  // Never removed outright: the count just added is something to report.
  writeRules({ ...parsed, rules: parsed.rules.filter((r) => !isScope(r)), skipped }, home)
  return removed
}

/**
 * The notices for team whitelists this member has not been told about yet
 * (spec 085 R2-7, founder 2026-11-09: each member is told once), and the ids
 * to record as told. Read from the cache as it is before this pull.
 */
export function newTeamWhitelists(
  rules: readonly CustomRule[],
  home: string = homedir()
): { notices: string[]; shown: string[] } {
  let before: string[] = []
  try {
    const parsed = JSON.parse(readFileSync(rulesPath(home), 'utf8')) as {
      shownWhitelists?: unknown
    }
    if (Array.isArray(parsed.shownWhitelists))
      before = parsed.shownWhitelists.filter((id): id is string => typeof id === 'string')
  } catch {
    // no cache yet: nothing told
  }
  const team = rules.filter((r) => r.scope === 'team' && r.type === 'whitelist')
  const fresh = team.filter((r) => !before.includes(r.id))
  return {
    notices: fresh.map(
      (r) =>
        `veilio: a new team rule keeps names as written: \`${printable(r.name)}\` (\`${printable(r.pattern)}\`).`
    ),
    shown: [...new Set([...before, ...team.map((r) => r.id)])],
  }
}

/** A rule's own text, shown without control or format characters. */
const printable = (s: string): string => s.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, '?')

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
