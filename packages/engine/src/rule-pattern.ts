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
const MAX_BOUND = 50
/** States, at most. Every state may be live at every position, so this bounds
 *  the work per character. 10000 let an 18-character pattern cost 2.5 ms per
 *  name and slow masking 37-fold, and 1000 still cost 1.6 s on 5000 distinct
 *  names (CE code review, measured). Rule patterns describe names - ^phoenix$,
 *  ^[a-z]+_id$, a 50-member class repeated a few times - and fit in 256. */
const MAX_STATES = 256
/** Answers kept per matcher: the guard tests every token of a command's
 *  output, and the same names come back again and again. */
const CACHE_SIZE = 4096
/** Build steps, at most. Nested repeats of an empty group create no states,
 *  so the state cap alone never trips, while compiling them walks the tree
 *  50^depth times (fifth security review). */
const MAX_BUILD_STEPS = 100_000
/** A name this long times the pattern's states is the most work one test may
 *  do. Past it the test answers "no match" - a whitelist does not keep the
 *  name readable and a replace rule does not rename it, so the engine masks
 *  it as it would anyway: the safe direction. */
const MAX_WORK = 20_000_000
/** Matching steps one anonymize call may spend over all its rules and names
 *  (security audit: hostile rules over 5000 names took seconds). Past it,
 *  every test answers "no match", and the call says so. */
export const RULE_WORK_BUDGET = 50_000_000

/** A per-call allowance of matching steps, shared by every rule and name. */
export interface RuleBudget {
  left: number
  spent: boolean
}

/** What the CLI, the MCP and the guard say when `rulesStopped` is set. */
export const RULES_STOPPED_NOTE =
  'custom rules stopped matching: too much work. Names after that point were masked as usual, and no rule kept one readable or gave it a rule placeholder.'

export function ruleBudget(steps: number = RULE_WORK_BUDGET): RuleBudget {
  return { left: steps, spent: false }
}

type Pred = (c: number) => boolean

/** A set of UTF-16 code units as sorted, disjoint, inclusive [lo, hi] pairs,
 *  flattened. Every class compiles to one, so a check costs log(members)
 *  however many members it lists (fourth security review: a predicate per
 *  member made a large class repeated many times expensive per step). */
type Ranges = number[]

type Node =
  | { t: 'char'; r: Ranges }
  | { t: 'bol' }
  | { t: 'eol' }
  | { t: 'cat'; items: Node[] }
  | { t: 'alt'; items: Node[] }
  | { t: 'rep'; node: Node; min: number; max: number }

class Unsupported extends Error {}

function normalize(pairs: [number, number][]): Ranges {
  const sorted = [...pairs].sort((a, b) => a[0] - b[0])
  const out: Ranges = []
  for (const [lo, hi] of sorted) {
    const last = out.length - 1
    if (last > 0 && lo <= out[last]! + 1) out[last] = Math.max(out[last]!, hi)
    else out.push(lo, hi)
  }
  return out
}

function pairsOf(r: Ranges): [number, number][] {
  const out: [number, number][] = []
  for (let k = 0; k < r.length; k += 2) out.push([r[k]!, r[k + 1]!])
  return out
}

function complement(r: Ranges): Ranges {
  const out: Ranges = []
  let next = 0
  for (let k = 0; k < r.length; k += 2) {
    if (r[k]! > next) out.push(next, r[k]! - 1)
    next = r[k + 1]! + 1
  }
  if (next <= 0xffff) out.push(next, 0xffff)
  return out
}

function predOf(r: Ranges): Pred {
  return (c) => {
    let lo = 0
    let hi = r.length / 2 - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (c < r[mid * 2]!) hi = mid - 1
      else if (c > r[mid * 2 + 1]!) lo = mid + 1
      else return true
    }
    return false
  }
}

