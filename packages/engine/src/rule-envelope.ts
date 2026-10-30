// A custom rule sealed under the customer's key (spec 065).
//
// The body is a string record - `kind`, `v`, the rule's fields - sealed with
// the primitives maps already use: the personal-maps key for a personal rule,
// the team key for a team rule. No new cryptography. `kind` keeps a map
// envelope swapped into a rule row (or the reverse) from being read as one.
//
// Opening never throws on bad content. A tool opening a teammate's rule must
// skip one it cannot open or must not apply, say so, and go on masking.

import { ruleRefusal, type RuleBody } from './rule-checks.js'
import { decryptTeamMapWithAny, encryptTeamMap, type TeamMapEnvelope } from './teamKeys.js'
import {
  encryptMapForVault,
  openVaultEnvelope,
  type CryptoKeyLike,
  type VaultEnvelope,
} from './vault.js'

export const RULE_KIND = 'veilio-rule'
const RULE_V = '1'

/** The row a sealed body belongs to: its id and its team (null: personal).
 *  Sealed into the body and checked on opening, so a server that cannot read
 *  a rule cannot move it either - put a copy of one rule in another's row, or
 *  a team's rule in another team's (security review, 2026-10-30). Replaying an
 *  older body of the SAME row is not caught: that needs state the client does
 *  not keep, as for maps. */
export interface RuleBinding {
  id: string
  teamId: string | null
}

export type RuleOpened =
  | { ok: true; rule: RuleBody }
  /** `unopenable`: wrong key or damaged bytes. `not-a-rule`: something else was
   *  sealed there. `refused`: a rule no tool may apply; `detail` says why. */
  | { ok: false; reason: 'unopenable' | 'not-a-rule' | 'refused'; detail?: string }

function toRecord(rule: RuleBody, bind: RuleBinding): Record<string, string> {
  return {
    kind: RULE_KIND,
    v: RULE_V,
    id: bind.id,
    team: bind.teamId ?? '',
    name: rule.name,
    type: rule.type,
    pattern: rule.pattern,
    ...(rule.type === 'replace' ? { placeholder: rule.placeholder } : {}),
    enabled: rule.enabled ? 'true' : 'false',
  }
}

function fromRecord(raw: unknown, bind: RuleBinding): RuleOpened {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    return { ok: false, reason: 'not-a-rule' }
  const r = raw as Record<string, unknown>
  if (r.kind !== RULE_KIND || r.v !== RULE_V) return { ok: false, reason: 'not-a-rule' }
  const refused = (detail: string): RuleOpened => ({ ok: false, reason: 'refused', detail })
  if (r.id !== bind.id || r.team !== (bind.teamId ?? '')) return refused('sealed for another rule')
  if (r.enabled !== 'true' && r.enabled !== 'false') return refused('enabled is not true or false')
  if (typeof r.name !== 'string' || typeof r.pattern !== 'string')
    return refused('a field is missing')
  const enabled = r.enabled === 'true'
  let rule: RuleBody
  if (r.type === 'whitelist') {
    rule = { name: r.name, type: 'whitelist', pattern: r.pattern, enabled }
  } else if (r.type === 'replace') {
    rule = {
      name: r.name,
      type: 'replace',
      pattern: r.pattern,
      placeholder: typeof r.placeholder === 'string' ? r.placeholder : '',
      enabled,
    }
  } else {
    return refused('the rule type is neither replace nor whitelist')
  }
  const why = ruleRefusal(rule)
  return why ? refused(why) : { ok: true, rule }
}

/** Seal a personal rule under the personal-maps key. Refuses a rule no tool
 *  may apply, so a bad rule is never sealed in the first place. */
export async function sealRuleForVault(
  key: CryptoKeyLike,
  rule: RuleBody,
  bind: RuleBinding
): Promise<VaultEnvelope> {
  const why = ruleRefusal(rule)
  if (why) throw new Error(why)
  return encryptMapForVault(key, toRecord(rule, bind))
}

export async function openRuleFromVault(
  key: CryptoKeyLike,
  env: VaultEnvelope,
  bind: RuleBinding
): Promise<RuleOpened> {
  let raw: unknown
  try {
    raw = await openVaultEnvelope(key, env)
  } catch {
    return { ok: false, reason: 'unopenable' }
  }
  return fromRecord(raw, bind)
}

/** Seal a team rule under the team key. */
export async function sealTeamRule(
  teamKey: CryptoKeyLike,
  rule: RuleBody,
  bind: RuleBinding
): Promise<TeamMapEnvelope> {
  const why = ruleRefusal(rule)
  if (why) throw new Error(why)
  return encryptTeamMap(teamKey, toRecord(rule, bind))
}

/** Open a team rule with whichever held version fits. */
export async function openTeamRule(
  keys: readonly { version: number; key: CryptoKeyLike }[],
  env: TeamMapEnvelope,
  bind: RuleBinding
): Promise<RuleOpened> {
  let raw: unknown
  try {
    raw = await decryptTeamMapWithAny(keys, env)
  } catch {
    return { ok: false, reason: 'unopenable' }
  }
  return fromRecord(raw, bind)
}
