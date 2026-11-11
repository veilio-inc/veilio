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
  | {
      kind: 'param'
      name: string
      op: string
      /** The value written after `:-`, `-`, `:=`, `=`, `:+`, `+`, `:?`, `?`,
       *  and (zsh) an expansion standing where the name does. */
      operand?: Word[]
      /** zsh: the expansion rewrites text written in the command (flags, or
       *  an operator on an expansion standing where the name does). */
      transforms?: true
    }
  | { kind: 'subst'; list: List | null }
  /** `substs`: the commands of the `$(...)` and backticks inside. */
  | { kind: 'arith'; text: string; substs?: List[] }
  | { kind: 'glob'; text: string }
  /** zsh: a group or qualifier glued to a word (`any`: any text may stand
   *  there), or a numeric range `<1-9>` (digits). `qualifier`: parentheses
   *  that end the word, hold no `|`, `(` or `~` and follow no `@ + ! ? *` -
   *  zsh reads them as glob qualifiers (`*.ts(om)`), not as text. `star`:
   *  parentheses after the word's own `*` (`*(.)`, ksh's `*(x)`): that `*`. */
  | { kind: 'zglob'; text: string; any: boolean; qualifier?: true; star?: true }
  | { kind: 'brace'; text: string }
  | { kind: 'tilde'; user: string }
  | { kind: 'ansic'; text: string }
/** `literal`: the text after quote removal when no part expands, else null.
 *  `assign`: the word read as an assignment by a declaration builtin. */
export type Word = { parts: Part[]; literal: string | null; raw: string; assign?: Assign }
/** `name` null: a name the shell builds (`declare "${x}"=v`). */
export type Assign = { name: string | null; op: '=' | '+='; value: Word | Word[] }
/** `substs`: the commands of the `$(...)` and backticks in a here-document's body. */
export type Redirect = {
  fd: number | null
  op: string
  target: Word | null
  body?: string
  substs?: List[]
}
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
  /** `substs`: the commands of the `$(...)` and backticks in its patterns. */
  | { type: 'case'; word: Word; arms: List[]; redirects: Redirect[]; substs?: List[] }
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
/** Brace expansions tried in one command (each may scan to its word's end). */
const MAX_BRACE_SCANS = 200
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

/** The commands of every `$(...)` and backtick in words, at any depth of
 *  written values and arithmetic. */
function substsOf(words: readonly Word[]): List[] {
  const out: List[] = []
  for (const w of words)
    for (const p of w.parts) {
      if (p.kind === 'subst' && p.list) out.push(p.list)
      else if (p.kind === 'arith') out.push(...(p.substs ?? []))
      else if (p.kind === 'param') out.push(...substsOf(p.operand ?? []))
    }
  return out
}

/** Whether words hold text written in the command (not only what the shell
 *  fills in when it runs). */
