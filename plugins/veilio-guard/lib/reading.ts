// Spec 091: one reader of a command's words (the reading table). Every word
// of a parsed command, wherever it stands, is turned into what the shell can
// make of it and judged by the one raw-only judge (lib/guard.ts beforeTool).
import { ansiC, braceNames } from './paths.ts'
import type { List, Part, Word } from './shell.ts'

export const isWord = (x: object): x is Word =>
  Array.isArray((x as Word).parts) && typeof (x as Word).raw === 'string'

/** Every word under a part of a parsed command, wherever it stands:
 *  arguments, redirect targets on any command, assignment values, loop lists,
 *  a case's word, the written value of a parameter, and the words of every
 *  command inside a substitution, arithmetic, a here-document or a nested
 *  shell. A walk of the tree's shape, so a place the parser adds is read
 *  without a change here. An outer word comes before the words inside it;
 *  `within` is what a word stands in, outermost first. */
export function wordsWithin(tree: unknown): { word: Word; within: object[] }[] {
  const out: { word: Word; within: object[] }[] = []
  const path: object[] = []
  const visit = (x: unknown): void => {
    if (Array.isArray(x)) return x.forEach(visit)
    if (x === null || typeof x !== 'object') return
    if (isWord(x)) out.push({ word: x, within: [...path] })
    path.push(x)
    for (const v of Object.values(x)) visit(v)
    path.pop()
  }
  visit(tree)
  return out
}

/** Every word of a parsed command (see wordsWithin). */
export const wordsOf = (list: List): Word[] => wordsWithin(list).map((p) => p.word)

/** A wildcard or brace character that was quoted: an ordinary character. */
const QUOTED = '\u0001'
/** A part the shell fills in when the command runs. */
const UNKNOWN = '\u0002'
const quote = (t: string) => t.replace(/[*?[\]{},]/g, QUOTED)
const MAX_SPELLINGS = 64

/** A bracket list or range of up to 64 characters as a brace list of them
 *  (reading table E8); null for a class that is negated, holds a POSIX class
 *  or is larger. */
function bracketList(glob: string): string | null {
  const m = /^\[([^!^[\]][^[\]]*)\]$/.exec(glob)
  if (!m) return null
  const chars = new Set<string>()
  const set = m[1]!
  for (let i = 0; i < set.length; i++) {
    const [a, b] = [set.codePointAt(i)!, set.codePointAt(i + 2)]
    if (set[i + 1] === '-' && b !== undefined && b >= a) {
      if (b - a >= MAX_SPELLINGS) return null
      for (let c = a; c <= b; c++) chars.add(String.fromCodePoint(c))
      i += 2
    } else chars.add(set[i]!)
    if (chars.size > MAX_SPELLINGS) return null
  }
  const list = [...chars].map(quote)
  return list.length === 1 ? list[0]! : `{${list.join(',')}}`
}

/** What the shell can make of a word, as names and globs, by the reading
 *  table: quotes, escapes and ANSI-C quotes read exactly, brace and bracket
 *  lists expanded, `~` and `$HOME` the known home, a default written in the
 *  command one more spelling. `**` stands for any text; a wildcard or brace
 *  character that was quoted is not one. */
export function spellings(
  w: Word,
  o: { home: string | null; homeKnown: boolean; strict: boolean }
): string[] | 'any' {
  const home = o.homeKnown && o.home !== null ? quote(o.home) : null
  let texts: string[] = ['']
  const add = (alternatives: string[]) => {
    const next: string[] = []
    for (const t of texts) for (const a of alternatives) next.push(t + a)
    // Past the cap the word is read as "anything" in this place.
    texts = next.length > MAX_SPELLINGS ? texts.map((t) => `${t}**`) : next
  }
  for (const p of w.parts) {
    const alternatives = partSpellings(p, home, o)
    if (alternatives === 'any') return 'any'
    add(alternatives)
  }
  const out = new Set<string>()
  for (const t of texts) {
    const read = t.split(UNKNOWN).join('**')
    for (const name of braceNames(read)) out.add(name)
  }
  return [...out]
}

function partSpellings(
  p: Part,
  home: string | null,
  o: { home: string | null; homeKnown: boolean; strict: boolean }
): string[] | 'any' {
  switch (p.kind) {
    case 'lit':
      return [p.quoted ? quote(p.text) : p.text]
    case 'glob':
      return [bracketList(p.text) ?? p.text]
    case 'brace':
      return [p.text]
    case 'ansic':
      if (p.text.startsWith("$'")) return [quote(ansiC(p.text.slice(2, -1)))]
      return /[$`]/.test(p.text.slice(1)) ? [UNKNOWN] : [quote(p.text.slice(2, -1))]
    case 'tilde':
      return [p.user === '' && home !== null ? home : UNKNOWN]
    case 'param': {
      if (p.operand === undefined)
        return [p.name === 'HOME' && p.op === '' && home !== null ? home : UNKNOWN]
      // A value written in the command is one more spelling (E11).
      const out = [UNKNOWN]
      for (const word of p.operand) {
        const s = spellings(word, o)
        if (s === 'any') return 'any'
        out.push(...s)
      }
      return out
    }
    default:
      return [UNKNOWN]
  }
}

/** A spelling and the pieces of it a program may take as a file name: around
 *  `=`, `:` and `,`, after a leading `@`, after a short option's letter. */
export function pieces(spelling: string): string[] {
  const out = new Set<string>()
  const add = (p: string): void => {
    if (p === '' || out.has(p)) return
    out.add(p)
    if (/^-[A-Za-z0-9]/.test(p)) add(p.slice(2))
    if (p.startsWith('@')) add(p.slice(1))
  }
  add(spelling)
  // The colons of a POSIX class (`[[:alpha:]]`) are part of the class.
  const held = spelling.replace(/\[:([a-z]+):\]/g, '[\u0003$1\u0003]')
  for (const p of held.split(/[=:,]+/)) add(p.replaceAll('\u0003', ':'))
  return [...out]
}

/** The command's blank-separated chunks, each as typed and as it reads with
 *  line continuations, quotes and backslashes removed: a floor under the
 *  reader, which does not depend on it. */
export function quoteBlind(command: string): [typed: string, read: string][] {
  const out: [string, string][] = []
  for (const m of command.matchAll(/(?:\\\n|\S)+/g)) {
    const read = m[0].replace(/\\\n/g, '').replace(/['"\\]/g, '')
    if (read !== m[0]) out.push([m[0], read])
  }
  return out
}
