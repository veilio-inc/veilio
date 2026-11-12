// Spec 091: one reader of a command's words (the reading table). Every word
// of a parsed command, wherever it stands, is turned into what the shell can
// make of it and judged by the one raw-only judge (lib/guard.ts beforeTool).
import { ANY_TEXT, ansiC, braceNames } from './paths.ts'
import {
  bracket,
  placeOf,
  quotedDelimiter,
  spend,
  type Cost,
  type List,
  type Part,
  type Pipeline,
  type Redirect,
  type Simple,
  type Word,
} from './shell.ts'

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

/** How many words of a parsed command are judged one by one: every word but
 *  those in or under a data position. Counted before the command is walked,
 *  so a command of tens of thousands of words is refused for its cost before
 *  the work that each word takes is done. */
export function judgedWords(tree: unknown, data: Data = NO_DATA): number {
  let n = 0
  const visit = (x: unknown): void => {
    if (Array.isArray(x)) {
      for (const e of x) visit(e)
      return
    }
    if (x === null || typeof x !== 'object' || data.inside.has(x)) return
    if (isWord(x) && !data.words.has(x)) n++
    for (const v of Object.values(x)) visit(v)
  }
  visit(tree)
  return n
}

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

/** A bracket expression as the shell can read it (reading table A2): a
 *  brace list of its characters when it is expanded exactly, else `?` - one
 *  character, whatever it is. Text that is no bracket expression is itself. */
function bracketList(glob: string, kept = false, many = false): string {
  const b = glob.startsWith('[') ? bracket(glob, 0, true) : null
  if (!b || b.end !== glob.length) return glob
  if (b.chars === null) return '?'
  // In a word that is a wildcard anyway the list stays one bracket
  // expression for the matcher, which reads it the same: no spelling per
  // character (`[a-z]*.py` is one glob, not 52).
  if (kept && b.chars.length > 1 && b.chars.every((c) => /^[A-Za-z0-9_.]$/.test(c)))
    return `[${b.chars.join('')}]`
  // Too many spellings to list, and members the matcher has no class for:
  // one character, whatever it is (A2) - never any text.
  if (many && b.chars.length > 1) return '?'
  const list = b.chars.map(quote)
  return list.length === 1 ? list[0]! : `{${list.join(',')}}`
}

/** Text with each bracket expression in it read (see bracketList). */
export function bracketsRead(text: string): string {
  let out = ''
  for (let i = 0; i < text.length;) {
    const b = text[i] === '[' ? bracket(text, i) : null
    if (b) {
      out += bracketList(text.slice(i, b.end))
      i = b.end
    } else out += text[i++]
  }
  return out
}

/** What the shell can make of a word, as names and globs, by the reading
 *  table: quotes, escapes and ANSI-C quotes read exactly, brace and bracket
 *  lists expanded, `~` and `$HOME` the known home, a default written in the
 *  command one more spelling. A part the shell fills in when the command
 *  runs (`$x`, `$(...)`, `$PWD`, `~user`) is read as nothing beside other
 *  text and as any folder when it is a whole path part, so `"$a.$b"` is `.`
 *  and `$DIR/.env` is `.env` in any folder; a word made only of such parts
 *  has no spelling. Unquoted, such a part may also break the word in two,
 *  so the text between any two of them is a spelling of its own (A4). `**` stands for any text; a wildcard or brace character that
 *  was quoted is not one. */
export function spellings(
  w: Word,
  o: { home: string | null; homeKnown: boolean; strict: boolean; cost?: Cost }
): string[] | 'any' {
  const glued = textsOfWord(w, o)
  // A part that rewrites written text (Z5): the word could be any name.
  if (glued === 'any') return 'any'
  const texts = [...glued]
  // An unquoted part the shell fills in may break the word in two (A4:
  // `cat$IFS.env`), or be empty: the text between any two of them, with
  // those in between read as empty, is a word of its own too.
  const breaks = [-1]
  w.parts.forEach((p, k) => {
    if ((p.kind === 'param' || p.kind === 'subst') && !p.quoted) breaks.push(k)
  })
  breaks.push(w.parts.length)
  // Past 24 of them the word could be cut too many ways to read: any name.
  if (breaks.length > 26) return 'any'
  for (let a = 0; a < breaks.length; a++)
    for (let b = a + 1; b < breaks.length; b++) {
      const [from, to] = [breaks[a]! + 1, breaks[b]!]
      if (to <= from || (from === 0 && to === w.parts.length)) continue
      const t = textsOfWord({ ...w, parts: w.parts.slice(from, to) }, o, from === 0)
      if (t === 'any') return 'any'
      texts.push(...t)
    }
  const out = new Set<string>()
  for (const t of texts) {
    const read = runTime(o.strict ? strictRead(t) : t)
    if (read === null) continue
    const names = braceNames(read)
    spend(o.cost, names.length)
    for (const name of names) out.add(name)
  }
  return [...out]
}

