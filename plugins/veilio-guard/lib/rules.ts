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

const count = (x: unknown): number =>
  Number.isInteger(x) && (x as number) >= 0 ? (x as number) : 0

/** The signed-in account's cached rules, with what was not applied and why. */
export async function readGuardRules(
  read: (path: string) => Promise<string>,
  home: string | undefined
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
  const rules: CustomRule[] = []
  for (const r of cache.rules as CustomRule[]) {
    if (!r.enabled) continue
    if (!isSafeRegex(r.pattern) || (r.type === 'replace' && isEngineBase(r.placeholder)))
      skipped.refused++
    else rules.push(r)
  }
  return { rules, skipped, state: 'applied' }
}