const one = (c: number): Ranges => [c, c]
const DIGIT: Ranges = [48, 57]
const WORD: Ranges = normalize([
  [48, 57],
  [65, 90],
  [95, 95],
  [97, 122],
])
const SPACE: Ranges = normalize([
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
])
const LINE_END: Ranges = normalize([
  [10, 10],
  [13, 13],
  [0x2028, 0x2029],
])
const CONTROL: Record<string, number> = { t: 9, n: 10, v: 11, f: 12, r: 13 }
const CLASS_ESCAPE: Record<string, Ranges> = {
  d: DIGIT,
  D: complement(DIGIT),
  w: WORD,
  W: complement(WORD),
  s: SPACE,
  S: complement(SPACE),
}
const QUANTIFIER = /^\{(\d+)(,(\d*))?\}/

const code = (s: string): number => s.charCodeAt(0)

function parse(src: string): Node {
  let i = 0
  const peek = (): string | undefined => src[i]

  function alt(): Node {
    const items = [seq()]
    while (peek() === '|') {
      i++
      items.push(seq())
    }
    return items.length === 1 ? items[0]! : { t: 'alt', items }
  }

  function seq(): Node {
    const items: Node[] = []
    while (i < src.length && peek() !== '|' && peek() !== ')') {
      let node = atom()
      const q = quantifier()
      if (q) {
        if (node.t === 'bol' || node.t === 'eol') throw new Unsupported('nothing to repeat')
        node = { t: 'rep', node, min: q.min, max: q.max }
        if (peek() === '?') i++ // lazy: the same answer for test()
        if (quantifierAhead()) throw new Unsupported('nothing to repeat')
      }
      items.push(node)
    }
    return { t: 'cat', items }
  }

  function quantifierAhead(): boolean {
    const c = peek()
    return c === '*' || c === '+' || c === '?' || (c === '{' && QUANTIFIER.test(src.slice(i)))
  }

  function quantifier(): { min: number; max: number } | null {
    const c = peek()
    if (c === '*') return (i++, { min: 0, max: Infinity })
    if (c === '+') return (i++, { min: 1, max: Infinity })
    if (c === '?') return (i++, { min: 0, max: 1 })
    if (c !== '{') return null
    const m = QUANTIFIER.exec(src.slice(i))
    if (!m) return null // a literal '{', as JS reads it without the u flag
    i += m[0].length
    const min = Number(m[1])
    const max = m[2] === undefined ? min : m[3] === '' ? Infinity : Number(m[3])
    if (min > max) throw new Unsupported('numbers out of order')
    if (min > MAX_BOUND || (max !== Infinity && max > MAX_BOUND))
      throw new Unsupported('a bound over 50')
    return { min, max }
  }

  function atom(): Node {
    const c = src[i++]!
    switch (c) {
      case '(': {
        if (peek() === '?') {
          if (src[i + 1] !== ':') throw new Unsupported('lookaround or a named group')
          i += 2
        }
        const inner = alt()
        if (src[i++] !== ')') throw new Unsupported('an unclosed group')
        return inner
      }
      case ')':
        throw new Unsupported('an unmatched )')
      case '[':
        return charClass()
      case '.':
        return { t: 'char', r: complement(LINE_END) }
      case '^':
        return { t: 'bol' }
      case '$':
        return { t: 'eol' }
      case '*':
      case '+':
      case '?':
        throw new Unsupported('nothing to repeat')
      case '{':
        if (QUANTIFIER.test(src.slice(i - 1))) throw new Unsupported('nothing to repeat')
        return { t: 'char', r: one(code(c)) }
      case '\\':
        return escape()
      default:
        return { t: 'char', r: one(code(c)) }
    }
  }

  function escape(): Node {
    const c = src[i++]
    if (c === undefined) throw new Unsupported('a trailing backslash')
    const cls = CLASS_ESCAPE[c]
    if (cls) return { t: 'char', r: cls }
    const ctl = CONTROL[c]
    if (ctl !== undefined) return { t: 'char', r: one(ctl) }
    if (/[A-Za-z0-9]/.test(c)) throw new Unsupported(`\\${c}`)
    return { t: 'char', r: one(code(c)) }
  }

  function charClass(): Node {
    let negate = false
    if (peek() === '^') {
      negate = true
      i++
    }
    const parts: [number, number][] = []
    // JS: the first unescaped ']' closes the class, so [] and [^] are whole.
    while (peek() !== ']') {
      if (i >= src.length) throw new Unsupported('an unclosed class')
      const lo = classAtom()
      if (peek() === '-' && src[i + 1] !== ']' && i + 1 < src.length) {
        i++
        const hi = classAtom()
        if (typeof lo !== 'number' || typeof hi !== 'number')
          throw new Unsupported('a range with a class escape')
        if (lo > hi) throw new Unsupported('a range out of order')
        parts.push([lo, hi])
      } else if (typeof lo === 'number') {
        parts.push([lo, lo])
      } else {
        parts.push(...pairsOf(lo))
      }
    }
    i++
    const set = normalize(parts)
    return { t: 'char', r: negate ? complement(set) : set }
  }

  /** One class member: a code unit, or a class escape's set. */
  function classAtom(): number | Ranges {
    const c = src[i++]!
    if (c !== '\\') return code(c)
    const e = src[i++]
    if (e === undefined) throw new Unsupported('a trailing backslash')
    const cls = CLASS_ESCAPE[e]
    if (cls) return cls
    const ctl = CONTROL[e]
    if (ctl !== undefined) return ctl
    if (e === 'b') return 8 // backspace, inside a class
    if (/[A-Za-z0-9]/.test(e)) throw new Unsupported(`\\${e}`)
    return code(e)
  }

  const node = alt()
  if (i < src.length) throw new Unsupported('an unmatched )')
  return node
}