/** A word's texts with its run-time parts still marked: a written value
 *  inside a parameter is read where it stands in the word, so a number or a
 *  run-time part in it is glued to the text around the parameter
 *  (`id_ed${x:-$((25519))}` is `id_ed*`). */
function textsOfWord(
  w: Word,
  o: { home: string | null; homeKnown: boolean; strict: boolean; cost?: Cost },
  start = true
): string[] | 'any' {
  const home = o.homeKnown && o.home !== null ? quote(o.home) : null
  let texts: string[] = ['']
  let any = false
  // The word holds a wildcard that no list of names expands.
  const wild = w.parts.some(
    (p) => p.kind === 'zglob' || (p.kind === 'glob' && bracketList(p.text) === p.text.slice(0, 1))
  )
  // Its bracket lists would expand to more spellings than are listed
  // (`[0-9][0-9].log` is 100): each stays "one of these characters".
  let listed = 1
  for (const p of w.parts)
    if (p.kind === 'glob' && p.text.startsWith('[') && listed <= MAX_SPELLINGS)
      listed *= bracket(p.text, 0, true)?.chars?.length ?? 1
  const many = listed > MAX_SPELLINGS
  const add = (alternatives: string[]) => {
    const next: string[] = []
    spend(o.cost, texts.length * alternatives.length)
    for (const t of texts) for (const a of alternatives) next.push(t + a)
    // Past the cap the word is read as "anything" in this place.
    texts = next.length > MAX_SPELLINGS ? texts.map((t) => `${t}**`) : next
  }
  w.parts.forEach((p, k) => {
    if (any) return
    const alternatives = partSpellings(p, home, o, start && k === 0, wild || many, many)
    if (alternatives === 'any') any = true
    else add(alternatives)
  })
  return any ? 'any' : texts
}

