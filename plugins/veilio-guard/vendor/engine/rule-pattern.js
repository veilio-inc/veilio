// The matcher for custom-rule patterns (spec 065, third security review).
//
// A custom rule's pattern may come from a teammate the reader never chose to
// trust, sealed where no server can check it. Run on the platform's
// backtracking RegExp, a pattern such as (a+)+$ freezes the tool that applies
// it. Three rounds of shape heuristics each met a new bypass, so patterns are
// not run on RegExp at all: they are compiled to a Thompson NFA and simulated,
// which costs the name's length times the pattern's size, whatever its shape.
//
// The accepted language is the part of JS regex syntax a linear matcher can
// run with the same answers as RegExp.test (no flags): literals, `.`, classes
// with ranges and negation, \d \D \w \W \s \S, \t \n \r \v \f, escaped
// punctuation, ^ and $, groups (capturing or not), alternation, and the
// quantifiers * + ? {n} {n,} {n,m} (lazy or not; bounds up to 50).
// Backreferences, lookaround, \b, Unicode property escapes and the rest are
// refused: `compileRulePattern` returns null, and the rule is skipped.
/** Bounds on what a pattern may expand to. */
const MAX_BOUND = 50;
const MAX_STATES = 10_000;
/** Build steps, at most. Nested repeats of an empty group create no states,
 *  so the state cap alone never trips, while compiling them walks the tree
 *  50^depth times (fifth security review). */
const MAX_BUILD_STEPS = 100_000;
/** A name this long times the pattern's states is the most work one test may
 *  do. Past it the test answers "no match" - a whitelist does not keep the
 *  name readable and a replace rule does not rename it, so the engine masks
 *  it as it would anyway: the safe direction. */
