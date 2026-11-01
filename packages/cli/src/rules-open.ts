// Opening the custom rules Cloud serves sealed (spec 065), for `veilio rules
// pull` and the MCP server. Apart from rules.ts because it reaches the cloud
// boundary's types and the team keys, and `scrub` - which reads rules.ts - must
// not (offline.test.ts).

import {
  openRuleFromVault,
  openTeamRule,
  parseVaultEnvelope,
  type CustomRule,
  type CryptoKeyLike,
  type RuleBinding,
  type RuleOpened,
  type TeamMapEnvelope,
} from '@veilio-inc/engine'
import { homedir } from 'node:os'
import type { SealedRule, SealedRuleList } from './cloud.js'
import type { Credential } from './credential.js'
import { importPersonalMapsKey, readPersonalMapsKey } from './client/personal-maps-key.js'
import { NO_RULES_SKIPPED, type RulesSkipped } from './client/rules-skipped.js'
import { heldTeamKeys } from './team-namespace.js'

/**
 * Open the rules Cloud served (spec 065) with the keys on this machine: the
 * personal-maps key for personal rules, the team's unlocked keys (any held
 * version) for each team's rules. Nothing here throws on a rule: one that
 * cannot be opened or must not be applied is counted, and masking goes on.
 */
export async function openFetchedRules(
  fetched: Partial<SealedRuleList>,
  credential: Credential,
  home: string = homedir()
): Promise<{ personal: CustomRule[]; team: CustomRule[]; skipped: RulesSkipped }> {
  const skipped = { ...NO_RULES_SKIPPED }
  const count = (opened: RuleOpened): void => {
    if (!opened.ok) skipped[opened.reason === 'refused' ? 'refused' : 'unopenable']++
  }
  // The scope is the list the row came in, never the row's own label: a
  // team-sealed rule labelled personal is the team's (security audit).
  const toRule = (
    row: SealedRule,
    opened: RuleOpened,
    scope: 'personal' | 'team'
  ): CustomRule | null => {
    count(opened)
    if (!opened.ok) return null
    return {
      ...opened.rule,
      id: row.id,
      scope,
      team_id: row.team_id,
      sort_order: row.sort_order,
    } as CustomRule
  }

  const personal: CustomRule[] = []
  const rows = fetched.rules ?? []
  const raw = rows.length ? readPersonalMapsKey(credential, home) : null
  if (rows.length && !raw) skipped.vaultLocked += rows.length
  else if (raw) {
    const pmk = await importPersonalMapsKey(raw)
    for (const row of rows) {
      const rule = toRule(row, await openPersonal(pmk, row), 'personal')
      if (rule) personal.push(rule)
    }
  }

  const team: CustomRule[] = []
  const keysByTeam = new Map<string, { version: number; key: CryptoKeyLike }[]>()
  for (const row of fetched.teamRules ?? []) {
    const teamId = row.team_id ?? ''
    if (!keysByTeam.has(teamId))
      keysByTeam.set(teamId, teamId ? await heldTeamKeys(credential, home, teamId) : [])
    const keys = keysByTeam.get(teamId) ?? []
    if (keys.length === 0) {
      skipped.teamLocked++
      continue
    }
    const rule = toRule(row, await openTeam(keys, row), 'team')
    if (rule) team.push(rule)
  }
  return { personal, team, skipped }
}

const UNOPENABLE: RuleOpened = { ok: false, reason: 'unopenable' }

async function openPersonal(pmk: CryptoKeyLike, row: SealedRule): Promise<RuleOpened> {
  try {
    return await openRuleFromVault(pmk, parseVaultEnvelope(row.data), bindOf(row))
  } catch {
    return UNOPENABLE
  }
}

async function openTeam(
  keys: readonly { version: number; key: CryptoKeyLike }[],
  row: SealedRule
): Promise<RuleOpened> {
  try {
    return await openTeamRule(keys, JSON.parse(row.data) as TeamMapEnvelope, bindOf(row))
  } catch {
    return UNOPENABLE
  }
}

/** The row a body was sealed for: one moved to another row does not open. */
function bindOf(row: SealedRule): RuleBinding {
  return { id: row.id, teamId: row.team_id }
}