function partSpellings(
  p: Part,
  home: string | null,
  o: { home: string | null; homeKnown: boolean; strict: boolean; cost?: Cost },
  first: boolean,
  wild = false,
  many = false
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
      return [bracketList(p.text, wild, many)]
    case 'brace':
      return [o.strict ? ANY_TEXT : p.text]
    case 'zglob':
      // A qualifier that puts text into the name or runs code (A3).
      if (p.rewrites) return 'any'
      // A group of plain alternatives is a list of them, as a brace list
      // is; under strict reading an option may read it otherwise.
      if (p.alternatives && !o.strict) return [...p.alternatives]
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
        const s = textsOfWord(word, o)
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

/** Whether `set`'s arguments (the words from `from` on) name an option
 *  outside the plain ones. */
function setChanges(args: readonly (string | null)[], from: number): boolean {
  for (let k = from; k < args.length; k++) {
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

/** Variables whose value changes how bash reads words (reading table A10):
 *  `GLOBIGNORE` lets a wildcard match a leading dot. A command that holds
 *  one's name - in a word, an expansion, arithmetic, a loop's variable, an
 *  assignment, glued to an option's letter (`printf -vGLOBIGNORE`) - may set
 *  it: no list of the forms that do. */
const READING_VARIABLE =
  /(?:GLOBIGNORE|BASHOPTS|SHELLOPTS|POSIXLY_CORRECT|BASH_COMPAT)(?![A-Za-z0-9_])/

/** Words before a program that are not it (zsh's `-` among them). */
const PREFIXES = new Set(['builtin', 'command', 'noglob', 'exec', 'nocorrect', '-'])
/** A word the shell builds when the command runs. */
const built = (w: Word): boolean =>
  w.parts.some((p) => p.kind === 'param' || p.kind === 'subst' || p.kind === 'arith')

/** Whether a command changes how the shell reads words. */
export function readsStrictly(list: List): boolean {
  let strict = false
  const again = rereadLists(list)
  // In text only read again as a script (awk's `NR==1{print $0}`), a word
  // that looks built is no sign of a command that sets an option.
  let text = 0
  const visit = (x: unknown): void => {
    if (strict) return
    if (Array.isArray(x)) return x.forEach(visit)
    if (x === null || typeof x !== 'object') return
    if (again.has(x)) {
      text++
      for (const v of Object.values(x)) visit(v)
      text--
      return
    }
    // A setting's name: in a word as written (quotes and line continuations
    // removed) or by its value, or as the name of a loop or an assignment.
    if (
      isWord(x)
        ? READING_VARIABLE.test(x.raw.replace(/\\\n/g, '').replace(/['"\\]/g, '')) ||
          READING_VARIABLE.test(valueOf(x))
        : READING_VARIABLE.test(String((x as { name?: unknown }).name ?? ''))
    )
      strict = true
    if ((x as { type?: unknown }).type === 'simple') {
      const words = (x as Simple).words.map((w) => w.literal)
      // The words after a `shopt`, or after `eval`, `source` or `.`, are
      // looked through once: what the first of them finds nothing in holds
      // nothing for a later one either (a command of many words is read in
      // one pass, not once per word).
      let shoptSeen = false
      let builtSeen = false
      for (let k = 0; k < words.length && !strict; k++) {
        const w = words[k]
        if (w === 'setopt' || w === 'unsetopt' || w === 'emulate') strict = true
        else if (w === 'shopt' && !shoptSeen) {
          shoptSeen = true
          for (let j = k + 1; j < words.length && !strict; j++) {
            const a = words[j]!
            strict = a === null || (!a.startsWith('-') && !SHOPT_PLAIN.has(a))
          }
        } else if (w === 'set') strict = setChanges(words, k + 1)
        // Text the command builds, run as commands: it may be any of these.
        else if ((w === 'eval' || w === 'source' || w === '.') && !builtSeen) {
          builtSeen = true
          strict = words.includes(null, k + 1)
        }
      }
      const simple = x as Simple
      // zsh's `options` array sets an option as `setopt` does.
      if (
        simple.assigns.some((a) => a.name === 'options') ||
        simple.words.some((w) => /^options(?:\[[^\]]*\])?\+?=/.test(w.raw))
      )
        strict = true
      // A program word the command builds (`$S globdots`) may be any of
      // these. Behind a modifier and its options (`command -p`, `exec -a x`,
      // `-`) the program is not told from an option's value: any built word.
      let at = 0
      while (
        at < simple.words.length &&
        (PREFIXES.has(simple.words[at]!.literal ?? '') ||
          (at > 0 && (simple.words[at]!.literal ?? '').startsWith('-')))
      )
        at++
      if (
        text === 0 &&
        (at > 0 ? simple.words.slice(at).some(built) : simple.words.slice(0, 1).some(built))
      )
        strict = true
    }
    for (const v of Object.values(x)) visit(v)
  }
  visit(list)
  return strict
}

/** The lists that are text read again as a script (`Word.again`,
 *  `Redirect.again`): what a shell would run if the text reached one. */
export function rereadLists(tree: unknown): Set<object> {
  const out = new Set<object>()
  const visit = (x: unknown): void => {
    if (Array.isArray(x)) return x.forEach(visit)
    if (x === null || typeof x !== 'object') return
    for (const l of (x as { again?: List[] }).again ?? []) out.add(l)
    for (const v of Object.values(x)) visit(v)
  }
  visit(tree)
  return out
}

/** Whether a word's wildcards may match a leading dot: under strict reading
 *  (globdots, dotglob), and beside a zsh group or qualifier (`*(D)`) - also a
 *  group of one plain text, which is a qualifier where a piece of the word
 *  ends at it (`-v *env(D):/x`). */
export const dotsMatch = (w: Word, strict: boolean): boolean =>
  strict ||
  w.parts.some(
    (p) => p.kind === 'zglob' && (p.qualifier || p.star || p.alternatives?.includes('') === true)
  )

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

/** The text floor (reading table A8): a net under the reader for a way of
 *  running text that no row names. Each blank-separated chunk of the command
 *  that holds a quote or a backslash, as typed and as it reads with them and
 *  line continuations removed; and each piece of quoted text, here-document
 *  body and here-string - by its value, split at blanks and at the shell's
 *  operators - which the guard judges as a word, wildcards and all. */
export function textPieces(
  list: List | null,
  command: string,
  data: Data = NO_DATA
): [typed: string, read: string][] {
  const out: [string, string][] = []
  const seen = new Set<string>()
  const add = (typed: string, read: string) => {
    if (read === '' || seen.has(read)) return
    seen.add(read)
    out.push([typed, read])
  }
  const split = (typed: string | null, text: string) => {
    for (const piece of text.split(/[\s;|&<>()`$]+/)) add(typed ?? piece, piece)
  }
  for (const m of command.matchAll(/(?:\\\n|\S)+/g)) {
    const read = m[0].replace(/\\\n/g, '').replace(/['"\\]/g, '')
    if (read === m[0]) continue
    add(m[0], read)
    split(m[0], read)
  }
  const visit = (x: unknown): void => {
    if (Array.isArray(x)) return x.forEach(visit)
    if (x === null || typeof x !== 'object') return
    if (data.inside.has(x)) return
    if (isWord(x)) {
      // Text the shell does not read as its own words: quoted, or `$'...'`.
      if (
        !data.words.has(x) &&
        x.parts.some((p) => (p.kind === 'lit' && p.quoted) || p.kind === 'ansic')
      )
        split(x.raw, valueOf(x))
    } else if (typeof (x as Partial<Redirect>).body === 'string' && !data.bodies.has(x as Redirect))
      split(null, (x as Redirect).body!)
    for (const v of Object.values(x)) visit(v)
  }
  if (list) visit(list)
  return out
}

/** Text that names Veilio's folder as a path: `.veilio` after a `/`, `\` or
 *  `~`, or followed by `/` or `\` whatever stands before it (A11), or as a
 *  whole quoted string, also when the name is joined from pieces
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
        // After any character: `sed 'w.veilio/x'` writes there (A11).
        /\.veilio[/\\]/i.test(t)
    )
  )
}

/** The characters of a path, and of several given to one option. */
const PATH_TEXT = /^[\p{L}\p{N}_.~/\\@%:,=-]*$/u
/** Those, and what a wildcard, a brace list or a zsh group is written with. */
const GLOB_TEXT = /^[\p{L}\p{N}_.~/\\@%:,=*?[\]!^{}()|<>#-]*$/u

/** Whether a word's whole value is a path (or paths joined by `=`, `:`, `,`):
 *  what the raw-only rules judge. Each part is checked: a variable and a
 *  command's output stand for path text; a wildcard, a brace list or a group
 *  only when what is written in it is path text; any other part is not. */
function isPath(w: Word): boolean {
  return w.parts.every((p) => {
    switch (p.kind) {
      case 'lit':
        return PATH_TEXT.test(p.text)
      case 'ansic':
        return PATH_TEXT.test(
          p.text.startsWith("$'") ? ansiC(p.text.slice(2, -1)) : p.text.slice(2, -1)
        )
      case 'param':
        return p.operand === undefined
      case 'tilde':
      case 'subst':
        return true
      case 'glob':
      case 'brace':
      case 'zglob':
        return GLOB_TEXT.test(p.text)
      // Anything else is not known to be a path: read as text.
      default:
        return false
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
export function textsOf(list: List, data: Data = NO_DATA): string[] {
  const out: string[] = []
  const visit = (x: unknown): void => {
    if (Array.isArray(x)) return x.forEach(visit)
    if (x === null || typeof x !== 'object') return
    if (data.inside.has(x)) return
    if (isWord(x)) {
      // A path word is judged by the raw-only rules; one that holds
      // `.veilio/` after another character (`w.veilio/x`) is text too (A11).
      if (!data.words.has(x) && (!isPath(x) || /[^/~\\]\.veilio[/\\]/i.test(valueOf(x))))
        out.push(valueOf(x))
    } else {
      const r = x as Partial<Redirect>
      if (typeof r.body === 'string' && !data.bodies.has(x as Redirect)) out.push(r.body)
      if (r.op === '<<<' && r.target) out.push(valueOf(r.target))
    }
    for (const v of Object.values(x)) visit(v)
  }
  visit(list)
  return out
}

// ── data positions (reading table A12) ──

/** Text a program only prints, stores or searches for: `words` are not
 *  judged themselves (the commands of a substitution inside one still are),
 *  `bodies` are here-documents whose text is not judged, and nothing under
 *  `inside` is (a word's text or a body read again as a script). */
export type Data = { words: Set<Word>; bodies: Set<Redirect>; inside: Set<object> }
const NO_DATA: Data = { words: new Set(), bodies: new Set(), inside: new Set() }

const MESSAGE_COMMANDS = new Set(['commit', 'tag', 'merge', 'stash', 'notes'])
/** A search program's options (reading table A12 (3), §8.1). Only what is in
 *  a table is read; an option outside it ends the reading, so no word of that
 *  command is data and a gap here is a refusal, never a read.
 *   `plain`    letters without a value
 *   `valued`   letters with a value: the rest of the word, or the next word
 *   `unsure`   letters whose value is optional, or read differently by two
 *              versions of the program: only digits attached are its value;
 *              standing alone it ends the reading
 *   `long`     long options with a value: `--name VALUE` or `--name=VALUE`
 *   `optional` long options whose value comes only as `--name=VALUE`
 *   `twoWay`   long options two versions read differently when bare: only
 *              `--name=VALUE` is read
 *   `flags`    long options without a value */
type SearchOptions = {
  plain: string
  valued: string
  unsure: string
  long: readonly string[]
  optional: readonly string[]
  twoWay: readonly string[]
  flags: readonly string[]
}
const words = (text: string): readonly string[] => text.split(' ')
/** GNU grep 3 and BSD grep (macOS), `egrep` and `fgrep` with them. `-C` and
 *  `--context` take a number in GNU grep and an optional one in BSD grep. */
const GREP: SearchOptions = {
  plain: 'EFGHIJLMOPRSTUVXZabchilnopqrsuvwxyz',
  valued: 'ABDdefm',
  unsure: 'C',
  long: words(
    'regexp file max-count after-context before-context label binary-files devices directories include exclude exclude-dir exclude-from include-dir group-separator'
  ),
  optional: words('color colour'),
  twoWay: words('context'),
  flags: words(
    'extended-regexp fixed-strings basic-regexp perl-regexp ignore-case no-ignore-case invert-match word-regexp line-regexp count files-without-match files-with-matches only-matching quiet silent no-messages byte-offset with-filename no-filename line-number initial-tab null text recursive dereference-recursive line-buffered binary null-data no-group-separator mmap bz2decompress lzma xz decompress'
  ),
}
/** `git grep` (git 2.4x). `-O[pager]` takes its value attached only. */
const GIT_GREP: SearchOptions = {
  plain: 'EFGHILPWachilnopqrvwz',
  valued: 'ABCefm',
  unsure: 'O',
  long: words('max-depth max-count threads context after-context before-context'),
  optional: words('color open-files-in-pager'),
  twoWay: [],
  flags: words(
    'cached untracked no-index no-exclude-standard exclude-standard recurse-submodules no-recurse-submodules text textconv no-textconv ignore-case recursive no-recursive word-regexp invert-match full-name extended-regexp basic-regexp perl-regexp fixed-strings line-number column files-with-matches name-only files-without-match null only-matching count no-color break heading show-function function-context all-match quiet and or not'
  ),
}
/** ripgrep 14 (`rg --help`). `--files`, `--type-list` and `--generate` take
 *  no pattern and are left out: after them every word is judged. */
const RG: SearchOptions = {
  plain: 'FHILNPSUabchilnopqsuvwxz.0',
  valued: 'ABCEMTdefgjmrt',
  unsure: '',
  long: words(
    'regexp file pre pre-glob dfa-size-limit encoding engine max-count regex-size-limit threads glob iglob ignore-file max-depth max-filesize type type-not type-add type-clear after-context before-context color colors context context-separator field-context-separator field-match-separator hostname-bin hyperlink-format max-columns path-separator replace sort sortr'
  ),
  optional: [],
  twoWay: [],
  flags: words(
    'search-zip case-sensitive crlf fixed-strings ignore-case invert-match line-regexp mmap multiline multiline-dotall no-unicode null-data pcre2 smart-case stop-on-nonmatch text word-regexp auto-hybrid-regex no-pcre2-unicode binary follow glob-case-insensitive hidden ignore-file-case-insensitive no-ignore no-ignore-dot no-ignore-exclude no-ignore-files no-ignore-global no-ignore-parent no-ignore-vcs no-require-git one-file-system unrestricted block-buffered byte-offset column no-column heading no-heading include-zero line-buffered line-number no-line-number max-columns-preview null only-matching passthru pretty quiet trim vimgrep with-filename no-filename sort-files count count-matches files-with-matches files-without-match json debug no-ignore-messages no-messages stats trace no-config'
  ),
}
/** The Silver Searcher 2.2 (`ag`). Its `-A`, `-B`, `-C` and their long forms
 *  take the next word only when it is a number, so they are `unsure` and
 *  `optional`; `-g` and `--filename-pattern` search file names, with no
 *  pattern operand, and are left out. */
const AG: SearchOptions = {
  plain: 'DFHLQRSUacfhilnorstuvwz0',
  valued: 'GWmp',
  unsure: 'ABC',
  long: words(
    'ackmate-dir-filter color-line-number color-match color-path depth file-search-regex ignore ignore-dir max-count pager path-to-ignore width workers'
  ),
  optional: words('after before context'),
  twoWay: [],
  flags: words(
    'ackmate all-text all-types break nobreak case-sensitive color nocolor color-win-ansi column count debug filename nofilename files-with-matches files-without-matches fixed-strings follow nofollow group nogroup heading noheading hidden ignore-case invert-match line-numbers numbers nonumbers literal mmap nommap multiline nomultiline null one-device only-matching parallel passthrough passthru print-all-files print-long-lines recurse norecurse search-binary search-files search-zip silent skip-vcs-ignores smart-case stats stats-only unrestricted vimgrep word-regexp'
  ),
}
const SEARCH: Readonly<Record<string, SearchOptions>> = {
  grep: GREP,
  egrep: GREP,
  fgrep: GREP,
  rg: RG,
  ag: AG,
}

/** The pattern words of a search program's arguments: the value of each
 *  `-e` / `--regexp` - the next word, or the option's own word when the
 *  pattern is attached (`-ePAT`, `-iePAT`, `--regexp=PAT`) - or else the
 *  first operand. Empty when an option is not in the table, so a file after
 *  one (`grep --color KEY FILE`, `grep -f FILE`) is never taken for it. */
function patternWords(table: SearchOptions, args: readonly Word[]): Word[] {
  const given: Word[] = []
  // With `-f FILE` the patterns are in the file: every operand is a file.
  let fromFile = false
  for (let k = 0; k < args.length; k++) {
    // An option as written; a word the shell builds may be any option: not read.
    const w = written(args[k]!)
    if (w === null) return []
    if (w === '--') return given.length > 0 || fromFile ? given : args.slice(k + 1, k + 2)
    if (w.startsWith('--')) {
      const eq = w.indexOf('=')
      const name = eq === -1 ? w.slice(2) : w.slice(2, eq)
      if (name === 'file') fromFile = true
      if (eq !== -1) {
        if (![table.long, table.optional, table.twoWay].some((l) => l.includes(name))) return []
        if (name === 'regexp') given.push(args[k]!)
      } else if (table.long.includes(name)) {
        const next = args[++k]
        if (!next) return []
        if (name === 'regexp') given.push(next)
      } else if (!table.flags.includes(name) && !table.optional.includes(name)) return []
    } else if (w.startsWith('-') && w.length > 1) {
      for (let at = 1; at < w.length; at++) {
        const letter = w[at]!
        if (table.valued.includes(letter)) {
          if (letter === 'f') fromFile = true
          // Its value is the rest of the word, or the next word.
          if (at === w.length - 1) {
            const next = args[++k]
            if (!next) return []
            if (letter === 'e') given.push(next)
          } else if (letter === 'e') given.push(args[k]!)
          break
        }
        if (table.unsure.includes(letter)) {
          if (!/^\d+$/.test(w.slice(at + 1))) return []
          break
        }
        if (!table.plain.includes(letter) && !/[0-9]/.test(letter)) return []
      }
    } else return given.length > 0 || fromFile ? given : [args[k]!]
  }
  return given
}

/** `git`'s and `gh`'s options before the subcommand: those that take the
 *  next word (or `--name=VALUE`), and those that take none. */
const GIT_VALUED = new Set(
  words('-C -c --git-dir --work-tree --namespace --config-env --attr-source --super-prefix')
)
const GIT_FLAGS = new Set(
  words(
    '-p -P --paginate --no-pager --bare --no-replace-objects --literal-pathspecs --glob-pathspecs --noglob-pathspecs --icase-pathspecs --no-optional-locks --no-lazy-fetch --no-advice'
  )
)
const GH_VALUED = new Set(['-R', '--repo'])
const NO_FLAGS = new Set<string>()

/** Where a program's subcommand stands among its arguments, past its global
 *  options; -1 when an option before it is not known, or a word is built at
 *  run time: then nothing of the command is data. */
function subcommandAt(
  args: readonly Word[],
  valued: ReadonlySet<string>,
  flags: ReadonlySet<string>
): number {
  for (let k = 0; k < args.length; k++) {
    const w = args[k]!.literal
    if (w === null) return -1
    if (!w.startsWith('-')) return k
    if (valued.has(w)) k++
    else if (
      !flags.has(w) &&
      !(w.startsWith('--') && w.includes('=') && valued.has(w.slice(0, w.indexOf('=')))) &&
      !w.startsWith('--exec-path=')
    )
      return -1
  }
  return -1
}

/** A word's text when all of it is written in the command (a wildcard as
 *  itself); null when the shell builds any of it. */
function written(w: Word): string | null {
  let out = ''
  for (const p of w.parts) {
    if (p.kind !== 'lit' && p.kind !== 'glob' && p.kind !== 'brace') return null
    out += p.text
  }
  return out
}

/** The values of options among a command's arguments: `-m TEXT`, a cluster
 *  ending in the letter (`-am TEXT`), `--message TEXT`, `--message=TEXT`. */
function optionValues(args: readonly Word[], short: string, long: readonly string[]): Word[] {
  const out: Word[] = []
  args.forEach((w, k) => {
    const text = w.literal ?? ''
    const next = args[k + 1]
    // `--message=TEXT`, and the value attached to its letter (`-S'TEXT'`).
    if (
      long.some((l) => text.startsWith(`--${l}=`)) ||
      (/^-[A-Za-z]./.test(text) && short.includes(text[1]!))
    )
      out.push(w)
    else if (
      next &&
      (long.some((l) => text === `--${l}`) ||
        (/^-[A-Za-z]+$/.test(text) && short.includes(text[text.length - 1]!)))
    )
      out.push(next)
  })
  return out
}

/** The data positions of a command (reading table A12), an allow-list: (1)
 *  the arguments of `echo` and `printf` (not `printf -v`, `-vNAME`); (2) the message of
 *  `git commit`, `tag`, `merge`, `stash`, `notes`, the title and body given
 *  to `gh` and the notes given to `gh release` - `git` and `gh` read past
 *  their global options (`git -C dir commit -m`); (3) the pattern of `grep`,
 *  `egrep`, `fgrep`, `rg`, `ag`, `git grep`, and of `git log --grep`, `-S`,
 *  `-G`; (4) the body of a here-document given to `cat` or `tee`. (1) and (4)
 *  only while the output goes to the terminal or a file: as a stage of a
 *  pipeline with a later stage, inside a substitution, or sent into a
 *  `>(...)` substitution (by the command, by a compound command around it or
 *  by an earlier `exec`), they are judged as before. A position missing here
 *  is judged, so a gap is a refusal, never a read. */
export function dataPositions(list: List): Data {
  const data: Data = { words: new Set(), bodies: new Set(), inside: new Set() }
  const word = (w: Word) => {
    data.words.add(w)
    for (const l of w.again ?? []) data.inside.add(l)
  }
  /** Lists whose output goes into a data position (`-m "$(cat <<'E' ...)"`). */
  const intoData = new Set<object>()
  /** Whether words or redirections hold a `>(...)`: what is written there
   *  is read by the commands inside it. */
  const sink = (ws: readonly (Word | null)[]): boolean =>
    ws.some((w) => w?.parts.some((p) => p.kind === 'subst' && p.into))
  /** `fed`: the command's output is read by another command. */
  const visit = (x: unknown, fed: boolean): void => {
    if (Array.isArray(x)) return x.forEach((e) => visit(e, fed))
    if (x === null || typeof x !== 'object') return
    // Output redirected into `>(...)` - on a command or on a group, a loop,
    // an `if` around it - is read by a program.
    const redirects = (x as { redirects?: Redirect[] }).redirects
    if (Array.isArray(redirects) && !fed)
      fed = sink([...redirects.map((r) => r.target), ...((x as Simple).words ?? [])])
    // The commands of a substitution: their output is the word, so they
    // are fed - unless the word is itself only printed, stored or searched for.
    if ((x as Part).kind === 'subst') {
      const l = (x as { list: List | null }).list
      return visit(l, l === null || !intoData.has(l))
    }
    if (Array.isArray((x as Pipeline).stages)) {
      const stages = (x as Pipeline).stages
      stages.forEach((stage, k) => visit(stage, fed || k < stages.length - 1))
      return
    }
    if ((x as Simple).type === 'simple') {
      simple(x as Simple, fed)
      for (const w of (x as Simple).words)
        if (data.words.has(w))
          for (const p of w.parts) if (p.kind === 'subst' && p.list) intoData.add(p.list)
    }
    for (const v of Object.values(x)) visit(v, fed)
  }
  const simple = (n: Simple, fed: boolean): void => {
    const program = n.words[0]?.literal
    const args = n.words.slice(1)
    if (
      program === 'echo' ||
      (program === 'printf' && !args.some((w) => (w.literal ?? '').startsWith('-v')))
    ) {
      if (!fed) args.forEach(word)
    } else if (program === 'git') {
      const at = subcommandAt(args, GIT_VALUED, GIT_FLAGS)
      const sub = at === -1 ? '' : args[at]!.literal!
      const rest = args.slice(at + 1)
      if (MESSAGE_COMMANDS.has(sub)) optionValues(rest, 'm', ['message']).forEach(word)
      else if (sub === 'log') optionValues(rest, 'SG', ['grep']).forEach(word)
      else if (sub === 'grep') patternWords(GIT_GREP, rest).forEach(word)
    } else if (program === 'gh') {
      const at = subcommandAt(args, GH_VALUED, NO_FLAGS)
      if (at === -1) return
      // `gh release`: the notes too. A file (`--notes-file`, `--body-file`,
      // `-F`) is not text the command gives: judged.
      const release = args[at]!.literal === 'release'
      optionValues(
        args.slice(at + 1),
        release ? 'tbn' : 'tb',
        release ? ['title', 'body', 'notes'] : ['title', 'body']
      ).forEach(word)
    } else if (typeof program === 'string' && SEARCH[program])
      patternWords(SEARCH[program], args).forEach(word)
    else if ((program === 'cat' || program === 'tee') && !fed)
      for (const r of n.redirects)
        if (r.op === '<<' || r.op === '<<-') {
          data.bodies.add(r)
          // Under a quoted delimiter the shell runs nothing in the body.
          if (quotedDelimiter(r)) for (const l of r.substs ?? []) data.inside.add(l)
          for (const l of r.again ?? []) data.inside.add(l)
        }
  }
  // After `exec > >(...)` every command's output is read by a program.
  let execSink = false
  for (const { word: w, within } of wordsWithin(list)) {
    const n = within[within.length - 1] as Partial<Simple> | undefined
    // `exec` anywhere in the command: `command exec > >(sh)`.
    if (w.literal === 'exec' && n?.type === 'simple')
      execSink ||= sink((n.redirects ?? []).map((r) => r.target))
  }
  visit(list, execSink)
  return data
}

/** The command's text with its data positions blanked, for the checks that
 *  read the text itself. Only words of the command itself have a place; data
 *  inside a nested script stays, and is judged. */
export function withoutData(command: string, data: Data): string {
  const cut: [number, number][] = []
  for (const x of [...data.words, ...data.bodies]) {
    const at = placeOf(x)
    if (at) cut.push(at)
  }
  if (cut.length === 0) return command
  const chars = [...command]
  // Blanks keep every other word where it was; a newline stays a newline.
  for (const [from, to] of cut)
    for (let i = from; i < to && i < command.length; i++) if (command[i] !== '\n') chars[i] = ' '
  return chars.join('')
}