const MAX_WORK = 20_000_000;
class Unsupported extends Error {
}
function normalize(pairs) {
    const sorted = [...pairs].sort((a, b) => a[0] - b[0]);
    const out = [];
    for (const [lo, hi] of sorted) {
        const last = out.length - 1;
        if (last > 0 && lo <= out[last] + 1)
            out[last] = Math.max(out[last], hi);
        else
            out.push(lo, hi);
    }
    return out;
}
function pairsOf(r) {
    const out = [];
    for (let k = 0; k < r.length; k += 2)
        out.push([r[k], r[k + 1]]);
    return out;
}
function complement(r) {
    const out = [];
    let next = 0;
    for (let k = 0; k < r.length; k += 2) {
        if (r[k] > next)
            out.push(next, r[k] - 1);
        next = r[k + 1] + 1;
    }
    if (next <= 0xffff)
        out.push(next, 0xffff);
    return out;
}
function predOf(r) {
    return (c) => {
        let lo = 0;
        let hi = r.length / 2 - 1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (c < r[mid * 2])
                hi = mid - 1;
            else if (c > r[mid * 2 + 1])
                lo = mid + 1;
            else
                return true;
        }
        return false;
    };
}
const one = (c) => [c, c];
const DIGIT = [48, 57];
const WORD = normalize([
    [48, 57],
    [65, 90],
    [95, 95],
    [97, 122],
]);
const SPACE = normalize([
    [9, 13],
    [32, 32],
    [0xa0, 0xa0],
    [0x1680, 0x1680],
    [0x2000, 0x200a],
    [0x2028, 0x2029],
    [0x202f, 0x202f],
    [0x205f, 0x205f],
    [0x3000, 0x3000],
    [0xfeff, 0xfeff],
]);
const LINE_END = normalize([
    [10, 10],
    [13, 13],
    [0x2028, 0x2029],
]);
const CONTROL = { t: 9, n: 10, v: 11, f: 12, r: 13 };
const CLASS_ESCAPE = {
    d: DIGIT,
    D: complement(DIGIT),
    w: WORD,
    W: complement(WORD),
    s: SPACE,
    S: complement(SPACE),
};
const QUANTIFIER = /^\{(\d+)(,(\d*))?\}/;
const code = (s) => s.charCodeAt(0);
function parse(src) {
    let i = 0;
    const peek = () => src[i];
    function alt() {
        const items = [seq()];
        while (peek() === '|') {
            i++;
            items.push(seq());
        }
        return items.length === 1 ? items[0] : { t: 'alt', items };
    }
    function seq() {
        const items = [];
        while (i < src.length && peek() !== '|' && peek() !== ')') {
            let node = atom();
            const q = quantifier();
            if (q) {
                if (node.t === 'bol' || node.t === 'eol')
                    throw new Unsupported('nothing to repeat');
                node = { t: 'rep', node, min: q.min, max: q.max };
                if (peek() === '?')
                    i++; // lazy: the same answer for test()
                if (quantifierAhead())
                    throw new Unsupported('nothing to repeat');
            }
            items.push(node);
        }
        return { t: 'cat', items };
    }
    function quantifierAhead() {
        const c = peek();
        return c === '*' || c === '+' || c === '?' || (c === '{' && QUANTIFIER.test(src.slice(i)));
    }
    function quantifier() {
        const c = peek();
        if (c === '*')
            return (i++, { min: 0, max: Infinity });
        if (c === '+')
            return (i++, { min: 1, max: Infinity });
        if (c === '?')
            return (i++, { min: 0, max: 1 });
        if (c !== '{')
            return null;
        const m = QUANTIFIER.exec(src.slice(i));
        if (!m)
            return null; // a literal '{', as JS reads it without the u flag
        i += m[0].length;
        const min = Number(m[1]);
        const max = m[2] === undefined ? min : m[3] === '' ? Infinity : Number(m[3]);
        if (min > max)
            throw new Unsupported('numbers out of order');
        if (min > MAX_BOUND || (max !== Infinity && max > MAX_BOUND))
            throw new Unsupported('a bound over 50');
        return { min, max };
    }
    function atom() {
        const c = src[i++];
        switch (c) {
            case '(': {
                if (peek() === '?') {
                    if (src[i + 1] !== ':')
                        throw new Unsupported('lookaround or a named group');
                    i += 2;
                }
                const inner = alt();
                if (src[i++] !== ')')
                    throw new Unsupported('an unclosed group');
                return inner;
            }
            case ')':
                throw new Unsupported('an unmatched )');
            case '[':
                return charClass();
            case '.':
                return { t: 'char', r: complement(LINE_END) };
            case '^':
                return { t: 'bol' };
            case '$':
                return { t: 'eol' };
            case '*':
            case '+':
            case '?':
                throw new Unsupported('nothing to repeat');
            case '{':
                if (QUANTIFIER.test(src.slice(i - 1)))
                    throw new Unsupported('nothing to repeat');
                return { t: 'char', r: one(code(c)) };
            case '\\':
                return escape();
            default:
                return { t: 'char', r: one(code(c)) };
        }
    }
    function escape() {
        const c = src[i++];
        if (c === undefined)
            throw new Unsupported('a trailing backslash');
        const cls = CLASS_ESCAPE[c];
        if (cls)
            return { t: 'char', r: cls };
        const ctl = CONTROL[c];
        if (ctl !== undefined)
            return { t: 'char', r: one(ctl) };
        if (/[A-Za-z0-9]/.test(c))
            throw new Unsupported(`\\${c}`);
        return { t: 'char', r: one(code(c)) };
    }
    function charClass() {
        let negate = false;
        if (peek() === '^') {
            negate = true;
            i++;
        }
        const parts = [];
        // JS: the first unescaped ']' closes the class, so [] and [^] are whole.
        while (peek() !== ']') {
            if (i >= src.length)
                throw new Unsupported('an unclosed class');
            const lo = classAtom();
            if (peek() === '-' && src[i + 1] !== ']' && i + 1 < src.length) {
                i++;
                const hi = classAtom();
                if (typeof lo !== 'number' || typeof hi !== 'number')
                    throw new Unsupported('a range with a class escape');
                if (lo > hi)
                    throw new Unsupported('a range out of order');
                parts.push([lo, hi]);
            }
            else if (typeof lo === 'number') {
                parts.push([lo, lo]);
            }
            else {
                parts.push(...pairsOf(lo));
            }
        }
        i++;
        const set = normalize(parts);
        return { t: 'char', r: negate ? complement(set) : set };
    }
    /** One class member: a code unit, or a class escape's set. */
    function classAtom() {
        const c = src[i++];
        if (c !== '\\')
            return code(c);
        const e = src[i++];
        if (e === undefined)
            throw new Unsupported('a trailing backslash');
        const cls = CLASS_ESCAPE[e];
        if (cls)
            return cls;
        const ctl = CONTROL[e];
        if (ctl !== undefined)
            return ctl;
        if (e === 'b')
            return 8; // backspace, inside a class
        if (/[A-Za-z0-9]/.test(e))
            throw new Unsupported(`\\${e}`);
        return code(e);
    }
    const node = alt();
    if (i < src.length)
        throw new Unsupported('an unmatched )');
    return node;
}
function compile(root) {
    const states = [{ k: 'match' }];
    const add = (s) => {
        if (states.length >= MAX_STATES)
            throw new Unsupported('a pattern too large');
        states.push(s);
        return states.length - 1;
    };
    // One predicate per class node, shared by every copy a bound expands it to.
    const preds = new Map();
    const predFor = (r) => {
        let p = preds.get(r);
        if (!p)
            preds.set(r, (p = predOf(r)));
        return p;
    };
    let steps = 0;
    // Continuation style: build `node` so that it continues to state `next`.
    const build = (node, next) => {
        if (++steps > MAX_BUILD_STEPS)
            throw new Unsupported('a pattern too large');
        switch (node.t) {
            case 'char':
                return add({ k: 'char', p: predFor(node.r), out: next });
            case 'bol':
                return add({ k: 'bol', out: next });
            case 'eol':
                return add({ k: 'eol', out: next });
            case 'cat': {
                let cur = next;
                for (let j = node.items.length - 1; j >= 0; j--)
                    cur = build(node.items[j], cur);
                return cur;
            }
            case 'alt':
                return add({ k: 'split', outs: node.items.map((item) => build(item, next)) });
            case 'rep': {
                let cur = next;
                if (node.max === Infinity) {
                    const loop = add({ k: 'split', outs: [] });
                    states[loop].outs = [build(node.node, loop), next];
                    cur = loop;
                }
                else {
                    for (let j = 0; j < node.max - node.min; j++)
                        cur = add({ k: 'split', outs: [build(node.node, cur), next] });
                }
                for (let j = 0; j < node.min; j++)
                    cur = build(node.node, cur);
                return cur;
            }
        }
    };
    return { states, start: build(root, 0) };
}
/** The literal string a node matches, if it matches exactly one. */
function literalOf(node) {
    if (node.t === 'char')
        return node.r.length === 2 && node.r[0] === node.r[1] ? String.fromCharCode(node.r[0]) : null;
    if (node.t !== 'cat')
        return null;
    let out = '';
    for (const item of node.items) {
        const l = literalOf(item);
        if (l === null)
            return null;
        out += l;
    }
    return out;
}
/** `^(?:lit|lit|...)$` - the guard's keep rule - and `^phoenix$`, as a set of
 *  whole names. Exact (such a pattern matches a name only when it equals one
 *  of the literals), and fast at any size: the keep rule lists every
 *  third-party name a project imports, too many for the NFA's state cap. */
