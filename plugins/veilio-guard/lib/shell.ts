// How a shell command is read before a placeholder is put back into it
// (spec 078 research R1).
//
// Ported from spec 069's placeholder-named links (CE feat/069-guard-core
// 346d167, packages/guard/src/placeholder-links.ts), where it passed four
// security reviews: one parser for both, so the Copilot adapter imports this
// file when 069 rebases (spec 078 research R9). Changed since the port only by
// the security review of 232d48f: programs matched as whole words, long
// options matched with their abbreviations.

// The commands that may name a file by its placeholder (code review): test
// runners and read-only commands, as the start of every command in a chain.
// Matched word by word, never as a prefix of the command line: `cat.sh`,
// `ls-foo` and `cat=x curl` are not `cat` or `ls` (security review of
// 232d48f; spec 069's regex list had the same hole).
const READERS = new Set(['cat', 'head', 'tail', 'wc', 'ls', 'grep', 'rg', 'find'])

// Review round 2 #1: each test runner with the only options it may be given
// (true: the option takes a value, as the next word or after `=`; a list: the
// value must be one of it; 'path': a path inside the project). Any other
// option makes the command not a test run: an allow-list, since a runner's
// options that load code or run a program keep growing. Positional words
// (paths, filters, vitest's `run`) are free.
type Allowed = Readonly<Record<string, boolean | 'path' | readonly string[]>>

/** Whether a -f or --root value is a relative path inside the project: not
 *  empty (the current directory under another config), plain characters only
 *  (vitest and Maven strip quotes the shell left in, so `'"/tmp/x"'` is
 *  `/tmp/x` to them: review round 4b), and no `..` (review round 4). */
function inProject(value: string): boolean {
  return /^[\w.@+-]+(\/[\w.@+-]+)*\/?$/.test(value) && !value.split('/').includes('..')
}

const PYTEST = { '-k': true, '-x': false, '-q': false, '-v': false }
const SCRIPT = { '--': false }
// Review round 4: --root is the full-path form a refused cd asks for. A
// reporter is a name built in to every vitest from 1 to 4 only: any other
// name is imported as a module, and blob and html write files.
const VITEST: Allowed = {
  '-t': true,
  '--testNamePattern': true,
  '--run': false,
  '--root': 'path',
  '--reporter': ['default', 'verbose', 'dot', 'json', 'junit', 'tap', 'tap-flat'],
}
// Review round 4c: each positional word of a vitest run is `run` or a test
// path (a / or a ., inside the project): an allow-list, so init, bench and
// any later command are refused, and so is a bare filter word (use -t).
const vitestWord = (w: string) => w === 'run' || (/[/.]/.test(w) && inProject(w))
const RUNNERS: readonly [readonly string[], Allowed, ((w: string) => boolean)?][] = [
  [['npx', 'vitest'], VITEST, vitestWord],
  [['vitest'], VITEST, vitestWord],
  [['node_modules/.bin/vitest'], VITEST, vitestWord],
  [['./node_modules/.bin/vitest'], VITEST, vitestWord],
  [['npm', 'test'], SCRIPT],
  [['npm', 'run', 'test'], SCRIPT],
  [['pnpm', 'test'], SCRIPT],
  [['pnpm', 'run', 'test'], SCRIPT],
  [['yarn', 'test'], SCRIPT],
  [['yarn', 'run', 'test'], SCRIPT],
  [['pytest'], PYTEST],
  [['python', '-m', 'pytest'], PYTEST],
  [['python3', '-m', 'pytest'], PYTEST],
  [['python', '-m', 'unittest'], { '-v': false }],
  [['python3', '-m', 'unittest'], { '-v': false }],
  [['go', 'test'], { '-run': true, '-v': false, '-count': true }],
  [['cargo', 'test'], { '--': false }],
  [['ruby', '-Itest'], {}],
  [['rake', 'test'], {}],
  [['node', '--test'], {}],
]