function holdsText(words: readonly Word[]): boolean {
  return words.some((w) =>
    w.parts.some((p) =>
      p.kind === 'param'
        ? holdsText(p.operand ?? [])
        : p.kind !== 'subst' && p.kind !== 'arith' && p.kind !== 'tilde'
    )
  )
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
  /** `'` is an ordinary character (a written value inside double quotes). */
  private plainQuote = false
  constructor(
    private readonly s: string,
    private readonly depth: number,
    private readonly frames: { n: number; braces?: number }
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
      const substs = this.bodySubsts(body, h.quoted)
      if (substs.length > 0) h.r.substs = substs
    }
  }

  /** The commands of each `$(...)` and backtick pair in a here-document's
   *  body. The shell runs none under a quoted delimiter: there, one that
   *  cannot be read is passed over; under a plain delimiter it makes the
   *  command unreadable. */
  private bodySubsts(body: string, quoted: boolean): List[] {
    const out: List[] = []
    for (let k = 0; k < body.length; k++) {
      const tick = body[k] === '`'
      if (!tick && !(body[k] === '$' && body[k + 1] === '(')) continue
      // Under a plain delimiter an odd run of backslashes before it escapes
      // it; an even run is backslashes, and the substitution runs.
      let slashes = 0
      while (body[k - 1 - slashes] === '\\') slashes++
      if (!quoted && slashes % 2 === 1) continue
      const frames = this.frames.n
      try {
        const r = new Reader(body, this.depth, this.frames)
        r.i = k
        if (tick) {
          const parts: Part[] = []
          r.backtick(parts)
          const p = parts[0]
          if (p?.kind === 'subst' && p.list) out.push(p.list)
        } else {
          // `$((` closed by `))` is arithmetic: the substitutions inside it
          // are met as the scan goes on. Otherwise it is a command.
          if (body[k + 2] === '(' && r.arithEnd(k + 3) !== -1) continue
          r.i += 2
          out.push(r.list(new Set([')'])))
          r.expect(')')
        }
        k = r.i - 1
      } catch (err) {
        if (!(err instanceof Unreadable) || !quoted) throw err
        this.frames.n = frames
      }
    }
    return out
  }

  /** The words of text inside an expansion (a parameter's written value, an
   *  arithmetic expression), where the shell's operators are ordinary
   *  characters. `plain`: inside double quotes, where `'` is one too. */
  private inner(text: string, plain = false): Word[] {
    // Bounded like any nesting: a value inside a value inside a value.
    if (++this.frames.n > MAX_FRAMES) throw new Unreadable('depth')
    const r = new Reader(text, this.depth, this.frames)
    r.plainQuote = plain
    const out: Word[] = []
    while (r.i < text.length) {
      const c = text[r.i]!
      if (/\s/.test(c)) {
        r.i++
        continue
      }
      const w = r.word(true)
      if (w) out.push(w)
      else {
        out.push(makeWord([{ kind: 'lit', text: c, quoted: false }], c))
        r.i++
      }
    }
    this.frames.n--
    return out
  }

  /** A parameter's written value. Inside double quotes bash reads a `'`
   *  there as itself and zsh as a quote: both readings, when both can be read. */
  private operand(text: string, quoted: boolean): Word[] {
    if (!quoted || !text.includes("'")) return this.inner(text)
    const frames = this.frames.n
    try {
      return [...this.inner(text), ...this.inner(text, true)]
    } catch (err) {
      if (!(err instanceof Unreadable)) throw err
      this.frames.n = frames
      return this.inner(text, true)
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
        return this.simpleOf([makeWord([this.arith(raw, 2)], raw)])
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
        if (!a) continue
        // `declare -a f=(a b)`: the array's words.
        const [only, ...more] = Array.isArray(a.value) ? [] : a.value.parts
        if (only?.kind === 'glob' && more.length === 0 && /^\([^]*\)$/.test(only.text))
          a.value = this.inner(only.text.slice(1, -1)).map(tildes)
        w.assign = a
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
      // Its options, read letter by letter as the shell reads them
      // (verified in bash 3.2 and zsh 5.9): `c` says a script follows; in
      // bash and sh every `o`/`O` takes one following word, in order, and
      // the letters after it still count (`-Oc dotglob`, `-OOc a b`, `-cOe
      // a`); in zsh `o` takes the rest of its word when there is one
      // (`-oglobdots`, `-ecoglobdots`), else the next word. The script is
      // the first word left that is not an option.
      const zsh = /(?:^|\/)zsh$/.test(program)
      let scripted = false
      let j = k + 1
      for (; j < words.length; j++) {
        const w = words[j]!.literal
        if (w === null) {
          // After `-c`, the script itself, built at run time. Before it, an
          // option word the command builds: with a `-c` word still to come,
          // which word is the script cannot be told.
          if (
            !scripted &&
            words.slice(j + 1).some((x) => /^[-+][A-Za-z0-9]*c/.test(x.literal ?? ''))
          )
            throw new Unreadable('unknown')
          break
        }
        if (w === '--') {
          j++
          break
        }
        if (!/^[-+]/.test(w)) break
        if (w.startsWith('--')) continue
        // `sh -c'cat x'`: a script attached to the option, read as the
        // separate form is (no shell takes it so; the text rule's finding).
        const attached = /^-[A-Za-z0-9]*?c(.*)$/s.exec(w)?.[1]
        if (attached !== undefined && /[^A-Za-z0-9_]/.test(attached)) {
          text = attached
          scripted = false
          break
        }
        for (let at = 1; at < w.length; at++) {
          if (w[at] === 'c') scripted = true
          else if (w[at] === 'o' || w[at] === 'O') {
            // zsh: the option's name is the rest of this word.
            if (zsh && at < w.length - 1) break
            // The name is the next word; none left: the shell itself fails.
            if (++j >= words.length) throw new Unreadable('unknown')
          }
        }
      }
      if (scripted) text = words[j]?.literal ?? null
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
      // Its header, kept only when a substitution in it runs a command.
      const header = this.arith(s.slice(this.i, end), 2)
      if (header.kind === 'arith' && header.substs)
        words = [makeWord([header], s.slice(this.i, end))]
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
    const substs: List[] = []
    const s = this.s
    for (;;) {
      this.space()
      if (this.i >= s.length) throw new Unreadable('unbalanced')
      if (this.keyword() === 'esac') break
      if (s[this.i] === '(') this.i++
      for (;;) {
        this.blank()
        const pattern = this.word(true)
        if (!pattern) throw new Unreadable('unknown')
        substs.push(...substsOf([pattern]))
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
    const redirects = this.redirects()
    return substs.length > 0
      ? { type: 'case', word, arms, redirects, substs }
      : { type: 'case', word, arms, redirects }
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

  /** An arithmetic expression (`open` characters open it, `))` closes it),
   *  with the commands of the substitutions inside. */
  private arith(text: string, open: number): Part {
    const substs = substsOf(this.inner(text.slice(open, -2)))
    return substs.length > 0 ? { kind: 'arith', text, substs } : { kind: 'arith', text }
  }

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
      } else if (c === "'" && !this.plainQuote) {
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
      } else if (c === '(' && (args || (parts.length > 0 && !/^\(\s*\)/.test(s.slice(this.i))))) {
        const end = this.parenEnd(this.i)
        if (end === -1) {
          if (!args) break
          throw new Unreadable('unbalanced')
        }
        const text = s.slice(this.i, end)
        // zsh: a group or qualifier glued to a word stands for any text
        // there, with the `@`, `+`, `!`, `?` or `*` before it (ksh's groups).
        // `name=(a b)` given to a declaration is an array: read in simple().
        // Whether the parentheses end the word (another group is more of it).
        const ends = s[end] !== '(' && !this.continues(end)
        const array =
          ends &&
          parts.length === 1 &&
          parts[0]!.kind === 'lit' &&
          /^\w+\+?=$/.test(s.slice(start, this.i))
        if (!array && text.length > 2 && (parts.length > 0 || !ends)) {
          const last = parts[parts.length - 1]
          let grouped = false
          let star = false
          if (last?.kind === 'glob' && last.text === '*') {
            // `*(.)` ending the word is that `*`; inside it, `*` and a group.
            grouped = true
            star = ends
            if (star) parts.pop()
          } else if (last?.kind === 'glob' && last.text === '?') {
            parts.pop()
            grouped = true
          } else if (last?.kind === 'lit' && !last.quoted && /[@+!]$/.test(last.text)) {
            last.text = last.text.slice(0, -1)
            if (last.text === '') parts.pop()
            grouped = true
          }
          const part: Part = { kind: 'zglob', text, any: true }
          if (star) part.star = true
          else if (!grouped && ends && !/[|(~]/.test(text.slice(1, -1))) part.qualifier = true
          parts.push(part)
        } else parts.push({ kind: 'glob', text })
        this.i = end
      } else if (
        ((c === '<' || c === '>') && s[this.i + 1] === '(') ||
        // zsh: `=(cmd)` at a word's start is the command's output in a file.
        (c === '=' && atStart && s[this.i + 1] === '(')
      ) {
        this.i += 2
        const list = this.list(new Set([')']))
        this.expect(')')
        parts.push({ kind: 'subst', list })
      } else if (c === '<' && /^<\d*-\d*>/.test(s.slice(this.i))) {
        const m = /^<\d*-\d*>/.exec(s.slice(this.i))!
        // zsh: glued to a word, a range of numbers.
        const glued = parts.length > 0 || this.continues(this.i + m[0].length)
        parts.push(glued ? { kind: 'zglob', text: m[0], any: false } : { kind: 'glob', text: m[0] })
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

  /** Whether the word goes on at `at`. */
  private continues(at: number): boolean {
    return at < this.s.length && !/[ \t\r\n;&|()<>]/.test(this.s[at]!)
  }

  /** Where a `{a,b}` or `{1..3}` brace expansion ends, or -1 when the `{` is
   *  literal (no top-level comma or `..`, or no closing brace in the word). */
  private braceEnd(): number {
    // Each unclosed `{` rescans its word: bounded, past it unreadable (T029).
    this.frames.braces = (this.frames.braces ?? 0) + 1
    if (this.frames.braces > MAX_BRACE_SCANS) throw new Unreadable('depth')
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
        parts.push(this.arith(s.slice(this.i, end), 3))
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
      const op = inner.slice(m ? m[0].length : 0)
      // zsh: flags (`${(L)x}`), and an expansion where the name stands
      // (`${${x}...}`); then the name, and what follows it.
      const flags = /^\((?:[^()]|\([^()]*\))*\)/.exec(inner)?.[0] ?? ''
      let rest = inner.slice(flags.length)
      const named: Word[] = []
      if (/^\$[{(]/.test(rest)) {
        if (++this.frames.n > MAX_FRAMES) throw new Unreadable('depth')
        const r = new Reader(rest, this.depth, this.frames)
        const inside: Part[] = []
        r.dollar(inside, quoted)
        this.frames.n--
        named.push(makeWord(inside, rest.slice(0, r.i)))
        rest = rest.slice(r.i)
      } else
        rest = rest.slice(/^[#!]?(?:[A-Za-z_][A-Za-z0-9_]*|\d+|[@*#?$!-])?/.exec(rest)![0].length)
      // A value written in the command, past a subscript (`${a[0]:-v}`).
      const written = /^(?:\[[^\]]*\])?:?[-=+?]/.exec(rest)
      const operand = [
        ...named,
        ...(written ? this.operand(rest.slice(written[0].length), quoted) : []),
      ]
      const part: Part = { kind: 'param', name, op }
      if (written || named.length > 0) part.operand = operand
      if ((flags !== '' || (named.length > 0 && rest !== '')) && holdsText(operand))
        part.transforms = true
      parts.push(part)
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

function parseAt(text: string, depth: number, frames: { n: number; braces?: number }): List {
  if (depth > MAX_DEPTH) throw new Unreadable('depth')
  return new Reader(text, depth, frames).read()
}

// ── PowerShell (research R3, FR-016) ──────────────────────────────────────

/** The program word of a PowerShell statement that is an expression (a
 *  string, a variable, a parenthesis), not a command: never a cd. */
export const PS_EXPRESSION = '(expression)'
const PS_ESCAPES: Readonly<Record<string, string>> = {
  '0': '\0',
  a: '\x07',
  b: '\b',
  e: '\x1b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
}
const PS_END = /[ \t\r\n;|&(){}'"`$<>,]/
const PS_KEYWORD =
  /^(?:if|foreach|for|while|do|switch|try|function|filter|param|class|enum|data|trap)(?=[ \t\r\n({]|$)/i
const lit = (text: string, quoted: boolean): Part => ({ kind: 'lit', text, quoted })
const word = (parts: Part[], raw: string): Word => makeWord(parts, raw)

class PsReader {
  private i = 0
  constructor(
    private readonly s: string,
    private readonly frames: { n: number; braces?: number }
  ) {}

  read(): List {
    const l = this.list(null)
    if (this.i < this.s.length) throw new Unreadable('unbalanced')
    return l
  }

  private blank(newlines = false): void {
    const s = this.s
    for (;;) {
      const c = s[this.i]
      if (c === ' ' || c === '\t' || c === '\r' || (newlines && c === '\n')) this.i++
      else if (c === '`' && s[this.i + 1] === '\n') this.i += 2
      else if (c === '`' && s[this.i + 1] === '\r' && s[this.i + 2] === '\n') this.i += 3
      else if (s.startsWith('<#', this.i)) {
        const end = s.indexOf('#>', this.i + 2)
        if (end === -1) throw new Unreadable('unbalanced')
        this.i = end + 2
      } else if (c === '#') while (this.i < s.length && s[this.i] !== '\n') this.i++
      else return
    }
  }

  /** Statements up to `stop` (`)` or `}`), or the end. */
  private list(stop: ')' | '}' | null): List {
    if (++this.frames.n > MAX_FRAMES) throw new Unreadable('depth')
    const items: List['items'] = []
    let joint: Joint | null = null
    const s = this.s
    for (;;) {
      this.blank(true)
      while (s[this.i] === ';') {
        this.i++
        this.blank(true)
      }
      if (this.i >= s.length) {
        if (stop) throw new Unreadable('unbalanced')
        break
      }
      if (s[this.i] === stop) break
      if (s[this.i] === ')' || s[this.i] === '}') throw new Unreadable('unbalanced')
      items.push({ node: this.pipeline(), joinedBy: joint })
      this.blank()
      const two = s.slice(this.i, this.i + 2)
      if (two === '&&' || two === '||') {
        joint = two
        this.i += 2
        this.blank(true)
        if (this.i >= s.length) throw new Unreadable('unbalanced')
      } else if (s[this.i] === '&') {
        items[items.length - 1]!.node.background = true
        joint = '&'
        this.i++
      } else joint = s[this.i] === '\n' ? '\n' : ';'
    }
    this.frames.n--
    return { items }
  }

  private pipeline(): Pipeline {
    const stages = [this.statement()]
    for (;;) {
      this.blank()
      if (this.s[this.i] !== '|' || this.s[this.i + 1] === '|') break
      this.i++
      this.blank(true)
      stages.push(this.statement())
    }
    return { stages, negated: false, timed: false }
  }

  /** `( … )` or `{ … }` read as a list, from its opening character. */
  private block(): List {
    const close = this.s[this.i] === '(' ? ')' : '}'
    this.i++
    const l = this.list(close)
    this.i++
    return l
  }

  /** A condition or a `( … )` expression: one statement holding it. */
  private paren(): List {
    const start = this.i
    const inner = this.block()
    const w = word([{ kind: 'subst', list: inner }], this.s.slice(start, this.i))
    return this.one([word([lit(PS_EXPRESSION, false)], PS_EXPRESSION), w])
  }

  private one(words: Word[]): List {
    const n: Simple = { type: 'simple', assigns: [], words, redirects: [] }
    return { items: [{ node: { stages: [n], negated: false, timed: false }, joinedBy: null }] }
  }

  private expectBlock(): List {
    this.blank(true)
    if (this.s[this.i] !== '{')
      throw new Unreadable(this.i >= this.s.length ? 'unbalanced' : 'unknown')
    return this.block()
  }

  private statement(): Node {
    this.blank()
    const s = this.s
    const k = PS_KEYWORD.exec(s.slice(this.i, this.i + 9))?.[0].toLowerCase()
    if (k) this.i += k.length
    switch (k) {
      case 'if': {
        const branches: { cond: List; body: List }[] = []
        let otherwise: List | null = null
        for (;;) {
          this.blank(true)
          if (s[this.i] !== '(') throw new Unreadable('unknown')
          const cond = this.paren()
          branches.push({ cond, body: this.expectBlock() })
          this.blank(true)
          const next = /^(elseif|else)(?=[ \t\r\n({]|$)/i.exec(s.slice(this.i, this.i + 7))?.[0]
          if (!next) break
          this.i += next.length
          if (next.toLowerCase() === 'else') {
            otherwise = this.expectBlock()
            break
          }
        }
        return { type: 'if', branches, else: otherwise, redirects: [] }
      }
      case 'foreach':
      case 'for':
      case 'switch':
        // Their headers are not read: the command is unreadable (review).
        throw new Unreadable('unknown')
      case 'while': {
        this.blank(true)
        if (s[this.i] !== '(') throw new Unreadable('unknown')
        const cond = this.paren()
        const body = this.expectBlock()
        return { type: 'loop', kind: 'while', name: null, words: null, cond, body, redirects: [] }
      }
      case 'do': {
        const body = this.expectBlock()
        this.blank(true)
        const w = /^(while|until)/i.exec(s.slice(this.i, this.i + 5))?.[0]
        if (!w) throw new Unreadable('unknown')
        this.i += w.length
        this.blank(true)
        if (s[this.i] !== '(') throw new Unreadable('unknown')
        const cond = this.paren()
        return { type: 'loop', kind: 'while', name: null, words: null, cond, body, redirects: [] }
      }
      case 'try': {
        // try, catch and finally, read in order (each may run).
        const items: List['items'] = [...this.expectBlock().items]
        for (;;) {
          this.blank(true)
          const c = /^(catch|finally)/i.exec(s.slice(this.i, this.i + 7))?.[0]
          if (!c) break
          this.i += c.length
          this.blank()
          while (s[this.i] === '[') {
            const end = s.indexOf(']', this.i)
            if (end === -1) throw new Unreadable('unbalanced')
            this.i = end + 1
            this.blank()
            if (s[this.i] === ',') {
              this.i++
              this.blank()
            }
          }
          items.push(...this.expectBlock().items)
        }
        return { type: 'group', list: { items }, redirects: [] }
      }
      case 'function':
      case 'filter': {
        this.blank()
        const name = this.word()?.literal
        if (!name) throw new Unreadable('unknown')
        this.blank()
        if (s[this.i] === '(') this.block()
        return {
          type: 'function',
          name,
          body: { type: 'group', list: this.expectBlock(), redirects: [] },
        }
      }
      case 'param':
      case 'class':
      case 'enum':
      case 'data':
      case 'trap': {
        // Declarations: read for their words, never run as commands here.
        this.blank(true)
        while (this.i < s.length && s[this.i] !== '(' && s[this.i] !== '{') this.i++
        if (this.i >= s.length) throw new Unreadable('unbalanced')
        const start = this.i
        const inner = this.block()
        if (k === 'class' || k === 'enum') this.blank(true)
        return {
          type: 'simple',
          assigns: [],
          words: [
            word([lit(PS_EXPRESSION, false)], PS_EXPRESSION),
            word([{ kind: 'subst', list: inner }], s.slice(start, this.i)),
          ],
          redirects: [],
        }
      }
    }
    return this.command()
  }

  private command(): Node {
    const s = this.s
    // `$name = …`: an assignment, its value a word or a command's output.
    const a = /^\$(?:\{([^}]+)\}|((?:[A-Za-z]+:)?[A-Za-z_][A-Za-z0-9_]*))\s*([-+*/%]?=)(?!=)/.exec(
      s.slice(this.i)
    )
    if (a) {
      this.i += a[0].length
      this.blank()
      const start = this.i
      const value = this.pipeline()
      const raw = s.slice(start, this.i)
      const only = value.stages.length === 1 ? value.stages[0]! : null
      const w =
        only?.type === 'simple' &&
        only.words[0]?.literal === PS_EXPRESSION &&
        only.words.length === 2
          ? only.words[1]!
          : word([{ kind: 'subst', list: { items: [{ node: value, joinedBy: null }] } }], raw)
      const name = a[1] ?? a[2]!
      return {
        type: 'simple',
        assigns: [{ name, op: a[3] === '+=' ? '+=' : '=', value: w }],
        words: [],
        redirects: [],
      }
    }
    const words: Word[] = []
    const redirects: Redirect[] = []
    // An expression statement: a string, a number, a variable, a parenthesis.
    if (/^(?:['"$(@[{]|\d|-\d)/.test(s.slice(this.i)))
      words.push(word([lit(PS_EXPRESSION, false)], PS_EXPRESSION))
    for (;;) {
      this.blank()
      const c = s[this.i]
      if (c === undefined || c === '\n' || c === ';' || c === ')' || c === '}' || c === '|') break
      if (c === '&' && (s[this.i + 1] === '&' || words.length > 0)) break
      const r = /^(?:\d|\*)?>>?(?:&\d)?|^</.exec(s.slice(this.i, this.i + 5))
      if (r) {
        this.i += r[0].length
        const target = r[0].includes('&') ? null : (this.blank(), this.word())
        if (!r[0].includes('&') && !target)
          throw new Unreadable(this.i >= s.length ? 'unbalanced' : 'unknown')
        redirects.push({
          fd: /^\d/.test(r[0]) ? Number(r[0][0]) : null,
          op: r[0].replace(/^[\d*]/, ''),
          target,
        })
        continue
      }
      if (c === '&' || (c === '.' && words.length === 0 && /[ \t]/.test(s[this.i + 1] ?? ''))) {
        // The call operator and dot-sourcing: what follows is the command.
        words.push(word([lit(c, false)], c))
        this.i++
        continue
      }
      const w = this.word()
      if (!w) throw new Unreadable('unknown')
      words.push(w)
    }
    return { type: 'simple', assigns: [], words, redirects }
  }

  private word(): Word | null {
    const s = this.s
    const start = this.i
    const parts: Part[] = []
    while (this.i < s.length) {
      const c = s[this.i]!
      const atStart = this.i === start
      if (c === '`') {
        if (s[this.i + 1] === '\n' || this.i + 1 >= s.length) break
        parts.push(lit(s[this.i + 1]!, true))
        this.i += 2
      } else if (c === "'") {
        let text = ''
        let j = this.i + 1
        for (; j < s.length; j++) {
          if (s[j] === "'" && s[j + 1] === "'") {
            text += "'"
            j++
          } else if (s[j] === "'") break
          else text += s[j]
        }
        if (j >= s.length) throw new Unreadable('unbalanced')
        parts.push(lit(text, true))
        this.i = j + 1
      } else if (c === '"') this.double(parts)
      else if (c === '$') this.dollar(parts)
      else if (c === '@' && (s[this.i + 1] === '(' || s[this.i + 1] === '{')) {
        this.i++
        const b = this.i
        // A hashtable is not read: unreadable (review).
        if (s[b] !== '(') throw new Unreadable('unknown')
        parts.push({ kind: 'subst', list: this.block() })
      } else if (c === '@' && (s[this.i + 1] === "'" || s[this.i + 1] === '"')) {
        const q = s[this.i + 1]!
        const end = s.indexOf(`\n${q}@`, this.i + 2)
        if (end === -1) throw new Unreadable('unbalanced')
        const text = s.slice(this.i + 2, end).replace(/^\r?\n/, '')
        // An expanding here-string's `$( )` is not read: unreadable.
        if (q === '"' && text.includes('$(')) throw new Unreadable('unknown')
        parts.push(q === "'" || !/[$`]/.test(text) ? lit(text, true) : { kind: 'ansic', text })
        this.i = end + 3
      } else if (c === '(' || c === '{') {
        if (!atStart && c === '(') break
        parts.push({ kind: 'subst', list: this.block() })
      } else if (c === '*' || c === '?' || c === '[') {
        parts.push({ kind: 'glob', text: c })
        this.i++
      } else if (c === '~' && atStart) {
        const m = /^~([A-Za-z0-9_.+-]*)/.exec(s.slice(this.i))!
        parts.push({ kind: 'tilde', user: m[1]! })
        this.i += m[0].length
      } else if (c === ',' && atStart) {
        parts.push(lit(',', false))
        this.i++
      } else if (PS_END.test(c) && c !== ',') break
      else {
        let j = this.i + 1
        while (j < s.length && !PS_END.test(s[j]!) && !/[*?[]/.test(s[j]!)) {
          // `-Name:value`: the parameter ends at its colon.
          if (s[j] === ':' && /^-[A-Za-z]+$/.test(s.slice(start, j))) {
            j++
            break
          }
          j++
        }
        parts.push(lit(s.slice(this.i, j), false))
        this.i = j
        if (s[j - 1] === ':' && /^-[A-Za-z]+:$/.test(s.slice(start, j))) break
      }
    }
    if (this.i === start) return null
    return word(parts, s.slice(start, this.i))
  }

  private double(parts: Part[]): void {
    const s = this.s
    this.i++
    let text = ''
    const flush = () => {
      if (text) parts.push(lit(text, true))
      text = ''
    }
    if (s[this.i] === '"' && s[this.i + 1] !== '"') parts.push(lit('', true))
    for (;;) {
      if (this.i >= s.length) throw new Unreadable('unbalanced')
      const c = s[this.i]!
      if (c === '"' && s[this.i + 1] === '"') {
        text += '"'
        this.i += 2
      } else if (c === '"') break
      else if (c === '`' && this.i + 1 < s.length) {
        const n = s[this.i + 1]!
        text += PS_ESCAPES[n] ?? n
        this.i += 2
      } else if (c === '$' && /[A-Za-z_({?$^]/.test(s[this.i + 1] ?? '')) {
        flush()
        this.dollar(parts)
      } else {
        text += c
        this.i++
      }
    }
    flush()
    this.i++
  }

  private dollar(parts: Part[]): void {
    const s = this.s
    if (s[this.i + 1] === '(') {
      this.i++
      parts.push({ kind: 'subst', list: this.block() })
      return
    }
    if (s[this.i + 1] === '{') {
      const end = s.indexOf('}', this.i)
      if (end === -1) throw new Unreadable('unbalanced')
      parts.push({ kind: 'param', name: s.slice(this.i + 2, end), op: '' })
      this.i = end + 1
      return
    }
    const m = /^(?:(?:[A-Za-z]+:)?[A-Za-z_][A-Za-z0-9_]*|[_?$^])/.exec(s.slice(this.i + 1))
    if (!m) {
      parts.push(lit('$', false))
      this.i++
      return
    }
    parts.push({ kind: 'param', name: m[0], op: '' })
    this.i += 1 + m[0].length
  }
}

/** A command read as the shell reads it (spec 086 data-model.md). `'sh'` is
 *  bash and zsh, both readings kept where they differ; `'ps'` PowerShell. */
export function parseShell(command: string, dialect: 'sh' | 'ps'): ParseResult {
  try {
    if (dialect === 'ps') return { ok: true, list: new PsReader(command, { n: 0 }).read() }
    return { ok: true, list: parseAt(command, 0, { n: 0 }) }
  } catch (err) {
    if (err instanceof Unreadable) return { ok: false, why: err.why }
    throw err
  }
}