type State =
  | { k: 'char'; p: Pred; out: number }
  | { k: 'split'; outs: number[] }
  | { k: 'bol'; out: number }
  | { k: 'eol'; out: number }
  | { k: 'match' }

function compile(root: Node): { states: State[]; start: number } {
  const states: State[] = [{ k: 'match' }]
  const add = (s: State): number => {
    if (states.length >= MAX_STATES) throw new Unsupported('a pattern too large')
    states.push(s)
    return states.length - 1
  }
  // One predicate per class node, shared by every copy a bound expands it to.
  const preds = new Map<Ranges, Pred>()
  const predFor = (r: Ranges): Pred => {
    let p = preds.get(r)
    if (!p) preds.set(r, (p = predOf(r)))
    return p
  }
  let steps = 0
  // Continuation style: build `node` so that it continues to state `next`.
  const build = (node: Node, next: number): number => {
    if (++steps > MAX_BUILD_STEPS) throw new Unsupported('a pattern too large')
    switch (node.t) {
      case 'char':
        return add({ k: 'char', p: predFor(node.r), out: next })
      case 'bol':
        return add({ k: 'bol', out: next })
      case 'eol':
        return add({ k: 'eol', out: next })
      case 'cat': {
        let cur = next
        for (let j = node.items.length - 1; j >= 0; j--) cur = build(node.items[j]!, cur)
        return cur
      }
      case 'alt':
        return add({ k: 'split', outs: node.items.map((item) => build(item, next)) })
      case 'rep': {
        let cur = next
        if (node.max === Infinity) {
          const loop = add({ k: 'split', outs: [] })
          ;(states[loop] as { outs: number[] }).outs = [build(node.node, loop), next]
          cur = loop
        } else {
          for (let j = 0; j < node.max - node.min; j++)
            cur = add({ k: 'split', outs: [build(node.node, cur), next] })
        }
        for (let j = 0; j < node.min; j++) cur = build(node.node, cur)
        return cur
      }
    }
  }
  return { states, start: build(root, 0) }
}

/** The literal string a node matches, if it matches exactly one. */
function literalOf(node: Node): string | null {
  if (node.t === 'char')
    return node.r.length === 2 && node.r[0] === node.r[1] ? String.fromCharCode(node.r[0]!) : null
  if (node.t !== 'cat') return null
  let out = ''
  for (const item of node.items) {
    const l = literalOf(item)
    if (l === null) return null
    out += l
  }
  return out
}