// Review round 4: Maven takes its options before the goal, and every other
// word is a goal or a plugin to run, so its words are never free: the `test`
// goal once, and only these options. `-D` only with `=`, since `-Dtest Foo`
// is the property `test` and the goal `Foo`.
const MVN_FLAGS = new Set(['-q', '-o', '-B'])
const MVN_PROPS = /^-D(test=[^\s"'$`]+|failIfNoTests=false|surefire\.failIfNoSpecifiedTests=false)$/

/** Whether Maven's words after `mvn` run the test goal and nothing else. */
function mavenTest(rest: readonly string[]): boolean {
  let goals = 0
  for (let i = 0; i < rest.length; i++) {
    const w = rest[i]!
    if (w === 'test') goals++
    else if (w === '-f') {
      const value = rest[++i]
      if (value === undefined || value.startsWith('-') || !inProject(value)) return false
    } else if (!MVN_FLAGS.has(w) && !MVN_PROPS.test(w)) return false
  }
  return goals === 1
}

/** Whether every option in `rest` is on `allowed`, and every positional word
 *  passes the runner's `positional` check when it has one. */
function onlyAllowed(
  rest: readonly string[],
  allowed: Allowed,
  positional?: (w: string) => boolean
): boolean {
  for (let i = 0; i < rest.length; i++) {
    const w = rest[i]!
    if (!w.startsWith('-')) {
      if (positional && !positional(w)) return false
      continue
    }
    const eq = w.indexOf('=')
    const name = eq === -1 ? w : w.slice(0, eq)
    if (!Object.hasOwn(allowed, name)) return false
    const takes = allowed[name]!
    if (takes === false) {
      if (eq !== -1) return false
      continue
    }
    // A value given as the next word is never an option itself (security
    // review of round 2: `-t --config x` would pass `--config` as -t's value).
    const value = eq === -1 ? rest[++i] : w.slice(eq + 1)
    if (value === undefined || (eq === -1 && value.startsWith('-'))) return false
    if (takes === 'path' ? !inProject(value) : takes !== true && !takes.includes(value))
      return false
  }
  return true
}

/** Whether a command's words are a reader, or a test runner given only the
 *  options on its allow-list. */
function readsOrTests(words: readonly string[]): boolean {
  if (READERS.has(words[0] ?? '')) return true
  if (words[0] === 'mvn') return mavenTest(words.slice(1))
  for (const [start, allowed, positional] of RUNNERS)
    if (start.every((w, i) => words[i] === w))
      return onlyAllowed(words.slice(start.length), allowed, positional)
  return false
}

/** Whether `word` is the long option `--name`, or an abbreviation of it that
 *  GNU getopt accepts (`--only-match`, `--byt=5`), with or without a value
 *  (security review of 232d48f). */
function longOption(word: string, ...names: string[]): boolean {
  if (!word.startsWith('--') || word.length < 3) return false
  const given = word.slice(2).split('=')[0]!
  return given.length > 0 && names.some((n) => n.startsWith(given))
}

// Flags of those commands that write a file or run a program (security
// review), and shell syntax the chain split below does not see: a newline,
// a lone &, a subshell, process substitution, a heredoc.
const UNSAFE_FLAGS =
  /\s-(fprint\w*|fls)\b|\s(--pre|--pre-glob|--search-zip|-z)\b|\s--(output|ext-diff|textconv)\b|^git\s+-c\b|\s-c\s/
const CONTROL = /\n|\r|(^|[^&])&([^&]|$)|[(){}]|<</
// Anything that could write, run code or rewrite the command line.
const WRITES_OR_RUNS =
  /[>`]|\$\(|\btee\b|(^|\s)(-i|--in-place)\b|\b(sed|awk|perl)\b|\bpython3?\s+-c\b|\bnode\s+-e\b|\s-(exec|execdir|delete|ok|okdir)\b/

/** A command's words as the shell passes them: quotes and backslashes
 *  removed, so a quoted flag is judged as the program will see it (security
 *  review). */
export function shellWords(command: string): string[] | null {
  const words: string[] = []
  let word = ''
  let started = false
  let quote: string | null = null
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!
    if (quote) {
      if (c === quote) quote = null
      else if (c === '\\' && quote === '"' && i + 1 < command.length) word += command[++i]
      else word += c
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      started = true
    } else if (c === '\\' && i + 1 < command.length) {
      word += command[++i]
      started = true
    } else if (/\s/.test(c)) {
      if (started) words.push(word)
      word = ''
      started = false
    } else {
      word += c
      started = true
    }
  }
  if (quote) return null // unbalanced: not a command to judge
  if (started) words.push(word)
  return words
}

/** Whether the shell would expand anything in the command: a glob character
 *  outside quotes, or a $ (a variable, ${...}, $'...') or a backtick outside
 *  single quotes. The word split above does not model these, so a flag or a
 *  raw-only path could appear only after expansion (security reviews). */
export function shellExpands(command: string): boolean {
  let quote: string | null = null
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!
    if (quote === "'") {
      if (c === "'") quote = null
      continue
    }
    if (c === '$' || c === '`') return true
    if (quote === '"') {
      if (c === '"') quote = null
      else if (c === '\\') i++
      continue
    }
    if (c === "'" || c === '"') quote = c
    else if (c === '\\') i++
    else if (c === '*' || c === '?' || c === '[') return true
  }
  return false
}

/** The commands of a chain (&&, ||, ;, |), split outside quotes only, so
 *  `grep "a|b" f` is one command; null when a quote does not close. */
export function splitChain(command: string): string[] | null {
  const parts: string[] = []
  let part = ''
  let quote: string | null = null
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!
    if (quote) {
      if (c === quote) quote = null
      else if (c === '\\' && quote === '"') {
        part += c + (command[++i] ?? '')
        continue
      }
      part += c
      continue
    }
    if (c === "'" || c === '"') quote = c
    else if (c === '\\') {
      part += c + (command[++i] ?? '')
      continue
    } else if ((c === '&' || c === '|') && command[i + 1] === c) {
      parts.push(part)
      part = ''
      i++
      continue
    } else if (c === ';' || c === '|') {
      parts.push(part)
      part = ''
      continue
    }
    part += c
  }
  if (quote) return null
  parts.push(part)
  return parts
}

/** A flag of an allowed command that writes a file or runs a program. */
function unsafeWord(program: string, word: string): boolean {
  if (program === 'find') return /^-(fprint\w*|fls|exec|execdir|ok|okdir|delete)$/.test(word)
  if (program === 'rg')
    return (
      longOption(word, 'pre', 'pre-glob', 'search-zip', 'hostname-bin', 'hyperlink-format') ||
      /^-[A-Za-z]*z/.test(word)
    )
  return false
}

/** Why a shell command naming a file by its placeholder may not run, or null
 *  when it only reads or tests. `2>&1` is not a write. */
export function shellRefusal(command: string): string | null {
  // `2>&1` only as itself: `>&1out` writes a file.
  const c = command.replace(/\d?>&\d(?=\s|$)/g, ' ')
  if (shellExpands(c))
    return 'a command that names a file by its placeholder may only read or test it: no variables, globs or other expansions'
  if (CONTROL.test(c))
    return 'a command that names a file by its placeholder may only read or test it: no subshell, background job, heredoc or second line'
  const chain = splitChain(c)
  if (chain === null)
    return 'a command that names a file by its placeholder may only read or test it: its quotes do not close'
  if (WRITES_OR_RUNS.test(c) || chain.some((x) => UNSAFE_FLAGS.test(x.trim())))
    return 'a command that names a file by its placeholder may only read or test it: no redirection, in-place edit or inline code'
  for (const part of chain) {
    const words = shellWords(part)
    if (words === null)
      return 'a command that names a file by its placeholder may only read or test it: its quotes do not close'
    const program = words[0] ?? ''
    if (words.slice(1).some((w) => unsafeWord(program, w)))
      return `a command that names a file by its placeholder may only read or test it, and ${program} is given an option that writes or runs`
    // node --test takes paths only: its options load or run code.
    if (
      program === 'node' &&
      (words[1] !== '--test' || words.slice(2).some((w) => w.startsWith('-')))
    )
      return 'a command that names a file by its placeholder may only read or test it: node --test takes paths only'
    if (words.length > 0 && !readsOrTests(words))
      return `a command that names a file by its placeholder may only read or test it, and ${words[0]} is not one of those`
  }
  return null
}

// ── spec 078: placeholders put back into Claude Code's shell commands ────────