function wholeLiterals(root) {
    if (root.t !== 'cat' || root.items.length !== 3)
        return null;
    const [bol, body, eol] = root.items;
    if (bol.t !== 'bol' || eol.t !== 'eol')
        return null;
    const branches = body.t === 'alt' ? body.items : [body];
    const out = new Set();
    for (const b of branches) {
        const l = literalOf(b);
        if (l === null)
            return null;
        out.add(l);
    }
    return out;
}
/** Compile a custom rule's pattern, or null when it is outside the language
 *  this matcher runs (see the top of this file). */
export function compileRulePattern(pattern) {
    let root;
    try {
        // RegExp must accept it too: the language is a subset, never a superset.
        new RegExp(pattern);
        root = parse(pattern);
    }
    catch {
        return null;
    }
    const whole = wholeLiterals(root);
    if (whole)
        return { test: (name) => whole.has(name) };
    let program;
    try {
        program = compile(root);
    }
    catch {
        return null;
    }
    const { states, start } = program;
    return {
        test(name) {
            try {
                return run(states, start, name);
            }
            catch {
                // Never thrown on purpose; were it, no match - the safe direction.
                return false;
            }
        },
    };
}
function run(states, start, name) {
    const n = name.length;
    if (n * states.length > MAX_WORK)
        return false;
    let seen = new Uint32Array(states.length);
    let stamp = 1;
    let found = false;
    // The epsilon closure, iterative: a long chain of optional atoms must not
    // overflow the call stack (fourth security review).
    const work = [];
    const close = (list, from, pos) => {
        work.push(from);
        while (work.length > 0) {
            const s = work.pop();
            if (seen[s] === stamp)
                continue;
            seen[s] = stamp;
            const st = states[s];
            switch (st.k) {
                case 'match':
                    found = true;
                    work.length = 0;
                    return;
                case 'char':
                    list.push(s);
                    break;
                case 'split':
                    for (let o = st.outs.length - 1; o >= 0; o--)
                        work.push(st.outs[o]);
                    break;
                case 'bol':
                    if (pos === 0)
                        work.push(st.out);
                    break;
                case 'eol':
                    if (pos === n)
                        work.push(st.out);
                    break;
            }
        }
    };
    let current = [];
    for (let pos = 0;; pos++) {
        // A new thread at every position: test() searches, it does not anchor.
        close(current, start, pos);
        if (found)
            return true;
        if (pos === n)
            return false;
        const c = name.charCodeAt(pos);
        const next = [];
        stamp++;
        if (stamp === 0xffffffff) {
            seen = new Uint32Array(states.length);
            stamp = 1;
        }
        for (const s of current) {
            const st = states[s];
            if (st.p(c))
                close(next, st.out, pos + 1);
            if (found)
                return true;
        }
        current = next;
    }
}
