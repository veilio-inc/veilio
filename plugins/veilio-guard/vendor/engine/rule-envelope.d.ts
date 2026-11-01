import { type RuleBody } from './rule-checks.js';
import { type TeamMapEnvelope } from './teamKeys.js';
import { type CryptoKeyLike, type VaultEnvelope } from './vault.js';
export declare const RULE_KIND = "veilio-rule";
/** The row a sealed body belongs to: its id and its team (null: personal).
 *  Sealed into the body and checked on opening, so a server that cannot read
 *  a rule cannot move it either - put a copy of one rule in another's row, or
 *  a team's rule in another team's (security review, 2026-10-30). Replaying an
 *  older body of the SAME row is not caught: that needs state the client does
 *  not keep, as for maps. */
export interface RuleBinding {
    id: string;
    teamId: string | null;
}
export type RuleOpened = {
    ok: true;
    rule: RuleBody;
}
/** `unopenable`: wrong key or damaged bytes. `not-a-rule`: something else was
 *  sealed there. `refused`: a rule no tool may apply; `detail` says why. */
 | {
    ok: false;
    reason: 'unopenable' | 'not-a-rule' | 'refused';
    detail?: string;
};
/** Seal a personal rule under the personal-maps key. Refuses a rule no tool
 *  may apply, so a bad rule is never sealed in the first place. */
export declare function sealRuleForVault(key: CryptoKeyLike, rule: RuleBody, bind: RuleBinding): Promise<VaultEnvelope>;
export declare function openRuleFromVault(key: CryptoKeyLike, env: VaultEnvelope, bind: RuleBinding): Promise<RuleOpened>;
/** Seal a team rule under the team key. */
export declare function sealTeamRule(teamKey: CryptoKeyLike, rule: RuleBody, bind: RuleBinding): Promise<TeamMapEnvelope>;
/** Open a team rule with whichever held version fits. */
export declare function openTeamRule(keys: readonly {
    version: number;
    key: CryptoKeyLike;
}[], env: TeamMapEnvelope, bind: RuleBinding): Promise<RuleOpened>;
