/** A placeholder base the engine uses for its own names. A rule under one
 *  would read as the engine's, and spec 064 shows an ordinary word under an
 *  engine base readable. Built on first use, from the engine's own lists, so a
 *  base the engine adds is reserved too (and so no import cycle runs at load). */
export declare function isEngineBase(placeholder: string): boolean;
/**
 * Whether a custom rule's pattern may be applied: the engine's own linear-time
 * matcher accepts it (rule-pattern.ts). Such a pattern cannot freeze a tool,
 * whatever its shape - three rounds of security review showed that shape
 * heuristics over the platform's backtracking RegExp can always be bypassed.
 */
export declare function isSafeRegex(pattern: string): boolean;
/** A rule as its owner wrote it - what is sealed. */
export type RuleBody = {
    name: string;
    type: 'replace';
    pattern: string;
    placeholder: string;
    enabled: boolean;
} | {
    name: string;
    type: 'whitelist';
    pattern: string;
    enabled: boolean;
};
export declare const TEAM_WHITELIST_REFUSAL = "A team whitelist must name the identifiers it keeps: `^Name$`, or `^(NameOne|NameTwo)$`. A pattern that matches names in general would send the whole team's names as written.";
export declare function ruleRefusal(rule: RuleBody, 
/** Whose rule: a team's whitelist must name what it keeps (spec 085 R2-7). */
scope?: 'personal' | 'team'): string | null;
