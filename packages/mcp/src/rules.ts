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
import { mergeRules, readRules, removeRules, writeRules } from '@veilio-inc/cli/rules'
import type { CustomRule } from '@veilio-inc/engine'

export interface ResolvedRules {
  /** 'cloud' fetched now; 'cached' Cloud did not answer, so the last pull; 'none'. */
  source: 'cloud' | 'cached' | 'none'
  rules: CustomRule[]
  /** When the cached rules were pulled. Only for 'cached'. */
  pulledAt?: string
}

const NONE: ResolvedRules = { source: 'none', rules: [] }

let current: ResolvedRules = NONE
let priming: Promise<ResolvedRules> | null = null

async function fetchRules(home: string | undefined): Promise<ResolvedRules> {
  const credential = readCredential(home)
  if (!credential) return NONE

  try {
    const fetched = await listRules(credential)
    const rules = mergeRules(fetched.rules ?? [], fetched.teamRules ?? [])
    // Refresh the CLI's cache too, so `veilio scrub` on this machine agrees
    // with the agent. A failed write costs nothing here.
    try {
      writeRules(
        { instance: credential.instance, account: credential.account, pulledAt: new Date().toISOString(), rules },
        home
      )
    } catch {
      // ignore
    }
    return { source: 'cloud', rules }
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
    if (cached && cached.rules.length > 0) {
      return { source: 'cached', rules: cached.rules, pulledAt: cached.pulledAt }
    }
    return NONE
  }
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