// Programs that reach another machine. None of them is a reader or a test
// runner, so each is refused anyway; they get their own reason (R1, FR-003).
const NETWORK = new Set([
  'curl',
  'wget',
  'nc',
  'ncat',
  'netcat',
  'socat',
  'ssh',
  'scp',
  'sftp',
  'rsync',
  'ftp',
  'telnet',
  'http',
  'https',
])
const ASSIGNS = /^[A-Za-z_][A-Za-z0-9_]*=/
const WRAPPERS = new Set([
  'env',
  'command',
  'exec',
  'builtin',
  'nohup',
  'nice',
  'time',
  'sudo',
  'xargs',
])
const GIT_NETWORK = new Set(['push', 'fetch', 'clone', 'pull', 'ls-remote', 'remote', 'submodule'])

/** The letters of a group of short flags (`-nwo`) up to the first one that
 *  takes a value, which swallows the rest (`-tpy` is `-t py`). */
function grouped(word: string, valued: string): string {
  if (!/^-[A-Za-z]/.test(word)) return ''
  let out = ''
  for (const c of word.slice(1)) {
    out += c
    if (valued.includes(c) || !/[A-Za-z]/.test(c)) break
  }
  return out
}

/** Spec 078 R1: flags of a reader that slice or reshape what it prints, on
 *  top of 069's flags that write or run. */
function reshapes(program: string, word: string): boolean {
  // Colour wraps each match in escape codes, which can split a name apart.
  const colour = longOption(word, 'color', 'colour', 'colors') && !/=never$/.test(word)
  if (program === 'grep')
    return colour || longOption(word, 'only-matching') || /^-[A-Za-z]*o/.test(word)
  if (program === 'rg')
    return (
      colour ||
      longOption(word, 'replace', 'only-matching', 'pretty') ||
      /[rop]/.test(grouped(word, 'ABCeEfgjmMrtT'))
    )
  // `-4c` and `+3c` are the obsolete forms of a byte count; `b` counts blocks.
  if (program === 'head' || program === 'tail')
    return (
      longOption(word, 'bytes') || /^-[A-Za-z]*c/.test(word) || /^[+-]\d+[A-Za-z]*[bc]/.test(word)
    )
  if (program === 'find') return /^-f?printf$/.test(word)
  return false
}

const READS =
  'a shell command gets real names back only when it reads files or runs tests (cat, head, tail, grep, rg, ls, find, wc, a test runner)'
const SYNTAX = (what: string) =>
  `a command that gets real names back may only read files or run tests, so it cannot use ${what}. Split it into plain commands, or use the Edit or Write tool`

/** Why a placeholder may not be put back into this command (the reason a
 *  refusal states, spec 078 strings.md #1-#7), or null when it only reads
 *  files or runs tests. `tool` is Claude Code's shell tool. */
export function restoreRefusal(command: string, tool: 'Bash' | 'PowerShell'): string | null {
  if (tool === 'PowerShell')
    return 'PowerShell commands get no real names back yet. Use the Read, Edit, Write or Grep tool'
  const c = command.replace(/\d?>&\d(?=\s|$)/g, ' ')
  const chain = splitChain(c)
  const parts = chain?.map((p) => shellWords(p)) ?? null
  if (chain === null || parts === null || parts.some((w) => w === null))
    return SYNTAX('quotes that do not close')
  const words = parts as string[][]
  // What a command does decides its reason first: a network program, a
  // commit or a cd, wherever it stands in the chain.
  for (const all of words) {
    // Past leading assignments and wrappers (`FOO=1 curl`, `env curl`): the
    // allow-list below refuses these anyway; this only names the reason.
    let k = 0
    while (k < all.length && (ASSIGNS.test(all[k]!) || WRAPPERS.has(all[k]!))) k++
    const w = all.slice(k)
    const program = w[0] ?? ''
    if (NETWORK.has(program) || (program === 'git' && GIT_NETWORK.has(w[1] ?? '')))
      return 'real names are never put into a command that can send them off this machine. Ask the user to run it'
  }
  for (const w of words)
    if (w[0] === 'git' && w[1] === 'commit')
      return 'a shell command gets real names back only when it reads files or runs tests. To commit with this message, write it to a file with the Write tool, then run `git commit -F <file>`'
  for (const w of words)
    if (w[0] === 'cd' || w[0] === 'pushd')
      return 'a cd gets no real names back. Name the file by its full path instead, for example `npx vitest run __DIR__1/x.test.ts`'
  // Shell syntax, read outside quotes: `grep 'a & b'` is one plain command.
  const bare = outsideQuotes(c)
  if (CONTROL.test(bare))
    return SYNTAX('a subshell, a background job, a here-document or a second line')
  if (shellExpands(c)) return SYNTAX('a variable, a glob or another expansion')
  if (/[>`]|\btee\b/.test(bare)) return SYNTAX('a redirection or tee')
  for (const w of words) {
    if (w.length > 0 && !readsOrTests(w))
      return `${READS}, and \`${w[0]}\` is not one of those. Use the Edit, Write or Grep tool instead, or name the file by its full path`
  }
  for (const w of words) {
    const program = w[0] ?? ''
    const flag = w.slice(1).find((x) => reshapes(program, x) || unsafeWord(program, x))
    if (flag !== undefined)
      return `\`${program}\` \`${flag}\` can reshape or write what it reads, so it gets no real names back. Run it without the placeholder, or without \`${flag}\``
  }
  if (WRITES_OR_RUNS.test(c)) return SYNTAX('an in-place edit or inline code')
  // 069's own check, unchanged, has the last word: never weaker than Copilot's.
  return shellRefusal(command) === null ? null : SYNTAX('that form')
}

/** The command with every quoted span blanked, so an operator inside quotes
 *  is not read as one (an unclosed quote was refused before this). */
export function outsideQuotes(command: string): string {
  let out = ''
  let quote: string | null = null
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!
    if (quote) {
      if (ch === quote) quote = null
      else if (ch === '\\' && quote === '"') i++
      out += ' '
    } else if (ch === "'" || ch === '"') {
      quote = ch
      out += ' '
    } else if (ch === '\\') {
      i++
      out += '  '
    } else out += ch
  }
  return out
}

