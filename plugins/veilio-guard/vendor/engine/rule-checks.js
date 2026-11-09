// What a custom rule may be (spec 065).
//
// Veilio Cloud used to check every rule on write. Rules are now sealed under
// the customer's keys, so the server cannot read them, and the checks live
// here instead: the web app makes them before sealing, and every tool that
// opens a rule makes them again before applying it - a rule a hostile team
// member or an old client sealed must not corrupt or freeze a teammate's tools.
import { MANUAL_BASE, REGULATED_BASES, ROLE_BASES } from './engine.js';
import { LOCAL_PREFIX } from './localFamily.js';
import { REDACTION_PREFIX } from './product.js';
import { compileRulePattern } from './rule-pattern.js';
let bases = null;
/** A placeholder base the engine uses for its own names. A rule under one
 *  would read as the engine's, and spec 064 shows an ordinary word under an
 *  engine base readable. Built on first use, from the engine's own lists, so a
 *  base the engine adds is reserved too (and so no import cycle runs at load). */
export function isEngineBase(placeholder) {
    bases ??= new Set([
        ...Object.values(ROLE_BASES),
        ...Object.values(REGULATED_BASES),
        MANUAL_BASE,
    ]);
    // The local family (spec 066) is the engine's too: a rule minting under it
    // would read as names numbered on one machine, which teammates leave.
    return (bases.has(placeholder) ||
        placeholder.startsWith(REDACTION_PREFIX) ||
        placeholder.startsWith(LOCAL_PREFIX));
}
/**
 * Whether a custom rule's pattern may be applied: the engine's own linear-time
 * matcher accepts it (rule-pattern.ts). Such a pattern cannot freeze a tool,
 * whatever its shape - three rounds of security review showed that shape
 * heuristics over the platform's backtracking RegExp can always be bypassed.
 */
export function isSafeRegex(pattern) {
    return compileRulePattern(pattern) !== null;
}
const PLACEHOLDER_RE = /^__[A-Z][A-Z0-9_]*__$/;
const RESERVED_RE = /^__P\d+__$/;
/** Why this rule may not be saved or applied, in a sentence - or null. The
 *  sentences are the ones Veilio Cloud's server gave. */
/**
 * A team whitelist is exact names (spec 085 R2-7, founder 2026-11-09): one
 * anchored name, or an anchored list of them. An allow-list of shapes, not a
 * judgement of breadth: one sealed `[A-Za-z_$][A-Za-z0-9_$]*` kept every
 * identifier readable for every member. A name is letters in any script,
 * digits, `_`, or an escaped character that is not a letter, digit or space.
 */
const EXACT_NAME = String.raw `(?:[\p{L}\p{N}_]|\\[^\p{L}\p{N}\s])+`;
const EXACT_NAMES = new RegExp(String.raw `^\^(?:${EXACT_NAME}|\(${EXACT_NAME}(?:\|${EXACT_NAME})*\))\$$`, 'u');
export const TEAM_WHITELIST_REFUSAL = "A team whitelist must name the identifiers it keeps: `^Name$`, or `^(NameOne|NameTwo)$`. A pattern that matches names in general would send the whole team's names as written.";
export function ruleRefusal(rule, 
/** Whose rule: a team's whitelist must name what it keeps (spec 085 R2-7). */
scope = 'personal') {
    if (typeof rule.name !== 'string' || rule.name.length < 1 || rule.name.length > 80)
        return 'A rule needs a name of 1 to 80 characters';
    if (typeof rule.pattern !== 'string' || rule.pattern.length < 1 || rule.pattern.length > 500)
        return 'A pattern is 1 to 500 characters';
    if (!isSafeRegex(rule.pattern))
        return 'This pattern uses something rules do not support (a backreference, lookaround, \\b, or a bound over 50)';
    if (scope === 'team' && rule.type === 'whitelist' && !EXACT_NAMES.test(rule.pattern))
        return TEAM_WHITELIST_REFUSAL;
    if (rule.type === 'replace') {
        const p = rule.placeholder;
        if (typeof p !== 'string' || p.length < 3 || p.length > 80 || !PLACEHOLDER_RE.test(p))
            return 'Placeholder must match /^__[A-Z][A-Z0-9_]*__$/';
        if (RESERVED_RE.test(p))
            return 'Placeholder __P<n>__ is reserved';
        if (isEngineBase(p))
            return `Placeholder ${p} is reserved for the engine's own names; choose another, such as __CODENAME__`;
    }
    return null;
}
