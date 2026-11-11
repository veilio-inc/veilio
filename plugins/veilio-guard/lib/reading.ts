// Spec 091: one reader of a command's words (the reading table). Every word
// of a parsed command, wherever it stands, is turned into what the shell can
// make of it and judged by the one raw-only judge (lib/guard.ts beforeTool).
import { ANY_TEXT, ansiC, braceNames } from './paths.ts'
import type { List, Part, Redirect, Simple, Word } from './shell.ts'

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
/** A part the shell fills in when the command runs (a private-use character). */
const UNKNOWN = '\ue002'
/** An arithmetic expansion: digits the shell works out when the command runs. */
const NUMBER = '\ue004'
const RUN_TIME = /[\ue002\ue004]/g
// Strict reading (reading table §2): what an option may make of these.
/** `{` and `}`: braceccl reads `{a-z}` as a class. */
const OPEN = '\ue005'
const CLOSE = '\ue006'
/** `#`: extendedglob repeats what stands before it. */
const REPEAT = '\ue007'
/** `^`: extendedglob reads what follows in the path part as "anything but". */
const NOT = '\ue008'
/** `~` inside a word: extendedglob reads what follows as an exception. */
const EXCEPT = '\ue00b'
const STRICT: Readonly<Record<string, string>> = {
  '{': OPEN,
  '}': CLOSE,
  '#': REPEAT,
  '^': NOT,
  '~': EXCEPT,
}

/** A spelling under strict reading: each marked place read as any text,
 *  with what the operator there applies to. */
function strictRead(text: string): string {
  let t = text
    .replace(/\ue005[^\ue005\ue006/]*\ue006/g, ANY_TEXT)
    .replace(/[\ue005\ue006]/g, ANY_TEXT)
    .replace(/\ue00b[^]*$/, ANY_TEXT)
    .replace(/\ue008[^/]*/g, ANY_TEXT)
  for (let at = t.indexOf(REPEAT); at !== -1; at = t.indexOf(REPEAT)) {
    // What `#` repeats: a class, a group already read as any text, or a character.
    const before = t.slice(0, at)
    const from = /[\]}]$/.test(before)
      ? Math.max(before.lastIndexOf(before.endsWith(']') ? '[' : '{'), 0)
      : Math.max(at - 1, 0)
    t = `${t.slice(0, from)}${ANY_TEXT}${t.slice(at).replace(/^\ue007+/, '')}`
  }
  return t
}

/** A spelling with its run-time parts read (reading table E10, E12): beside
 *  other text in a path part, a value is nothing and a number is `*`; a path
 *  part of its own is any folder. Null for a word made only of them: it
 *  names nothing the command says. */
function runTime(text: string): string | null {
  if (text.search(RUN_TIME) === -1) return text
  if (text.replace(RUN_TIME, '').replaceAll('/', '') === '') return null
  return text
    .split('/')
    .map((part) =>
      part !== '' && part.replace(RUN_TIME, '') === ''
        ? '**'
        : part.replaceAll(UNKNOWN, '').replaceAll(NUMBER, '*')
    )
    .join('/')
}
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
 *  command one more spelling. A part the shell fills in when the command
 *  runs (`$x`, `$(...)`, `$PWD`, `~user`) is read as nothing beside other
 *  text and as any folder when it is a whole path part, so `"$a.$b"` is `.`
 *  and `$DIR/.env` is `.env` in any folder; a word made only of such parts
 *  has no spelling. `**` stands for any text; a wildcard or brace character that
 *  was quoted is not one. */
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
  w.parts.forEach((p, k) => {
    if (texts.length === 0) return
    const alternatives = partSpellings(p, home, o, k === 0)
    if (alternatives === 'any') texts = []
    else add(alternatives)
  })
  // A part that rewrites written text (Z5): the word could be any name.
  if (texts.length === 0) return 'any'
  const out = new Set<string>()
  for (const t of texts) {
    const read = runTime(o.strict ? strictRead(t) : t)
    if (read !== null) for (const name of braceNames(read)) out.add(name)
  }
  return [...out]
}