// ── spec 086: one reader of a shell command (research R1, R3) ───────────────
//
// parseShell reads a command as bash and zsh do, into the tree of the spec's
// data-model.md, for the cd rules (lib/paths.ts cdEffect, lib/guard.ts
// DirState). The views above (shellWords, splitChain) keep their own bodies:
// they return text the tree drops (comments, here-document bodies, a
// redirection's spelling), so a view equal to them on every input would be
// them again (research R1's fallback).

/** A piece of a word. `lit` is text the program receives as written;
 *  everything else the shell may expand. */
export type Part =
  | { kind: 'lit'; text: string; quoted: boolean }
  | { kind: 'param'; name: string; op: string }
  | { kind: 'subst'; list: List | null }
  | { kind: 'arith'; text: string }
  | { kind: 'glob'; text: string }
  | { kind: 'brace'; text: string }
  | { kind: 'tilde'; user: string }
  | { kind: 'ansic'; text: string }
/** `literal`: the text after quote removal when no part expands, else null.
 *  `assign`: the word read as an assignment by a declaration builtin. */
export type Word = { parts: Part[]; literal: string | null; raw: string; assign?: Assign }
/** `name` null: a name the shell builds (`declare "${x}"=v`). */
export type Assign = { name: string | null; op: '=' | '+='; value: Word | Word[] }
export type Redirect = { fd: number | null; op: string; target: Word | null; body?: string }
export type Simple = {
  type: 'simple'
  assigns: Assign[]
  words: Word[]
  redirects: Redirect[]
  nested?: List
}
export type Node =
  | Simple
  | { type: 'subshell'; list: List; redirects: Redirect[] }
  | { type: 'group'; list: List; redirects: Redirect[] }
  | {
      type: 'if'
      branches: { cond: List; body: List }[]
      else: List | null
      redirects: Redirect[]
    }
  | {
      type: 'loop'
      kind: 'for' | 'select' | 'while' | 'until'
      name: string | null
      words: Word[] | null
      cond: List | null
      body: List
      redirects: Redirect[]
    }
  | { type: 'case'; word: Word; arms: List[]; redirects: Redirect[] }
  | { type: 'function'; name: string; body: Node }
/** `background`: followed by `&`, so it runs in a subshell of its own. */
export type Pipeline = { stages: Node[]; negated: boolean; timed: boolean; background?: true }
export type Joint = '&&' | '||' | ';' | '&' | '\n'
/** `joinedBy`: the operator between an item and the one before it. */
export type List = { items: { node: Pipeline; joinedBy: Joint | null }[] }
export type ParseResult =
  { ok: true; list: List } | { ok: false; why: 'unbalanced' | 'depth' | 'unknown' }

class Unreadable extends Error {
  constructor(readonly why: 'unbalanced' | 'depth' | 'unknown') {
    super(why)
  }
}

/** Nested shells read (`bash -c`, `eval`, a here-document to a shell). */
const MAX_DEPTH = 3
/** Lists open at once: a bound on `$(` and `(` nesting, so a crafted command
 *  cannot exhaust the stack. */
