// Opening the custom rules Cloud serves sealed (spec 065), for `veilio rules
// pull` and the MCP server. Apart from rules.ts because it reaches the cloud
// boundary's types and the team keys, and `scrub` - which reads rules.ts - must
// not (offline.test.ts).

import {
  importTeamKey,
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
import { printable } from './reservations.js'
import { heldTeamKeys } from './team-namespace.js'
import { readTeamUnlock, type TeamUnlock } from './team-unlock.js'

/** Team rules held back until this member confirms the key they are sealed
 *  under (spec 092): one entry per team and granter, in served order. Said by
 *  the command that fetched them; never written to the rules cache. */
export interface RulesWaiting {
  teamId: string
  /** The unlock record's team name, else the id. */
  teamName: string
  /** The stored label of who granted the key; null when the record has none. */
  granter: string | null
  count: number
}

const teamRules = (n: number, name: string): string =>
  `${n} team rule${n === 1 ? '' : 's'} for team "${printable(name)}"`

/** `veilio rules pull`: one line per entry. `teamArgOf` gives the team as
 *  `team trust` takes it; the fingerprint is the granter's to show, so the
 *  line names the argument, not a value. */
export function rulesWaitingLines(
  waiting: readonly RulesWaiting[],
  teamArgOf: (name: string, id: string) => string
): string[] {
  return waiting.map(
    (w) =>
      `${teamRules(w.count, w.teamName)} ${w.count === 1 ? 'is' : 'are'} waiting: confirm the key of ` +
      `${w.granter === null ? 'the teammate who granted your team key' : printable(w.granter)} first - ` +
      `run \`veilio team trust ${teamArgOf(w.teamName, w.teamId)} <fingerprint>\` ` +
      `with the fingerprint they show on their dashboard.`
  )
}

/** The MCP rules line's parenthesis: each team's total, granters not named. */
export function rulesWaitingNote(waiting: readonly RulesWaiting[]): string {
  const teams = new Map<string, { name: string; count: number }>()
  for (const w of waiting) {
    const t = teams.get(w.teamId) ?? { name: w.teamName, count: 0 }
    t.count += w.count
    teams.set(w.teamId, t)
  }
  return [...teams.values()]
    .map(
      (t) => `${teamRules(t.count, t.name)} wait${t.count === 1 ? 's' : ''} for a key confirmation`
    )
    .join(', ')
}

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
): Promise<{
  personal: CustomRule[]
  team: CustomRule[]
  skipped: RulesSkipped
  waiting: RulesWaiting[]
}> {
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
  type Keys = { version: number; key: CryptoKeyLike }[]
  const keysByTeam = new Map<string, { all: Keys; confirmed: Keys }>()
  const waiting: RulesWaiting[] = []
  let unlock: TeamUnlock | null | undefined
  for (const row of fetched.teamRules ?? []) {
    const teamId = row.team_id ?? ''
    if (!keysByTeam.has(teamId))
      keysByTeam.set(
        teamId,
        teamId
          ? {
              all: await heldTeamKeys(credential, home, teamId),
              confirmed: await heldTeamKeys(credential, home, teamId, { writableOnly: true }),
            }
          : { all: [], confirmed: [] }
      )
    const keys = keysByTeam.get(teamId)!
    if (keys.all.length === 0) {
      skipped.teamLocked++
      continue
    }
    // Spec 085 R2-8: a rule changes masking, so only a key whose sender this
    // member confirmed may author one. One that opens only under another key
    // is held back and counted; the rest is judged as before.
    const opened = keys.confirmed.length ? await openTeam(keys.confirmed, row) : UNOPENABLE
    if (!opened.ok && opened.reason === 'unopenable' && (await openTeam(keys.all, row)).ok) {
      skipped.teamUnconfirmed++
      // Who to confirm: the granter of the stored key that opens this row,
      // found by trying the unconfirmed keys (the row's key_version is the
      // server's word).
      unlock ??= readTeamUnlock(credential, home)
      let granter: string | null = null
      for (const stored of unlock?.keys ?? []) {
        if (stored.writable) continue
        const key = await importTeamKey(stored.key).catch(() => null)
        if (key && (await openTeam([{ version: stored.version, key }], row)).ok) {
          granter = stored.granter?.label ?? null
          break
        }
      }
      const entry = waiting.find((w) => w.teamId === teamId && w.granter === granter)
      if (entry) entry.count++
      else waiting.push({ teamId, teamName: unlock?.teamName ?? teamId, granter, count: 1 })
      continue
    }
    const rule = toRule(row, opened, 'team')
    if (rule) team.push(rule)
  }
  return { personal, team, skipped, waiting }
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