/** `^(?:lit|lit|...)$` - the guard's keep rule - and `^phoenix$`, as a set of
 *  whole names. Exact (such a pattern matches a name only when it equals one
 *  of the literals), and fast at any size: the keep rule lists every
 *  third-party name a project imports, too many for the NFA's state cap. */
function wholeLiterals(root: Node): Set<string> | null {
  if (root.t !== 'cat' || root.items.length !== 3) return null
  const [bol, body, eol] = root.items as [Node, Node, Node]
  if (bol.t !== 'bol' || eol.t !== 'eol') return null
  const branches = body.t === 'alt' ? body.items : [body]
  const out = new Set<string>()
  for (const b of branches) {
    const l = literalOf(b)
    if (l === null) return null
    out.add(l)
  }
  return out
}

export interface RuleMatcher {
  /** RegExp.prototype.test's answer, in time linear in the name's length.
   *  Never throws. With a budget: steps are taken from it, and once it is
   *  spent the answer is false. */
  test(name: string, budget?: RuleBudget): boolean
}

/** Compile a custom rule's pattern, or null when it is outside the language
 *  this matcher runs (see the top of this file). */
export function compileRulePattern(pattern: string): RuleMatcher | null {
  let root: Node
  try {
    // RegExp must accept it too: the language is a subset, never a superset.
    new RegExp(pattern)
    root = parse(pattern)
  } catch {
    return null
  }
  const whole = wholeLiterals(root)
  if (whole) return { test: (name, budget) => !budget?.spent && whole.has(name) }
  let program: { states: State[]; start: number }
  try {
    program = compile(root)
  } catch {
    return null
  }
  const { states, start } = program
  const answers = new Map<string, boolean>()
  return {
    test(name: string, budget?: RuleBudget): boolean {
      if (budget?.spent) return false
      const known = answers.get(name)
      if (known !== undefined) return known
      let answer: boolean
      try {
        answer = run(states, start, name, budget)
      } catch {
        // Never thrown on purpose; were it, no match - the safe direction.
        answer = false
      }
      // An answer cut short by the budget is not the pattern's: not kept.
      if (budget?.spent) return false
      if (answers.size >= CACHE_SIZE) answers.clear()
      answers.set(name, answer)
      return answer
    },
  }
}

function run(states: State[], start: number, name: string, budget?: RuleBudget): boolean {
  const n = name.length
  if (n * states.length > MAX_WORK) return false
  let steps = 0
  let seen = new Uint32Array(states.length)
  let stamp = 1
  let found = false
  // The epsilon closure, iterative: a long chain of optional atoms must not
  // overflow the call stack (fourth security review).
  const work: number[] = []
  const close = (list: number[], from: number, pos: number): void => {
    work.push(from)
    while (work.length > 0) {
      steps++
      const s = work.pop()!
      if (seen[s] === stamp) continue
      seen[s] = stamp
      const st = states[s]!
      switch (st.k) {
        case 'match':
          found = true
          work.length = 0
          return
        case 'char':
          list.push(s)
          break
        case 'split':
          for (let o = st.outs.length - 1; o >= 0; o--) work.push(st.outs[o]!)
          break
        case 'bol':
          if (pos === 0) work.push(st.out)
          break
        case 'eol':
          if (pos === n) work.push(st.out)
          break
      }
    }
  }
  let current: number[] = []
  for (let pos = 0; ; pos++) {
    if (budget) {
      budget.left -= steps + current.length
      steps = 0
      if (budget.left < 0) {
        budget.spent = true
        return false
      }
    }
    // A new thread at every position: test() searches, it does not anchor.
    close(current, start, pos)
    if (found) return true
    if (pos === n) return false
    const c = name.charCodeAt(pos)
    const next: number[] = []
    stamp++
    if (stamp === 0xffffffff) {
      seen = new Uint32Array(states.length)
      stamp = 1
    }
    for (const s of current) {
      const st = states[s] as { k: 'char'; p: Pred; out: number }
      if (st.p(c)) close(next, st.out, pos + 1)
      if (found) return true
    }
    current = next
  }
}
