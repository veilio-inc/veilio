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
const MAX_STATES = 10_000
/** A name this long times the pattern's states is the most work one test may
 *  do. Past it the test answers "no match" - a whitelist does not keep the
 *  name readable and a replace rule does not rename it, so the engine masks
 *  it as it would anyway: the safe direction. */
const MAX_WORK = 20_000_000

type Pred = (c: number) => boolean

type Node =
  | { t: 'char'; p: Pred }
  | { t: 'bol' }
  | { t: 'eol' }
  | { t: 'cat'; items: Node[] }
  | { t: 'alt'; items: Node[] }
  | { t: 'rep'; node: Node; min: number; max: number }

class Unsupported extends Error {}

const code = (s: string): number => s.charCodeAt(0)
const range =
  (lo: number, hi: number): Pred =>
  (c) =>
    c >= lo && c <= hi
const DIGIT: Pred = range(48, 57)
const WORD: Pred = (c) => DIGIT(c) || range(65, 90)(c) || range(97, 122)(c) || c === 95
const SPACE: Pred = (c) =>
  (c >= 9 && c <= 13) ||
  c === 32 ||
  c === 0xa0 ||
  c === 0x1680 ||
  (c >= 0x2000 && c <= 0x200a) ||
  c === 0x2028 ||
  c === 0x2029 ||
  c === 0x202f ||
  c === 0x205f ||
  c === 0x3000 ||
  c === 0xfeff
const not =
  (p: Pred): Pred =>
  (c) =>
    !p(c)
const LINE_END: Pred = (c) => c === 10 || c === 13 || c === 0x2028 || c === 0x2029
const CONTROL: Record<string, number> = { t: 9, n: 10, v: 11, f: 12, r: 13 }
const CLASS_ESCAPE: Record<string, Pred> = {
  d: DIGIT,
  D: not(DIGIT),
  w: WORD,
  W: not(WORD),
  s: SPACE,
  S: not(SPACE),
}
const QUANTIFIER = /^\{(\d+)(,(\d*))?\}/

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
        return { t: 'char', p: not(LINE_END) }
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
        return lit(c)
      case '\\':
        return escape()
      default:
        return lit(c)
    }
  }

  function lit(c: string): Node {
    const n = code(c)
    return { t: 'char', p: (x) => x === n }
  }

  function escape(): Node {
    const c = src[i++]
    if (c === undefined) throw new Unsupported('a trailing backslash')
    const cls = CLASS_ESCAPE[c]
    if (cls) return { t: 'char', p: cls }
    const ctl = CONTROL[c]
    if (ctl !== undefined) return { t: 'char', p: (x) => x === ctl }
    if (/[A-Za-z0-9]/.test(c)) throw new Unsupported(`\\${c}`)
    return lit(c)
  }

  function charClass(): Node {
    let negate = false
    if (peek() === '^') {
      negate = true
      i++
    }
    const parts: Pred[] = []
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
        parts.push(range(lo, hi))
      } else {
        parts.push(typeof lo === 'number' ? (x) => x === lo : lo)
      }
    }
    i++
    const any: Pred = (x) => parts.some((p) => p(x))
    return { t: 'char', p: negate ? not(any) : any }
  }

  /** One class member: a code unit, or a class escape's set. */
  function classAtom(): number | Pred {
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
  // Continuation style: build `node` so that it continues to state `next`.
  const build = (node: Node, next: number): number => {
    switch (node.t) {
      case 'char':
        return add({ k: 'char', p: node.p, out: next })
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

export interface RuleMatcher {
  /** RegExp.prototype.test's answer, in time linear in the name's length. */
  test(name: string): boolean
}

/** Compile a custom rule's pattern, or null when it is outside the language
 *  this matcher runs (see the top of this file). */
export function compileRulePattern(pattern: string): RuleMatcher | null {
  let program: { states: State[]; start: number }
  try {
    // RegExp must accept it too: the language is a subset, never a superset.
    new RegExp(pattern)
    program = compile(parse(pattern))
  } catch {
    return null
  }
  const { states, start } = program
  return {
    test(name: string): boolean {
      const n = name.length
      if (n * states.length > MAX_WORK) return false
      let current: number[] = []
      let seen = new Uint32Array(states.length)
      let stamp = 0
      let found = false
      const close = (list: number[], s: number, pos: number): void => {
        if (found || seen[s] === stamp) return
        seen[s] = stamp
        const st = states[s]!
        switch (st.k) {
          case 'match':
            found = true
            return
          case 'char':
            list.push(s)
            return
          case 'split':
            for (const o of st.outs) close(list, o, pos)
            return
          case 'bol':
            if (pos === 0) close(list, st.out, pos)
            return
          case 'eol':
            if (pos === n) close(list, st.out, pos)
            return
        }
      }
      stamp++
      for (let pos = 0; ; pos++) {
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
    },
  }
}
