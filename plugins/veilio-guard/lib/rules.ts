// The account's custom rules, as `veilio rules pull` left them on this machine
// (spec 065 R10). The guard stays offline: it never fetches, it reads the CLI's
// cache, `~/.veilio/rules.json`, and only when the cache belongs to the account
// `~/.veilio/credential.json` is signed in as. It does not import the CLI, so
// both files are read here with the CLI's tolerance: absent or damaged reads
// as no rules, never as a failed load.
import { isEngineBase, isSafeRegex, STORE_DIR } from '../vendor/engine/index.js'
import type { CustomRule } from '../vendor/engine/index.js'

export type RulesSkipped = {
  vaultLocked: number
  teamLocked: number
  unopenable: number
  refused: number
}

export type GuardRules = {
  /** In the CLI's order, the ones this guard may apply. */
  rules: CustomRule[]
  skipped: RulesSkipped
  state: 'applied' | 'none-pulled' | 'other-account'
}

const zero = (): RulesSkipped => ({ vaultLocked: 0, teamLocked: 0, unopenable: 0, refused: 0 })
export const NO_RULES: GuardRules = { rules: [], skipped: zero(), state: 'none-pulled' }

type Json = Record<string, unknown>

async function readJson(
  read: (path: string) => Promise<string>,
  path: string
): Promise<Json | null> {
  try {
    const parsed: unknown = JSON.parse(await read(path))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Json) : null
  } catch {
    return null
  }
}

// The CLI's isRule (packages/cli/src/rules.ts).
function isRule(value: unknown): value is CustomRule {
  if (typeof value !== 'object' || value === null) return false
  const r = value as Json
  if (typeof r.pattern !== 'string' || typeof r.sort_order !== 'number') return false
  if (r.type === 'whitelist') return true
  return r.type === 'replace' && typeof r.placeholder === 'string'
}

/**
 * Which keys this machine still holds: the CLI's definition, mirrored
 * (keysHeld in packages/cli/src/rules.ts - the one documented definition;
 * this file cannot import the CLI). Personal: `personal-maps-key.json` is v1,
 * the signed-in instance and account, unexpired, its key 32 bytes. Team T:
 * `team-keys.json` likewise, teamId T, at least one key of 32 bytes. Absent,
 * damaged, expired or somebody else's: not held. Both suites run the same
 * table (custom-rules.test.ts here, rules-lock-purge.test.ts in the CLI).
 */
async function keysHeld(
  read: (path: string) => Promise<string>,
  dir: string,
  credential: Json,
  now: number
): Promise<{ personal: boolean; team: string | null }> {
  const usable = (key: unknown): boolean => {
    try {
      return typeof key === 'string' && key !== '' && atob(key).length === 32
    } catch {
      return false
    }
  }
  const valid = (f: Json | null, fields: string[]): f is Json => {
    if (!f || f.v !== 1) return false
    if (!fields.every((k) => typeof f[k] === 'string' && f[k] !== '')) return false
    if (f.instance !== credential.instance || f.account !== credential.account) return false
    const expires = Date.parse(f.expiresAt as string)
    return !Number.isNaN(expires) && expires > now
  }
  const pmk = await readJson(read, `${dir}/personal-maps-key.json`)
  const team = await readJson(read, `${dir}/team-keys.json`)
  const keys = team?.keys
  // The CLI rejects the whole file when any entry is malformed (isTeamUnlock).
  const wellFormed =
    Array.isArray(keys) &&
    keys.length > 0 &&
    keys.every(
      (k: unknown) =>
        typeof k === 'object' &&
        k !== null &&
        typeof (k as Json).version === 'number' &&
        typeof (k as Json).key === 'string' &&
        (k as Json).key !== ''
    )
  return {
    personal: valid(pmk, ['instance', 'account', 'expiresAt', 'key']) && usable(pmk.key),
    team:
      valid(team, ['instance', 'account', 'teamId', 'expiresAt']) &&
      wellFormed &&
      (keys as Json[]).some((k) => usable(k.key))
        ? (team.teamId as string)
        : null,
  }
}

const count = (x: unknown): number =>
  Number.isInteger(x) && (x as number) >= 0 ? (x as number) : 0

/** The signed-in account's cached rules, with what was not applied and why.
 *  A rule whose key is no longer held (locked, expired) is not applied. */
export async function readGuardRules(
  read: (path: string) => Promise<string>,
  home: string | undefined,
  now: number = Date.now()
): Promise<GuardRules> {
  if (!home) return NO_RULES
  const dir = `${home.replace(/[\\/]+$/, '')}/${STORE_DIR}`
  const cache = await readJson(read, `${dir}/rules.json`)
  if (
    !cache ||
    typeof cache.pulledAt !== 'string' ||
    !Array.isArray(cache.rules) ||
    !cache.rules.every(isRule)
  )
    return NO_RULES
  const credential = await readJson(read, `${dir}/credential.json`)
  const owner = (k: string) =>
    typeof credential?.[k] === 'string' && credential[k] !== '' && credential[k] === cache[k]
  if (!owner('instance') || !owner('account')) return { ...NO_RULES, state: 'other-account' }
  const s = (cache.skipped ?? {}) as Json
  const skipped: RulesSkipped = {
    vaultLocked: count(s.vaultLocked),
    teamLocked: count(s.teamLocked),
    unopenable: count(s.unopenable),
    refused: count(s.refused),
  }
  // What the engine would skip silently (a pattern its matcher refuses, a
  // replace rule under its own base) is counted, so the band says so.
  const held = await keysHeld(read, dir, credential!, now)
  const rules: CustomRule[] = []
  for (const r of cache.rules as CustomRule[]) {
    if (!r.enabled) continue
    // Anything not marked team is treated as personal, as the CLI does.
    if (r.scope === 'team' ? r.team_id === null || r.team_id !== held.team : !held.personal) {
      skipped[r.scope === 'team' ? 'teamLocked' : 'vaultLocked']++
      continue
    }
    if (!isSafeRegex(r.pattern) || (r.type === 'replace' && isEngineBase(r.placeholder)))
      skipped.refused++
    else rules.push(r)
  }
  return { rules, skipped, state: 'applied' }
}