function partSpellings(
  p: Part,
  home: string | null,
  o: { home: string | null; homeKnown: boolean; strict: boolean },
  first: boolean
): string[] | 'any' {
  switch (p.kind) {
    case 'lit':
      if (p.quoted) return [quote(p.text)]
      return [
        o.strict
          ? p.text.replace(/[{}#^~]/g, (c, at: number) =>
              c === '~' && first && at === 0 ? c : STRICT[c]!
            )
          : p.text,
      ]
    case 'glob':
      return [bracketList(p.text) ?? p.text]
    case 'brace':
      return [o.strict ? ANY_TEXT : p.text]
    case 'zglob':
      // A qualifier names no text; `**` still errs toward refusing a name
      // it ends, and under strict reading it may be a group after all.
      return [!p.any ? '*' : p.star || (p.qualifier && !o.strict) ? '**' : ANY_TEXT]
    case 'ansic':
      if (p.text.startsWith("$'")) return [quote(ansiC(p.text.slice(2, -1)))]
      return /[$`]/.test(p.text.slice(1)) ? [UNKNOWN] : [quote(p.text.slice(2, -1))]
    case 'tilde':
      return [p.user === '' && home !== null ? home : UNKNOWN]
    case 'param': {
      if (p.transforms) return 'any'
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
    case 'arith':
      return [NUMBER]
    default:
      return [UNKNOWN]
  }
}

// The options that leave how words are read as it is (reading table §2).
const SHOPT_PLAIN = new Set(
  'globstar nullglob failglob nocaseglob nocasematch expand_aliases inherit_errexit lastpipe'.split(
    ' '
  )
)
const SET_PLAIN = new Set(
  'errexit nounset pipefail xtrace verbose noclobber noglob errtrace functrace posix'.split(' ')
)
const SET_LETTERS = 'euxvfCabhmnET'
const SHELL = /^(?:.*\/)?(?:bash|sh|zsh|ksh|dash)$/

/** Whether `set`'s arguments name an option outside the plain ones. */
function setChanges(args: (string | null)[]): boolean {
  for (let k = 0; k < args.length; k++) {
    const a = args[k]!
    if (a === null) return true
    if (a === '--' || a === '-' || !/^[-+]/.test(a)) return false
    for (const letter of a.slice(1)) {
      if (letter === 'o') {
        const name = args[++k]
        if (name === undefined) return false
        if (name === null || !SET_PLAIN.has(name)) return true
      } else if (!SET_LETTERS.includes(letter)) return true
    }
  }
  return false
}

/** A shell's options that leave how it reads words as it is: errexit,
 *  nounset, xtrace, verbose, login, interactive, stdin, and `-c` itself. */
const SHELL_LETTERS = 'euxvlisc'
/** Words before a program that are not it. */
const PREFIXES = new Set(['builtin', 'command', 'noglob', 'exec', 'nocorrect'])

/** Whether a shell is started with an option outside the plain ones before
 *  its script: any other letter or digit, `-o`/`+o`/`-O`, a long option, or
 *  an option word the command builds. */
function shellChanges(args: (string | null)[]): boolean {
  for (const a of args) {
    if (a === null) return true
    if (a === '--' || !/^[-+]/.test(a)) return false
    if (a.startsWith('--')) return true
    const letters = a.slice(1)
    if ([...letters].some((letter) => !SHELL_LETTERS.includes(letter))) return true
    if (letters.includes('c')) return false
  }
  return false
}

/** Whether a command changes how the shell reads words. */
export function readsStrictly(list: List): boolean {
  let strict = false
  const visit = (x: unknown): void => {
    if (strict) return
    if (Array.isArray(x)) return x.forEach(visit)
    if (x === null || typeof x !== 'object') return
    if ((x as { type?: unknown }).type === 'simple') {
      const words = (x as Simple).words.map((w) => w.literal)
      words.forEach((w, k) => {
        const rest = words.slice(k + 1)
        if (w === 'setopt' || w === 'unsetopt' || w === 'emulate') strict = true
        else if (w === 'shopt')
          strict ||= rest.some((a) => a === null || (!a.startsWith('-') && !SHOPT_PLAIN.has(a)))
        else if (w === 'set') strict ||= setChanges(rest)
        else if (w !== null && SHELL.test(w)) strict ||= shellChanges(rest)
      })
      const simple = x as Simple
      // zsh's `options` array sets an option as `setopt` does.
      if (
        simple.assigns.some((a) => a.name === 'options') ||
        simple.words.some((w) => /^options(?:\[[^\]]*\])?\+?=/.test(w.raw))
      )
        strict = true
      // A program word the command builds (`$S globdots`) may be any of these.
      const program = simple.words.find((w) => !PREFIXES.has(w.literal ?? ''))
      if (program?.parts.some((p) => p.kind === 'param' || p.kind === 'subst')) strict = true
    }
    for (const v of Object.values(x)) visit(v)
  }
  visit(list)
  return strict
}

/** Whether a word's wildcards may match a leading dot: under strict reading
 *  (globdots, dotglob), and beside a zsh group or qualifier (`*(D)`). */
export const dotsMatch = (w: Word, strict: boolean): boolean =>
  strict || w.parts.some((p) => p.kind === 'zglob' && (p.qualifier || p.star))

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

/** Text that names Veilio's folder as a path: `.veilio` beside a `/` or `~`,
 *  or as a whole quoted string, also when the name is joined from pieces
 *  (`'.vei'+'lio/x'`, `"/.vei"."lio"`, `".vei" "lio"`, `.veil""io`). A web
 *  address (`api.veilio.dev`), a longer name (`.veilio-x.txt`) and a mention
 *  (`see .veilio docs`) are not a path. No list of programs, wrappers or
 *  flags: whatever receives the text, it names the folder or it does not.
 *
 *  shortcut: defence in depth only. A name built another way (`chr(46)`, a
 *  list joined later), a script in a file and code fed on a pipe are not
 *  read; programs the agent runs act as the user (SECURITY.md). Upgrade: a
 *  sandbox, not a longer pattern. */
export function namesVeilioFolder(text: string): boolean {
  // Quotes are `'`, `"` and the backtick (a template literal); a separator
  // is `/` or `\`, so the path is looked for with the text's backslashes
  // kept (`\.veilio\map.json`) and with them removed (an escape).
  const joined = text.replace(/\\\n/g, '').replace(/['"`]\s*[.+]?\s*['"`]/g, '')
  const unquoted = joined.replace(/['"`]/g, '')
  return (
    /['"`]\.veilio['"`]/i.test(joined) ||
    [unquoted, unquoted.replace(/\\/g, '')].some(
      (t) =>
        /[/~\\]\.veilio(?![A-Za-z0-9-]|\.[A-Za-z])/i.test(t) ||
        /(?<![A-Za-z0-9-])\.veilio[/\\]/i.test(t)
    )
  )
}

/** The characters of a path, and of several given to one option. */
const PATH_TEXT = /^[\p{L}\p{N}_.~/\\@%:,=-]*$/u

/** Whether a word's whole value is a path (or paths joined by `=`, `:`, `,`):
 *  what the raw-only rules judge. A variable, a command's output and a
 *  wildcard stand for path text. */
function isPath(w: Word): boolean {
  return w.parts.every((p) => {
    switch (p.kind) {
      case 'lit':
        return PATH_TEXT.test(p.text)
      case 'ansic':
        return PATH_TEXT.test(p.text.startsWith("$'") ? ansiC(p.text.slice(2, -1)) : '(')
      case 'param':
        return p.operand === undefined
      default:
        return true
    }
  })
}

/** A word's value after the shell removes its quotes, with what it expands
 *  left as written. */
function valueOf(w: Word): string {
  if (w.literal !== null) return w.literal
  return w.parts
    .map((p) => {
      switch (p.kind) {
        case 'param':
          return `\${${p.name}${p.op}}`
        case 'subst':
          return '$'
        case 'tilde':
          return `~${p.user}`
        case 'ansic':
          return p.text.startsWith("$'") ? ansiC(p.text.slice(2, -1)) : p.text.slice(2, -1)
        default:
          return p.text
      }
    })
    .join('')
}

/** The texts of a command that are more than a path: the value of each word
 *  that is not wholly a path (code after `-c`, `-e`, `--eval=`, a quoted
 *  argument, whatever its characters), every here-document body and every
 *  here-string. */
export function textsOf(list: List): string[] {
  const out: string[] = []
  const visit = (x: unknown): void => {
    if (Array.isArray(x)) return x.forEach(visit)
    if (x === null || typeof x !== 'object') return
    if (isWord(x)) {
      if (!isPath(x)) out.push(valueOf(x))
    } else {
      const r = x as Partial<Redirect>
      if (typeof r.body === 'string') out.push(r.body)
      if (r.op === '<<<' && r.target) out.push(valueOf(r.target))
    }
    for (const v of Object.values(x)) visit(v)
  }
  visit(list)
  return out
}
