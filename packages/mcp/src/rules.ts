// The account's custom rules - fetched once per MCP session, like the team
// namespace (see namespace.ts for why once, at startup, and never inside a
// tool call).
//
// Before this the server applied no custom rules at all, so an agent masked the
// same code differently from the web app (found on staging, 2026-09-26). The
// fallback is stated on every result, never silent: rules from Cloud, the
// cache `veilio rules pull` left, or none.

import { readCredential } from '@veilio-inc/cli/credential'
import { CloudError, listRules } from '@veilio-inc/cli/cloud'
import {
  mergeRules,
  newTeamWhitelists,
  readRules,
  removeRules,
  writeRules,
} from '@veilio-inc/cli/rules'
import { openFetchedRules, type RulesWaiting } from '@veilio-inc/cli/rules-open'
import { NO_RULES_SKIPPED, type RulesSkipped } from '@veilio-inc/cli/client'
import type { CustomRule } from '@veilio-inc/engine'

export interface ResolvedRules {
  /** 'cloud' fetched now; 'cached' Cloud did not answer, so the last pull; 'none'. */
  source: 'cloud' | 'cached' | 'none'
  rules: CustomRule[]
  /** When the cached rules were pulled. Only for 'cached'. */
  pulledAt?: string
  /** Served but not applied, by cause (spec 065): a locked vault or team key,
   *  or a rule that would not open or must not be applied. */
  skipped: RulesSkipped
  /** Team whitelists new to this member, told once (spec 085 R2-7): on every
   *  result of the session that first saw them. */
  notices?: string[]
  /** Team rules held back until a key is confirmed (spec 092). Only for
   *  'cloud': the cache keeps the count alone. */
  waiting?: RulesWaiting[]
}

const NONE: ResolvedRules = { source: 'none', rules: [], skipped: NO_RULES_SKIPPED }

let current: ResolvedRules = NONE
let priming: Promise<ResolvedRules> | null = null

async function fetchRules(home: string | undefined): Promise<ResolvedRules> {
  const credential = readCredential(home)
  if (!credential) return NONE

  try {
    const fetched = await listRules(credential)
    // Opened with the keys on this machine, as `veilio rules pull` opens them:
    // this server has no passphrase to ask for.
    const { personal, team, skipped, waiting } = await openFetchedRules(fetched, credential, home)
    const rules = mergeRules(personal, team)
    const told = newTeamWhitelists(rules, home)
    // Refresh the CLI's cache too, so `veilio scrub` on this machine agrees
    // with the agent. A failed write costs nothing here.
    try {
      writeRules(
        {
          instance: credential.instance,
          account: credential.account,
          pulledAt: new Date().toISOString(),
          rules,
          skipped,
          shownWhitelists: told.shown,
        },
        home
      )
    } catch {
      // ignore
    }
    return { source: 'cloud', rules, skipped, notices: told.notices, waiting }
  } catch (err) {
    // The plan no longer includes rules: stop applying the old ones, here and
    // in the CLI, rather than letting a stale whitelist keep names readable.
    if (err instanceof CloudError && err.kind === 'unentitled') {
      try {
        removeRules(home)
      } catch {
        // ignore
      }
      return NONE
    }
    const cached = readRules(credential, home)
    const skipped = cached?.skipped ?? NO_RULES_SKIPPED
    if (cached && (cached.rules.length > 0 || rulesSkippedAny(skipped))) {
      return { source: 'cached', rules: cached.rules, pulledAt: cached.pulledAt, skipped }
    }
    return NONE
  }
}

function rulesSkippedAny(s: RulesSkipped): boolean {
  return s.vaultLocked + s.teamLocked + s.unopenable + s.refused + s.teamUnconfirmed > 0
}

/** Resolve once per process; concurrent callers share the one request. */
export function primeRules(home?: string): Promise<ResolvedRules> {
  if (!priming) {
    priming = fetchRules(home).then((resolved) => {
      current = resolved
      return resolved
    })
  }
  return priming
}

/** The resolved rules. 'none' until primed - the safe default for offline tests. */
export function getRules(): ResolvedRules {
  return current
}

/** Test-only. */
export function resetRulesCache(): void {
  current = NONE
  priming = null
}
