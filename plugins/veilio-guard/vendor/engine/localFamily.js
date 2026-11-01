export const LOCAL_PREFIX = '__LOCAL_';
/** The highest placeholder number anything mints or trusts (security audit):
 *  near 2^53 adding one stops changing a number, and two names would share a
 *  placeholder; the server caps its numbers here too (Cloud 450a93ce). A number above it - a planted key, a server's answer - is
 *  ignored for the highest, and never numbered after. */
export const MAX_PLACEHOLDER_NUMBER = 100_000_000;
/** The most numbers one reservation may span (the server asks at most 5000). */
export const MAX_BLOCK_SPAN = 10_000;
/** A run of numbers safe to number in: whole, in [1, 1e8], in order, short. */
export function isSaneBlock(b) {
    const { start, end } = (b ?? {});
    return (Number.isSafeInteger(start) &&
        Number.isSafeInteger(end) &&
        start >= 1 &&
        end <= MAX_PLACEHOLDER_NUMBER &&
        start <= end &&
        end - start <= MAX_BLOCK_SPAN);
}
const TAG = /^[A-Z0-9]{6}$/;
const TEAM_BASE = /^__[A-Z][A-Z0-9_]*__$/;
const LOCAL_BASE = /^__LOCAL_[A-Z0-9]{6}_([A-Z][A-Z0-9_]*)__$/;
const LOCAL_TOKEN = /^__LOCAL_[A-Z0-9]{6}_[A-Z][A-Z0-9_]*__\d+$/;
const ROLE_TOKEN = /^__(?:LOCAL_[A-Z0-9]{6}_)?(?:CLS|FN|PKG|VAR|STR)__\d+$/;
const NUMBERED = /^(__[A-Z][A-Z0-9_]*__)(\d+)$/;
/** A numbered placeholder of the local family. */
export function isLocalPlaceholder(token) {
    return LOCAL_TOKEN.test(token);
}
/** Whether a tag can name a checkout: six of `A-Z0-9`. */
export function isLocalTag(tag) {
    return typeof tag === 'string' && TAG.test(tag);
}
/** `__VAR__`, `K7Q2XA` -> `__LOCAL_K7Q2XA_VAR__`. Throws on a bad tag, on
 *  something that is not a base, and on a base already local. */
export function localBaseOf(base, tag) {
    if (!isLocalTag(tag))
        throw new TypeError(`localBaseOf: a tag is six of A-Z0-9, got ${JSON.stringify(tag)}`);
    if (!TEAM_BASE.test(base) || base.startsWith(LOCAL_PREFIX))
        throw new TypeError(`localBaseOf: ${JSON.stringify(base)} is not a team placeholder base`);
    return `${LOCAL_PREFIX}${tag}_${base.slice(2)}`;
}
/** The team base a local base stands in for, or null for anything else. */
export function teamBaseOf(localBase) {
    const m = LOCAL_BASE.exec(localBase);
    return m ? `__${m[1]}__` : null;
}
/** A role-typed name (`__CLS__n` and the like) in either family. */
export function isRolePlaceholder(token) {
    return ROLE_TOKEN.test(token);
}
/** Highest number per base in a map. */
export function highestPerKind(map) {
    const out = {};
    for (const p of Object.keys(map)) {
        const m = NUMBERED.exec(p);
        if (!m)
            continue;
        const [, base = '', n = '0'] = m;
        if (Number(n) <= MAX_PLACEHOLDER_NUMBER && Number(n) > (out[base] ?? 0))
            out[base] = Number(n);
    }
    return out;
}
/**
 * The highest number of `base` inside `block`, or `start - 1` when none is.
 * Only numbers inside count: the server issued the block to this member alone,
 * so a teammate's higher number - or a planted __VAR__60000 (security audit,
 * round 4) - says nothing about which of its numbers are free.
 */
export function usedInBlock(keys, base, block) {
    let top = block.start - 1;
    for (const key of keys) {
        if (!key.startsWith(base))
            continue;
        const rest = key.slice(base.length);
        const n = /^\d+$/.test(rest) ? Number(rest) : 0;
        if (n >= block.start && n <= block.end && n > top)
            top = n;
    }
    return top;
}
/** A block is usable while it has a number above the highest used inside it. */
export function usableBlocks(map, blocks) {
    const keys = Object.keys(map);
    return Object.fromEntries(Object.entries(blocks).filter(([base, b]) => usedInBlock(keys, base, b) < b.end));
}
/** Reserved numbers still free, over every usable block. */
export function numbersLeft(map, blocks) {
    const keys = Object.keys(map);
    return Object.entries(usableBlocks(map, blocks)).reduce((sum, [base, b]) => sum + b.end - usedInBlock(keys, base, b), 0);
}