const MAX_FRAMES = 200
const BLANK = /[ \t\r]/
// Where a run of plain word characters ends.
const SPECIAL = /[ \t\r\n;&|()<>'"`\\$*?[{]/
const KEYWORD =
  /^(?:if|then|elif|else|fi|for|while|until|do|done|case|esac|function|select|time|!|\{|\}|\[\[)(?=[ \t\r\n;&|()<>]|$)/
const SHELL_PROGRAM = /^(?:.*\/)?(?:bash|sh|zsh|dash|ksh)$/
const SHELL_WRAPPERS = new Set([
  'env',
  'command',
  'exec',
  'builtin',
  'nohup',
  'nice',
  'sudo',
  'xargs',
  'time',
])
const DECLARES = new Set(['export', 'declare', 'typeset', 'local', 'readonly', 'integer'])
const NAME = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?$/
const REDIRECT = /^(\d+)?(<<<|<<-|<<|<>|<&|>&|>>|>\||&>>|&>|<|>)/

function makeWord(parts: Part[], raw: string): Word {
  const literal = parts.every((p) => p.kind === 'lit')
    ? parts.map((p) => (p as { text: string }).text).join('')
    : null
  return { parts, literal, raw }
}

/** An assignment's value: `~` at its start and after each unquoted `:` is a
 *  tilde (bash and zsh expand both). */
function tildes(w: Word): Word {
  const parts: Part[] = []
  w.parts.forEach((p, k) => {
    if (p.kind !== 'lit' || p.quoted) return parts.push(p)
    const pieces = p.text.split(/(?<=:)/)
    pieces.forEach((piece, j) => {
      const start = j > 0 || k === 0
      const m = start ? /^~([A-Za-z0-9_.+-]*)/.exec(piece) : null
      if (!m) return parts.push({ kind: 'lit', text: piece, quoted: false })
      parts.push({ kind: 'tilde', user: m[1]! })
      if (piece.length > m[0].length)
        parts.push({ kind: 'lit', text: piece.slice(m[0].length), quoted: false })
    })
  })
  return makeWord(parts, w.raw)
}

/** A declaration builtin's argument read as an assignment, by its text after
 *  quote removal (`export H""OME=x` sets HOME), or a built name. */
function declared(w: Word): Assign | undefined {
  let name = ''
  for (let k = 0; k < w.parts.length; k++) {
    const p = w.parts[k]!
    if (p.kind !== 'lit') {
      // A name the shell builds before its `=`.
      const rest = w.parts.slice(k + 1)
      return rest.some((q) => q.kind === 'lit' && q.text.includes('='))
        ? { name: null, op: '=', value: makeWord([], '') }
        : undefined
    }
    const eq = p.text.indexOf('=')
    if (eq === -1) {
      name += p.text
      continue
    }
    const plus = p.text[eq - 1] === '+'
    name += p.text.slice(0, plus ? eq - 1 : eq)
    if (!NAME.test(name)) return undefined
    const after = p.text.slice(eq + 1)
    const value = [...(after ? [{ ...p, text: after }] : []), ...w.parts.slice(k + 1)] as Part[]
    return {
      name: name.replace(/\[.*$/, ''),
      op: plus ? '+=' : '=',
      value: tildes(makeWord(value, w.raw)),
    }
  }
  return undefined
}

class Reader {
  private i = 0
  private pending: { r: Redirect; delim: string; strip: boolean; quoted: boolean }[] = []
  constructor(
    private readonly s: string,
    private readonly depth: number,
    private readonly frames: { n: number }
  ) {}

  all(): List {
    const l = this.list(new Set())
    if (this.i < this.s.length)
      throw new Unreadable(this.s[this.i] === ')' ? 'unbalanced' : 'unknown')
    return l
  }

  // ── blanks, newlines, keywords ──

  private blank(): void {
    const s = this.s
    for (;;) {
      if (BLANK.test(s[this.i] ?? '')) this.i++
      else if (s[this.i] === '\\' && s[this.i + 1] === '\n') this.i += 2
      else if (s[this.i] === '#') while (this.i < s.length && s[this.i] !== '\n') this.i++
      else return
    }
  }

  /** Blanks and newlines, reading any here-document bodies due. */
  private space(): void {
    for (;;) {
      this.blank()
      if (this.s[this.i] !== '\n') return
      this.newline()
    }
  }

  private newline(): void {
    this.i++
    const s = this.s
    for (const h of this.pending.splice(0)) {
      let body = ''
      for (;;) {
        if (this.i >= s.length) break
        const end = s.indexOf('\n', this.i)
        const line = s.slice(this.i, end === -1 ? s.length : end)
        this.i = end === -1 ? s.length : end + 1
        if ((h.strip ? line.replace(/^\t+/, '') : line) === h.delim) break
        body += (h.strip ? line.replace(/^\t+/, '') : line) + '\n'
      }
      h.r.body = body
    }
  }

  private keyword(): string | null {
    const m = KEYWORD.exec(this.s.slice(this.i, this.i + 9))
    if (!m) return null
    // `{` opens a group only before a blank; `!` negates only before one.
    if ((m[0] === '{' || m[0] === '!') && !/[ \t\r\n]/.test(this.s[this.i + 1] ?? '')) return null
    return m[0]
  }

  private expect(k: string): void {
    this.space()
    if (this.keyword() !== k && !(k === ')' && this.s[this.i] === ')'))
      throw new Unreadable(this.i >= this.s.length ? 'unbalanced' : 'unknown')
    this.i += k.length
  }

  // ── lists and pipelines ──

  private atEnd(stops: Set<string>): boolean {
    const s = this.s
    if (this.i >= s.length) {
      if (stops.size > 0) throw new Unreadable('unbalanced')
      return true
    }
    if (s[this.i] === ')') return true
    if (stops.has(';;') && /^;(?:;&?|&)/.test(s.slice(this.i, this.i + 3))) return true
    const k = this.keyword()
    return k !== null && stops.has(k)
  }

  private list(stops: Set<string>): List {
    if (++this.frames.n > MAX_FRAMES) throw new Unreadable('depth')
    const items: List['items'] = []
    let joint: Joint | null = null
    this.space()
    while (!this.atEnd(stops)) {
      items.push({ node: this.pipeline(), joinedBy: joint })
      this.blank()
      const s = this.s
      const two = s.slice(this.i, this.i + 2)
      if (two === '&&' || two === '||') {
        joint = two
        this.i += 2
        this.space()
        if (this.i >= s.length) throw new Unreadable('unbalanced')
        continue
      }
      if (s[this.i] === '\n') {
        joint = '\n'
        this.space()
        continue
      }
      if (s[this.i] === ';' && !/^;[;&]/.test(two)) {
        joint = ';'
        this.i++
        this.space()
        continue
      }
      if (s[this.i] === '&') {
        joint = '&'
        items[items.length - 1]!.node.background = true
        this.i++
        this.space()
        continue
      }
      if (!this.atEnd(stops)) throw new Unreadable('unknown')
    }
    this.frames.n--
    return { items }
  }

  private pipeline(): Pipeline {
    let negated = false
    let timed = false
    for (;;) {
      this.blank()
      const k = this.keyword()
      if (k === '!') negated = !negated
      else if (k === 'time') {
        timed = true
        this.i += 4
        this.blank()
        if (/^-p(?=[ \t])/.test(this.s.slice(this.i))) this.i += 2
        continue
      } else break
      this.i += k.length
    }
    const stages = [this.command()]
    for (;;) {
      this.blank()
      const s = this.s
      if (s[this.i] !== '|' || s[this.i + 1] === '|') break
      this.i += s[this.i + 1] === '&' ? 2 : 1
      this.space()
      stages.push(this.command())
    }
    return { stages, negated, timed }
  }

  // ── commands ──

  private command(): Node {
    this.blank()
    const s = this.s
    if (s.startsWith('((', this.i)) {
      const end = this.arithEnd(this.i + 2)
      if (end !== -1) {
        const raw = s.slice(this.i, end)
        this.i = end
        return this.simpleOf([makeWord([{ kind: 'arith', text: raw }], raw)])
      }
    }
    if (s[this.i] === '(') {
      this.i++
      const list = this.list(new Set([')']))
      this.expect(')')
      return { type: 'subshell', list, redirects: this.redirects() }
    }
    switch (this.keyword()) {
      case '{': {
        this.i++
        const list = this.list(new Set(['}']))
        this.expect('}')
        return { type: 'group', list, redirects: this.redirects() }
      }
      case 'if':
        return this.ifNode()
      case 'for':
      case 'select':
        return this.forNode()
      case 'while':
      case 'until': {
        const kind = this.keyword() as 'while' | 'until'
        this.i += kind.length
        const cond = this.list(new Set(['do']))
        this.expect('do')
        const body = this.list(new Set(['done']))
        this.expect('done')
        return {
          type: 'loop',
          kind,
          name: null,
          words: null,
          cond,
          body,
          redirects: this.redirects(),
        }
      }
      case 'case':
        return this.caseNode()
      case 'function': {
        this.i += 8
        this.blank()
        const name = this.word()?.literal
        if (!name) throw new Unreadable('unknown')
        this.blank()
        if (s.startsWith('()', this.i)) this.i += 2
        this.space()
        return { type: 'function', name, body: this.command() }
      }
      case '[[':
        return this.test()
      case 'then':
      case 'elif':
      case 'else':
      case 'fi':
      case 'do':
      case 'done':
      case 'esac':
      case '}':
        throw new Unreadable('unknown')
    }
    return this.simple()
  }

  private simpleOf(words: Word[]): Simple {
    return { type: 'simple', assigns: [], words, redirects: this.redirects() }
  }

  private redirects(): Redirect[] {
    const out: Redirect[] = []
    for (;;) {
      this.blank()
      const r = this.redirect()
      if (!r) return out
      out.push(r)
    }
  }

  private redirect(): Redirect | null {
    const s = this.s
    const rest = s.slice(this.i, this.i + 12)
    if (/^[<>]\(/.test(rest) || /^<\d*-\d*>/.test(rest)) return null
    const m = REDIRECT.exec(rest)
    if (!m || (m[1] && m[2]!.startsWith('&'))) return null
    this.i += m[0].length
    const r: Redirect = { fd: m[1] ? Number(m[1]) : null, op: m[2]!, target: null }
    this.blank()
    const target = this.word()
    if (!target) throw new Unreadable(this.i >= s.length ? 'unbalanced' : 'unknown')
    r.target = target
    if (r.op === '<<' || r.op === '<<-') {
      const delim = target.parts.map((p) => ('text' in p ? p.text : '')).join('')
      this.pending.push({ r, delim, strip: r.op === '<<-', quoted: /['"\\]/.test(target.raw) })
    }
    return r
  }

  private simple(): Node {
    const s = this.s
    const assigns: Assign[] = []
    const words: Word[] = []
    const redirects: Redirect[] = []
    for (;;) {
      this.blank()
      const c = s[this.i]
      if (c === undefined || c === '\n' || c === ';' || c === ')') break
      if ((c === '&' || c === '|') && !/^&>/.test(s.slice(this.i, this.i + 2))) break
      const r = this.redirect()
      if (r) {
        redirects.push(r)
        continue
      }
      if (words.length === 0) {
        const a = /^([A-Za-z_][A-Za-z0-9_]*)(\[[^\]\s]*\])?(\+?=)/.exec(s.slice(this.i))
        if (a) {
          this.i += a[0].length
          let value: Word | Word[]
          if (s[this.i] === '(') {
            this.i++
            value = []
            for (;;) {
              this.space()
              if (s[this.i] === ')') break
              const w = this.word()
              if (!w) throw new Unreadable(this.i >= s.length ? 'unbalanced' : 'unknown')
              value.push(tildes(w))
            }
            this.i++
          } else value = tildes(this.word() ?? makeWord([], ''))
          assigns.push({ name: a[1]!, op: a[3] as '=' | '+=', value })
          continue
        }
      }
      // `name() body`: a function definition.
      if (words.length === 1 && assigns.length === 0 && /^\(\s*\)/.test(s.slice(this.i))) {
        this.i = s.indexOf(')', this.i) + 1
        this.space()
        const name = words[0]!.literal
        if (name === null) throw new Unreadable('unknown')
        return { type: 'function', name, body: this.command() }
      }
      const w = this.word(words.length > 0)
      if (!w) throw new Unreadable('unknown')
      words.push(w)
    }
    const simple: Simple = { type: 'simple', assigns, words, redirects }
    const program = words[0]?.literal ?? ''
    if (DECLARES.has(program))
      for (const w of words.slice(1)) {
        const a = declared(w)
        if (a) w.assign = a
      }
    const nested = this.nestedOf(words, redirects)
    if (nested) simple.nested = nested
    return simple
  }

  /** The command a nested shell runs, when its text is literal. */
  private nestedOf(words: Word[], redirects: Redirect[]): List | undefined {
    let k = 0
    while (k < words.length - 1 && SHELL_WRAPPERS.has(words[k]!.literal ?? '')) k++
    const program = words[k]?.literal ?? ''
    let text: string | null = null
    if (program === 'eval' && k === 0) {
      const args = words.slice(1).map((w) => w.literal)
      if (args.length > 0 && args.every((a) => a !== null)) text = args.join(' ')
    } else if (SHELL_PROGRAM.test(program)) {
      for (let j = k + 1; j < words.length; j++) {
        const w = words[j]!.literal
        if (w === null || !w.startsWith('-')) break
        if (/^-[A-Za-z]*c/.test(w)) {
          text = words[j + 1]?.literal ?? null
          break
        }
      }
      const doc = redirects.find((r) => r.op === '<<' || r.op === '<<-')
      if (text === null && doc && words.length === k + 1)
        this.pendingNested.push({ doc, depth: this.depth + 1 })
    }
    if (text === null) return undefined
    return parseAt(text, this.depth + 1, this.frames)
  }

  /** A here-document fed to a shell: read once its body is. */
  readonly pendingNested: { doc: Redirect; depth: number }[] = []

  private ifNode(): Node {
    this.i += 2
    const branches: { cond: List; body: List }[] = []
    let otherwise: List | null = null
    for (;;) {
      const cond = this.list(new Set(['then']))
      this.expect('then')
      const body = this.list(new Set(['elif', 'else', 'fi']))
      branches.push({ cond, body })
      this.space()
      const k = this.keyword()
      if (k === 'elif') {
        this.i += 4
        continue
      }
      if (k === 'else') {
        this.i += 4
        otherwise = this.list(new Set(['fi']))
      }
      this.expect('fi')
      return { type: 'if', branches, else: otherwise, redirects: this.redirects() }
    }
  }

  private forNode(): Node {
    const kind = this.keyword() as 'for' | 'select'
    this.i += kind.length
    this.blank()
    const s = this.s
    let name: string | null = null
    let words: Word[] | null = null
    if (s.startsWith('((', this.i)) {
      const end = this.arithEnd(this.i + 2)
      if (end === -1) throw new Unreadable('unbalanced')
      this.i = end
    } else {
      name = this.word()?.literal ?? null
      if (name === null || !NAME.test(name)) throw new Unreadable('unknown')
      this.space()
      if (/^in(?=[ \t\r\n;]|$)/.test(s.slice(this.i))) {
        this.i += 2
        words = []
        for (;;) {
          this.blank()
          const c = s[this.i]
          if (c === undefined || c === ';' || c === '\n') break
          const w = this.word()
          if (!w) throw new Unreadable('unknown')
          words.push(w)
        }
      }
    }
    this.blank()
    if (s[this.i] === ';') this.i++
    this.expect('do')
    const body = this.list(new Set(['done']))
    this.expect('done')
    return { type: 'loop', kind, name, words, cond: null, body, redirects: this.redirects() }
  }

  private caseNode(): Node {
    this.i += 4
    this.blank()
    const word = this.word()
    if (!word) throw new Unreadable('unknown')
    this.space()
    if (!/^in(?=[ \t\r\n]|$)/.test(this.s.slice(this.i))) throw new Unreadable('unknown')
    this.i += 2
    const arms: List[] = []
    const s = this.s
    for (;;) {
      this.space()
      if (this.i >= s.length) throw new Unreadable('unbalanced')
      if (this.keyword() === 'esac') break
      if (s[this.i] === '(') this.i++
      for (;;) {
        this.blank()
        if (!this.word(true)) throw new Unreadable('unknown')
        this.blank()
        if (s[this.i] !== '|') break
        this.i++
      }
      if (s[this.i] !== ')') throw new Unreadable('unknown')
      this.i++
      arms.push(this.list(new Set([';;', 'esac'])))
      const end = /^;(?:;&?|&)/.exec(s.slice(this.i, this.i + 3))
      if (end) this.i += end[0].length
    }
    this.i += 4
    return { type: 'case', word, arms, redirects: this.redirects() }
  }

  /** `[[ … ]]`: its operators are words of the test, not of the shell. */
  private test(): Node {
    const s = this.s
    this.i += 2
    const words: Word[] = [makeWord([{ kind: 'lit', text: '[[', quoted: false }], '[[')]
    for (;;) {
      this.space()
      if (this.i >= s.length) throw new Unreadable('unbalanced')
      if (/^\]\](?=[ \t\r\n;&|)]|$)/.test(s.slice(this.i))) {
        this.i += 2
        words.push(makeWord([{ kind: 'lit', text: ']]', quoted: false }], ']]'))
        break
      }
      const op = /^(?:&&|\|\||[<>()!])/.exec(s.slice(this.i))
      if (op) {
        this.i += op[0].length
        words.push(makeWord([{ kind: 'lit', text: op[0], quoted: false }], op[0]))
        continue
      }
      const w = this.word(true)
      if (!w) throw new Unreadable('unknown')
      words.push(w)
    }
    return this.simpleOf(words)
  }

  // ── words ──

  /** Where `$((` or `((` ends (after its `))`), or -1 when it is not arithmetic. */
  private arithEnd(from: number): number {
    const s = this.s
    let depth = 0
    for (let j = from; j < s.length; j++) {
      if (s[j] === '(') depth++
      else if (s[j] === ')') {
        if (depth === 0) return s[j + 1] === ')' ? j + 2 : -1
        depth--
      }
    }
    return -1
  }

  /** A word, or null at an operator. `args`: an argument, where zsh reads a
   *  `(` as a glob (bash: a syntax error). */
  private word(args = false): Word | null {
    const s = this.s
    const start = this.i
    const parts: Part[] = []
    const lit = (text: string, quoted: boolean) => parts.push({ kind: 'lit', text, quoted })
    /** A part, and the reader moved past its `n` characters. */
    const take = (p: Part, n: number) => {
      parts.push(p)
      this.i += n
    }
    while (this.i < s.length) {
      const c = s[this.i]!
      const atStart = this.i === start
      if (c === '\\') {
        if (s[this.i + 1] === '\n') this.i += 2
        else if (this.i + 1 >= s.length) take({ kind: 'lit', text: '\\', quoted: true }, 1)
        else take({ kind: 'lit', text: s[this.i + 1]!, quoted: true }, 2)
      } else if (c === "'") {
        const end = s.indexOf("'", this.i + 1)
        if (end === -1) throw new Unreadable('unbalanced')
        lit(s.slice(this.i + 1, end), true)
        this.i = end + 1
      } else if (c === '"') this.double(parts)
      else if (c === '$') this.dollar(parts, false)
      else if (c === '`') this.backtick(parts)
      else if (c === '*' || c === '?') take({ kind: 'glob', text: c }, 1)
      else if (c === '[') {
        const m = /^\[[^\s;&|()<>\]]*\]/.exec(s.slice(this.i))
        if (m && m[0].length > 2) take({ kind: 'glob', text: m[0] }, m[0].length)
        else take({ kind: 'lit', text: '[', quoted: false }, 1)
      } else if (c === '{') {
        const end = this.braceEnd()
        if (end === -1) take({ kind: 'lit', text: '{', quoted: false }, 1)
        else take({ kind: 'brace', text: s.slice(this.i, end) }, end - this.i)
      } else if (c === '~' && atStart) {
        const m = /^~([A-Za-z0-9_.+-]*)/.exec(s.slice(this.i))!
        parts.push({ kind: 'tilde', user: m[1]! })
        this.i += m[0].length
      } else if (c === '(' && args) {
        const end = this.parenEnd(this.i)
        if (end === -1) throw new Unreadable('unbalanced')
        parts.push({ kind: 'glob', text: s.slice(this.i, end) })
        this.i = end
      } else if ((c === '<' || c === '>') && s[this.i + 1] === '(') {
        this.i += 2
        const list = this.list(new Set([')']))
        this.expect(')')
        parts.push({ kind: 'subst', list })
      } else if (c === '<' && /^<\d*-\d*>/.test(s.slice(this.i))) {
        const m = /^<\d*-\d*>/.exec(s.slice(this.i))!
        parts.push({ kind: 'glob', text: m[0] })
        this.i += m[0].length
      } else if (/[ \t\r\n;&|()<>]/.test(c)) break
      else {
        let j = this.i + 1
        while (j < s.length && !SPECIAL.test(s[j]!)) j++
        lit(s.slice(this.i, j), false)
        this.i = j
      }
    }
    if (this.i === start) return null
    return makeWord(parts, s.slice(start, this.i))
  }

  /** Where a `{a,b}` or `{1..3}` brace expansion ends, or -1 when the `{` is
   *  literal (no top-level comma or `..`, or no closing brace in the word). */
  private braceEnd(): number {
    const s = this.s
    let depth = 0
    let expands = false
    for (let j = this.i; j < s.length; j++) {
      const c = s[j]!
      if (c === '\\') j++
      else if (c === "'" || c === '"') {
        const end = s.indexOf(c, j + 1)
        if (end === -1) return -1
        j = end
      } else if (/[ \t\r\n;&|()<>]/.test(c)) return -1
      else if (c === '{') depth++
      else if (c === '}') {
        if (--depth === 0) return expands ? j + 1 : -1
      } else if (depth === 1 && (c === ',' || (c === '.' && s[j + 1] === '.'))) expands = true
    }
    return -1
  }

  private parenEnd(from: number): number {
    const s = this.s
    let depth = 0
    for (let j = from; j < s.length; j++) {
      if (s[j] === '\\') j++
      else if (s[j] === '(') depth++
      else if (s[j] === ')' && --depth === 0) return j + 1
      else if (s[j] === '\n') return -1
    }
    return -1
  }

  private double(parts: Part[]): void {
    const s = this.s
    this.i++
    let text = ''
    const flush = () => {
      if (text) parts.push({ kind: 'lit', text, quoted: true })
      text = ''
    }
    // `""` is a word, empty.
    if (s[this.i] === '"') parts.push({ kind: 'lit', text: '', quoted: true })
    while (this.i < s.length && s[this.i] !== '"') {
      const c = s[this.i]!
      if (c === '\\' && /[$`"\\\n]/.test(s[this.i + 1] ?? '')) {
        if (s[this.i + 1] !== '\n') text += s[this.i + 1]
        this.i += 2
      } else if (c === '$' || c === '`') {
        flush()
        if (c === '$') this.dollar(parts, true)
        else this.backtick(parts)
      } else {
        text += c
        this.i++
      }
    }
    if (this.i >= s.length) throw new Unreadable('unbalanced')
    flush()
    this.i++
  }

  private dollar(parts: Part[], quoted: boolean): void {
    const s = this.s
    const next = s[this.i + 1] ?? ''
    if (s.startsWith('$((', this.i)) {
      const end = this.arithEnd(this.i + 3)
      if (end !== -1) {
        parts.push({ kind: 'arith', text: s.slice(this.i, end) })
        this.i = end
        return
      }
    }
    if (next === '(') {
      this.i += 2
      const list = this.list(new Set([')']))
      this.expect(')')
      parts.push({ kind: 'subst', list })
    } else if (next === '{') {
      let depth = 0
      let j = this.i + 1
      for (; j < s.length; j++) {
        if (s[j] === '\\') j++
        else if (s[j] === '{') depth++
        else if (s[j] === '}' && --depth === 0) break
      }
      if (j >= s.length) throw new Unreadable('unbalanced')
      const inner = s.slice(this.i + 2, j)
      const m = /^[#!]?(?:[A-Za-z_][A-Za-z0-9_]*|\d+|[@*#?$!-])/.exec(inner)
      const name = m ? m[0].replace(/^[#!](?=.)/, '') : ''
      parts.push({ kind: 'param', name, op: inner.slice(m ? m[0].length : 0) })
      this.i = j + 1
    } else if ((next === "'" || next === '"') && !quoted) {
      let j = this.i + 2
      for (; j < s.length && s[j] !== next; j++) if (s[j] === '\\') j++
      if (j >= s.length) throw new Unreadable('unbalanced')
      parts.push({ kind: 'ansic', text: s.slice(this.i, j + 1) })
      this.i = j + 1
    } else {
      const m = /^(?:[A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])/.exec(s.slice(this.i + 1))
      if (m) {
        parts.push({ kind: 'param', name: m[0], op: '' })
        this.i += 1 + m[0].length
      } else {
        parts.push({ kind: 'lit', text: '$', quoted })
        this.i++
      }
    }
  }

  private backtick(parts: Part[]): void {
    const s = this.s
    let j = this.i + 1
    let inner = ''
    for (; j < s.length && s[j] !== '`'; j++) {
      if (s[j] === '\\' && /[`\\$]/.test(s[j + 1] ?? '')) inner += s[++j]
      else inner += s[j]
    }
    if (j >= s.length) throw new Unreadable('unbalanced')
    this.i = j + 1
    const r = new Reader(inner, this.depth, this.frames)
    parts.push({ kind: 'subst', list: r.read() })
  }

  /** The whole text, here-documents fed to a shell read once their bodies are. */
  read(): List {
    const l = this.all()
    for (const { doc, depth } of this.pendingNested) {
      const quoted = /['"\\]/.test(doc.target?.raw ?? '')
      if (doc.body === undefined || (!quoted && /[$`\\]/.test(doc.body))) continue
      const nested = parseAt(doc.body, depth, this.frames)
      // The Simple the document belongs to: found by its redirection.
      const owner = findSimple(l, (n) => n.redirects.includes(doc))
      if (owner) owner.nested = nested
    }
    return l
  }
}

function findSimple(l: List, pick: (n: Simple) => boolean): Simple | undefined {
  for (const { node } of l.items)
    for (const n of node.stages) {
      const found = findIn(n, pick)
      if (found) return found
    }
  return undefined
}

function findIn(n: Node, pick: (n: Simple) => boolean): Simple | undefined {
  switch (n.type) {
    case 'simple':
      return pick(n) ? n : undefined
    case 'subshell':
    case 'group':
      return findSimple(n.list, pick)
    case 'if':
      for (const b of n.branches) {
        const f = findSimple(b.cond, pick) ?? findSimple(b.body, pick)
        if (f) return f
      }
      return n.else ? findSimple(n.else, pick) : undefined
    case 'loop':
      return (n.cond && findSimple(n.cond, pick)) || findSimple(n.body, pick)
    case 'case':
      for (const a of n.arms) {
        const f = findSimple(a, pick)
        if (f) return f
      }
      return undefined
    case 'function':
      return findIn(n.body, pick)
  }
}

function parseAt(text: string, depth: number, frames: { n: number }): List {
  if (depth > MAX_DEPTH) throw new Unreadable('depth')
  return new Reader(text, depth, frames).read()
}

/** A command read as the shell reads it (spec 086 data-model.md). `'sh'` is
 *  bash and zsh, both readings kept where they differ; `'ps'` PowerShell. */
export function parseShell(command: string, dialect: 'sh' | 'ps'): ParseResult {
  if (dialect === 'ps') return { ok: false, why: 'unknown' }
  try {
    return { ok: true, list: parseAt(command, 0, { n: 0 }) }
  } catch (err) {
    if (err instanceof Unreadable) return { ok: false, why: err.why }
    throw err
  }
}
