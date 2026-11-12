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
      /** zsh: the expansion rewrites text written in the command (something
       *  before the name, or an operator on an expansion standing where the
       *  name does). */
      transforms?: true
      /** The commands inside the operands that put no text into the word (a
       *  subscript, a pattern, an offset, a length). */
      substs?: List[]
      /** Inside double quotes: the shell does not split the word here. */
      quoted?: true
    }
  /** `into`: `>(...)`, a process substitution that reads what is written to
   *  it. `file`: `<(...)` or zsh's `=(...)`, whose output is a file's text. */
  | { kind: 'subst'; list: List | null; quoted?: true; into?: true; file?: true }
  /** `substs`: the commands of the `$(...)` and backticks inside. */
  | { kind: 'arith'; text: string; substs?: List[] }
  | { kind: 'glob'; text: string }
  /** zsh: a group or qualifier glued to a word (`any`: any text may stand
   *  there), or a numeric range `<1-9>` (digits). `qualifier`: parentheses
   *  that end the word, hold no `|`, `(` or `~` and follow no `@ + ! ? *` -
   *  zsh reads them as glob qualifiers (`*.ts(om)`), not as text. `star`:
   *  parentheses after the word's own `*` (`*(.)`, ksh's `*(x)`): that `*`. */
  /** `rewrites`: a qualifier that can put text into the name or run code
   *  (it holds `e`, `+`, `P` or a `:` modifier): the word could be any name. */
  /** `alternatives`: a group whose alternatives are all plain text
   *  (`(ts|tsx)`): exactly those, as a brace list; for one alone (`(n)`),
   *  that text or nothing - where the word is cut into pieces it may be a
   *  qualifier. `prefixed`: a ksh group (`@(`, `+(`, `?(`) or one after the
   *  word's `*`. */
  | {
      kind: 'zglob'
      text: string
      any: boolean
      qualifier?: true
      star?: true
      rewrites?: true
      alternatives?: string[]
      prefixed?: true
    }
  | { kind: 'brace'; text: string }
  | { kind: 'tilde'; user: string }
  | { kind: 'ansic'; text: string }
/** `literal`: the text after quote removal when no part expands, else null.
 *  `assign`: the word read as an assignment by a declaration builtin. */
/** `again`: the commands of each substitution written inside quotes or after
 *  a backslash - text the shell may evaluate again (reading table A9). */
export type Word = {
  parts: Part[]
  literal: string | null
  raw: string
  assign?: Assign
  again?: List[]
}
/** `name` null: a name the shell builds (`declare "${x}"=v`). */
export type Assign = { name: string | null; op: '=' | '+='; value: Word | Word[] }
/** `substs`: the commands of the `$(...)` and backticks in a here-document's body. */
export type Redirect = {
  fd: number | null
  op: string
  target: Word | null
  body?: string
  substs?: List[]
  /** A here-document's body read as a script, when it parses as one:
   *  whatever it is given to may be a shell (reading table A5b). */
  again?: List[]
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
  { ok: true; list: List } | { ok: false; why: 'unbalanced' | 'depth' | 'unknown' | 'cost' }

/** What `$'...'` spells: the escapes read as bash reads them. */
export function ansiC(text: string): string {
  return text.replace(
    /\\(x[0-9A-Fa-f]{1,2}|u[0-9A-Fa-f]{1,4}|U[0-9A-Fa-f]{1,8}|[0-7]{1,3}|c.|[\s\S])/g,
    (_, e: string) => {
      if (/^[xuU]/.test(e)) return String.fromCodePoint(parseInt(e.slice(1), 16))
      if (/^[0-7]/.test(e)) return String.fromCharCode(parseInt(e, 8) & 255)
      if (e[0] === 'c') return ''
      return (
        { a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' }[
          e
        ] ?? e
      )
    }
  )
}

/** What reading one command may cost (reading table A13): lists open at
 *  once (`n`), brace scans, and `steps` left - spent by the parser, the
 *  spellings, the wildcard matcher, the text floor and the path checks. A
 *  count, not a clock: the verdict is the same on every machine. The prices
 *  follow what takes time: a path check asks the file system, a wildcard is
 *  matched against every pattern, a command and an expansion are read; a
 *  word of plain text costs the parser nothing. */
export type Cost = { n: number; braces?: number; steps: number }
/** A command longer than this is not read. */
export const MAX_COMMAND = 100_000
/** The steps one command may take. The costliest command of the corpora
 *  (ordinary, mentions, the 3,768 recorded ones) takes under a tenth. */
export const MAX_STEPS = 40_000
export const newCost = (): Cost => ({ n: 0, steps: MAX_STEPS })
/** Spends steps; past the budget the command is unreadable. */
export function spend(cost: Cost | undefined, steps = 1): void {
  if (cost && (cost.steps -= steps) < 0) throw new Unreadable('cost')
}

export class Unreadable extends Error {
  constructor(readonly why: 'unbalanced' | 'depth' | 'unknown' | 'cost') {
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
// Matched on the lower-cased word: a file system that folds case runs `SH`.
const SHELL_PROGRAM = /^(?:.*\/)?(?:bash|sh|zsh|dash|ksh|mksh|ash|csh|tcsh|fish)$/
const isShell = (w: Word | undefined): boolean =>
  w?.literal != null && SHELL_PROGRAM.test(w.literal.toLowerCase())
/** A nested shell's option words that are read (see nestedOf): plain
 *  letters; plain letters ending in `o`, which takes a name; and the cluster
 *  holding `c`, after which the script stands. */
const SHELL_PLAIN = /^-[euxvlisfd]+$/
const SHELL_NAMED = /^-[euxvlisfd]*o$/
const SHELL_SCRIPT = /^-[euxvlisfd]*c[euxvlisfd]*$/
/** bash's long options that change neither the script word nor how words are read. */
const SHELL_LONG = new Set(['--norc', '--noprofile', '--login'])
/** A file argument that is the shell's input. */
const INPUT_FILE = /^(?:-|\/dev\/stdin|\/dev\/fd\/\d+)$/
/** Words before a program that are not it (zsh's `-` among them). */
const MODIFIERS = new Set(['builtin', 'command', 'exec', 'noglob', 'nocorrect', '-'])
const SHELL_NAMES = new Set(['pipefail', 'errexit', 'nounset', 'xtrace', 'verbose'])
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
  for (const w of words) {
    // Quoted text the shell may evaluate again (an arithmetic operand).
    out.push(...(w.again ?? []))
    for (const p of w.parts) {
      if (p.kind === 'subst' && p.list) out.push(p.list)
      else if (p.kind === 'arith') out.push(...(p.substs ?? []))
      else if (p.kind === 'param') out.push(...(p.substs ?? []), ...substsOf(p.operand ?? []))
    }
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
  const out = makeWord(parts, w.raw)
  if (w.again) out.again = w.again
  return out
}

/** A bracket expression read by the POSIX grammar (reading table A2), from
 *  its `[` at `i`: a `]` first in the list or after a backslash is a member;
 *  `[.x.]`, `[=x=]` and `[:class:]` are parts of it. `chars`: its members,
 *  when it is single characters and ranges whose two ends are both lower-case
 *  letters, both upper-case letters or both digits - a range of letters
 *  standing for them in both cases, as a collating locale folds them - and no
 *  more than 64; null for anything else (negated, a class, mixed ends): one
 *  character, whatever it is. Null result: no closing `]`, so the `[` is
 *  text. `word`: in a shell word, where a blank or an operator ends the word
 *  and a quoted run is members. */
export function bracket(
  s: string,
  i: number,
  word = false
): { end: number; chars: string[] | null } | null {
  // No `]` beyond a first member: text (and no scan of the rest for each `[`).
  if (s.indexOf(']', i + 2) === -1) return null
  let j = i + 1
  let exact = true
  if (s[j] === '!' || s[j] === '^') {
    exact = false
    j++
  }
  const chars = new Set<string>()
  const kind = (c: string) =>
    /^[a-z]$/.test(c) ? 'lower' : /^[A-Z]$/.test(c) ? 'upper' : /^[0-9]$/.test(c) ? 'digit' : null
  for (let first = true; j < s.length; first = false) {
    const c = s[j]!
    if (c === ']' && !first)
      return { end: j + 1, chars: exact && chars.size > 0 && chars.size <= 64 ? [...chars] : null }
    if (word && /[\s;&|()<>]/.test(c)) return null
    let member: string
    if (c === '[' && /[.=:]/.test(s[j + 1] ?? '') && s.indexOf(`${s[j + 1]}]`, j + 2) !== -1) {
      exact = false
      j = s.indexOf(`${s[j + 1]}]`, j + 2) + 2
      continue
    } else if (c === '\\' && j + 1 < s.length) {
      member = s[j + 1]!
      j += 2
    } else if (word && (c === "'" || c === '"')) {
      const end = s.indexOf(c, j + 1)
      if (end === -1) return null
      for (const m of s.slice(j + 1, end)) chars.add(m)
      j = end + 1
      continue
    } else {
      member = c
      j++
    }
    const to = s[j] === '-' && s[j + 1] !== undefined && s[j + 1] !== ']' ? s[j + 1]! : null
    if (to === null) chars.add(member)
    else {
      const high = to === '\\' && j + 2 < s.length ? s[j + 2]! : to
      // `[a-[.z.]]` and other ends the grammar has no exact reading for.
      if (kind(member) === null || kind(member) !== kind(high) || high < member || to === '[')
        exact = false
      else
        for (let code = member.charCodeAt(0); code <= high.charCodeAt(0); code++) {
          const ch = String.fromCharCode(code)
          chars.add(ch)
          if (kind(ch) !== 'digit') chars.add(ch.toLowerCase()).add(ch.toUpperCase())
        }
      if (to !== '[') j += to === '\\' ? 3 : 2
      else j++
    }
    if (chars.size > 64) exact = false
  }
  return null
}

/** Where the bracket or parenthesis opened at `i` closes (past it), with the
 *  ones inside it, quotes and backslashes passed over; -1 when it does not. */
function closes(s: string, i: number): number {
  const [open, close] = s[i] === '[' ? ['[', ']'] : ['(', ')']
  let depth = 0
  for (let j = i; j < s.length; j++) {
    const c = s[j]!
    if (c === '\\') j++
    else if (c === "'" || c === '"') {
      const end = s.indexOf(c, j + 1)
      if (end === -1) return -1
      j = end
    } else if (c === open) depth++
    else if (c === close && --depth === 0) return j + 1
  }
  return -1
}

/** Whether a here-document's delimiter is quoted, so the shell expands
 *  nothing in the body: by its text once backslash-newline is removed (a line
 *  continuation inside the delimiter quotes nothing). */
export const quotedDelimiter = (r: Redirect): boolean =>
  /['"\\]/.test((r.target?.raw ?? '').replace(/\\\n/g, ''))

/** Where the unescaped `d` at or after `i` stands; the text's length when there is none. */
function delimiter(s: string, i: number, d: string): number {
  let j = i
  while (j < s.length && s[j] !== d) j += s[j] === '\\' ? 2 : 1
  return Math.min(j, s.length)
}

/** A script word by its value (reading table A6): quotes and backslashes
 *  removed, ANSI-C quotes decoded, a part the shell fills in when the command
 *  runs read as empty. */
function valueOfScript(w: Word | readonly Part[]): string {
  return ('parts' in w ? w.parts : w)
    .map((p) => {
      switch (p.kind) {
        case 'param':
        case 'subst':
        case 'arith':
          return ''
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
    private readonly frames: Cost,
    /** The reader of the command itself: its words' places are kept. */
    private readonly top = false
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
      const from = this.i
      let to: number
      for (;;) {
        to = this.i
        if (this.i >= s.length) break
        const end = s.indexOf('\n', this.i)
        const line = s.slice(this.i, end === -1 ? s.length : end)
        this.i = end === -1 ? s.length : end + 1
        if ((h.strip ? line.replace(/^\t+/, '') : line) === h.delim) break
        body += (h.strip ? line.replace(/^\t+/, '') : line) + '\n'
      }
      h.r.body = body
      if (this.top) PLACE.set(h.r, [from, to])
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
      // In quoted text read again (A9): a process substitution, zsh's `=(`,
      // and bash's `${ cmd; }` are commands too.
      const more =
        quoted &&
        (/^[<>=]\(/.test(body.slice(k, k + 2)) || /^\$\{[ \t\n|]/.test(body.slice(k, k + 3)))
      if (!tick && !more && !(body[k] === '$' && body[k + 1] === '(')) continue
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
          r.backtick(parts, false)
          const p = parts[0]
          if (p?.kind === 'subst' && p.list) out.push(p.list)
        } else if (more && body[k] === '$') {
          const parts: Part[] = []
          r.dollar(parts, false)
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
    spend(this.frames)
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
    // Each command costs a fixed amount, whatever its words.
    spend(this.frames, 2)
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
      this.pending.push({ r, delim, strip: r.op === '<<-', quoted: quotedDelimiter(r) })
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
    this.nestedOf(simple)
    return simple
  }

  /** A script read exactly: the command a shell will run. One that does not
   *  parse makes the whole command unreadable (reading table A6). */
  private attach(simple: Simple, text: string): void {
    const list = parseAt(text, this.depth + 1, this.frames)
    if (!simple.nested) simple.nested = list
    else
      simple.nested = {
        items: [
          ...simple.nested.items,
          ...list.items.map((item, k) => (k === 0 ? { ...item, joinedBy: ';' as const } : item)),
        ],
      }
  }

  /** Text read as a script when it parses as one (reading table A5b, A8):
   *  whatever receives it - `$SHELL -c`, a shell under another name, a pipe -
   *  may run it. A parenthesised group in one of its words does not stop the
   *  reading: such text may be code of another language, full of calls, so
   *  the guard leaves a word that holds one to the floor and judges the rest
   *  (see isTextScript). Text that does not parse is left to the floor. */
  private reread(text: string): List[] {
    const frames = this.frames.n
    try {
      const list = parseAt(text, this.depth + 1, this.frames)
      TEXT_SCRIPTS.add(list)
      return [list]
    } catch (err) {
      if (!(err instanceof Unreadable) || err.why === 'cost') throw err
      this.frames.n = frames
      return []
    }
  }

  /** What a simple command hands to a shell (reading table A5-A7).
   *
   *  Every word that is a shell's name is read, not the first: behind any
   *  program that runs it, whatever that program's own arguments are (`env
   *  X=1 sh -c`, `xargs -I sh bash -c`). Which word is its script is not
   *  worked out by reading options as two shells do: only these shapes are
   *  read (each verified in bash, sh, zsh and dash: the script is the word
   *  after the cluster holding `c`, and none of the options changes how
   *  words are read):
   *    [--norc|--noprofile|--login]…  [-euxvlisfd]…  [-…o NAME]…  -[…]c[…]  SCRIPT  [args…]
   *  with NAME one of pipefail, errexit, nounset, xtrace, verbose. Without
   *  `-c` the shell runs a file, or - with no file, `-s`, `/dev/stdin` or
   *  `/dev/fd/N` - its input, which `deliver` reads once the whole command
   *  is. Any other shape that may still run a script given in the command is
   *  not guessed: the command is unreadable. */
  private nestedOf(simple: Simple): void {
    const { words, redirects } = simple
    // `eval` behind any command modifier and its options.
    let at = 0
    while (
      at < words.length &&
      (MODIFIERS.has(words[at]!.literal ?? '') ||
        (at > 0 && (words[at]!.literal ?? '').startsWith('-')))
    )
      at++
    // zsh: a module can give any parameter any meaning (`$mapfile[name]` is a
    // file's contents): not read, so the command is unreadable (A10).
    if (words[at]?.literal === 'zmodload') throw new Unreadable('unknown')
    if (words[at]?.literal === 'eval') {
      const args = words.slice(at + 1).map((w) => w.literal)
      if (args.length > 0 && args.every((a) => a !== null)) this.attach(simple, args.join(' '))
      return
    }
    for (let k = 0; k < words.length; k++) {
      if (!isShell(words[k])) continue
      let j = k + 1
      let known = true
      let scripted = false
      let input = false
      let letters = false
      const optionWithC = (x: Word | undefined) => /^[-+][A-Za-z0-9]*c/.test(x?.literal ?? '')
      const here = redirects.some((r) => r.op.startsWith('<<'))
      for (; j < words.length; j++) {
        const w = words[j]!.literal
        if (w !== null && SHELL_SCRIPT.test(w)) {
          scripted = true
          j++
          break
        }
        if (w !== null && !letters && SHELL_LONG.has(w)) continue
        if (w !== null && SHELL_PLAIN.test(w)) {
          letters = true
          // `-s`: the script is the input, whatever words follow.
          input ||= w.includes('s')
          continue
        }
        if (w !== null && SHELL_NAMED.test(w) && SHELL_NAMES.has(words[j + 1]?.literal ?? '')) {
          letters = true
          j++
          continue
        }
        // `--` and `-` end the options (bash, zsh, sh and dash: the words
        // after them are the file to run and its arguments, never options;
        // `curl ... | bash -`, `... | sh -s -- -y`). With a word that could
        // be `-c` after them, or the shell's input given here, the shells
        // are not read: the word stays outside the shapes.
        if ((w === '--' || w === '-') && !here && !words.slice(j + 1).some(optionWithC)) {
          j++
          const file = words[j]?.literal
          input ||= file != null && INPUT_FILE.test(file)
          break
        }
        // A file to run, or a word outside the shapes above.
        known = w !== null && !/^[-+]/.test(w)
        input ||= w !== null && w !== '-' && INPUT_FILE.test(w)
        break
      }
      // An option word outside the shapes with a `-c` word at or after it,
      // or with the shell's input given here; and a word after `-c` that is
      // itself an option (the shells go on reading options there).
      if (!known && (here || words.slice(j).some(optionWithC))) throw new Unreadable('unknown')
      // The same shell may still be handed a script on a pipe, by a redirect
      // or by an earlier `exec <`: known once the whole command is read.
      if (!known) OPTION_UNKNOWN.add(simple)
      if (scripted && /^[-+]/.test(words[j]?.literal ?? '')) throw new Unreadable('unknown')
      // The script word by its value: a part the shell fills in is empty
      // there, never a reason to skip the word.
      // A word with nothing written in it is not a script the command gives (limit L1).
      const script = scripted && words[j] ? valueOfScript(words[j]!) : ''
      if (script !== '') this.attach(simple, script)
      else if (!scripted && known && (input || j === words.length)) READS_INPUT.add(simple)
    }
  }

  /** What a command writes to a pipe, when the command says it: `echo`'s
   *  arguments and the here-documents of `cat`. `printf` with a `%` or a
   *  backslash and `echo` with one (zsh's reads `\xNN` unasked; bash's with
   *  `-e`) compose the text: unreadable. Any other program: not in the
   *  command (limit L6). */
  private writes(stage: Simple): string[] {
    const program = stage.words[0]?.literal
    const values = stage.words.slice(1).map(valueOfScript)
    if (program === 'echo') {
      let from = 0
      while (/^-[neE]+$/.test(values[from] ?? '')) from++
      if (
        values.slice(0, from).some((v) => v.includes('e')) ||
        values.some((v) => v.includes('\\'))
      )
        throw new Unreadable('unknown')
      return [values.slice(from).join(' ')]
    }
    if (program === 'printf') {
      if (values.some((v) => /[%\\]/.test(v))) throw new Unreadable('unknown')
      return values.slice(0, 1)
    }
    if (program === 'cat' && stage.words.length === 1) return this.inputs(stage.redirects)
    // `tee` writes its input on, whatever files it is given.
    if (program === 'tee') return this.inputs(stage.redirects)
    return []
  }

  /** The text of each here-string and here-document among redirections. */
  private inputs(redirects: readonly Redirect[]): string[] {
    const out: string[] = []
    for (const r of redirects) {
      if (r.op === '<<<' && r.target) out.push(valueOfScript(r.target))
      else if ((r.op === '<<' || r.op === '<<-') && r.body !== undefined)
        // Under a plain delimiter the shell takes a backslash off `$`, a
        // backtick and a backslash before the script is the shell's input.
        out.push(quotedDelimiter(r) ? r.body : r.body.replace(/\\([$`\\\n])/g, '$1'))
    }
    return out
  }

  /** How a script reaches a shell that reads its input (reading table A7),
   *  once the whole command is read: each here-string and here-document on
   *  the shell's own command and on every compound command around it
   *  (`around`), the input of an earlier `exec <<<` in the same list, and
   *  what the earlier stages of its pipeline write (`fed`). */
  private deliver(l: List, around: readonly Redirect[], fed: readonly Simple[]): void {
    let exec: Redirect[] = []
    /** `exec > >(...)`: every command after it writes into the substitution. */
    const sinks: { list: List; after: Simple[] }[] = []
    for (const { node: pipeline } of l.items) {
      const earlier: Simple[] = [...fed]
      for (const stage of pipeline.stages) {
        this.deliverTo(stage, [...around, ...exec], earlier)
        for (const sink of sinks) sink.after.push(...simplesIn(stage))
        if (stage.type !== 'simple') {
          earlier.push(SOME_STAGE)
          continue
        }
        earlier.push(stage)
        // `exec` with redirections only, also behind a modifier (`command exec`).
        const literals = stage.words.map((w) => w.literal ?? '')
        if (literals.includes('exec') && literals.every((w) => MODIFIERS.has(w))) {
          exec = [...exec, ...stage.redirects.filter((r) => r.op.startsWith('<'))]
          for (const list of sinksOf([], stage.redirects)) sinks.push({ list, after: [] })
        }
      }
    }
    for (const sink of sinks) if (sink.after.length > 0) this.deliver(sink.list, [], sink.after)
  }

  private deliverTo(n: Node, around: readonly Redirect[], fed: readonly Simple[]): void {
    // A here-document's body, whatever it is given to.
    if (n.type !== 'function')
      for (const r of n.redirects)
        if (r.op !== '<<<') {
          const again = this.inputs([r]).flatMap((text) => this.reread(text))
          if (again.length > 0) r.again = again
        }
    const inside = (l: List | null, redirects: readonly Redirect[] = []) => {
      if (l) this.deliver(l, [...around, ...redirects.filter((r) => r.op.startsWith('<'))], fed)
    }
    // What a compound command writes into `>(...)` on its redirections.
    if (n.type !== 'simple' && n.type !== 'function') {
      const writers = simplesIn(n)
      for (const l of sinksOf([], n.redirects)) this.deliver(l, [], writers)
    }
    switch (n.type) {
      case 'simple': {
        // A shell with an option the reader does not know, where a script
        // may reach it by its input: a pipe, a redirect on it or around it,
        // an earlier `exec <` (reading table §2a, last row).
        if (
          OPTION_UNKNOWN.has(n) &&
          (fed.length > 0 ||
            around.length > 0 ||
            n.redirects.some((r) => r.op.startsWith('<')) ||
            // A script file that is a substitution written in the command.
            n.words.some((w) => w.parts.some((p) => p.kind === 'subst' && p.file)))
        )
          throw new Unreadable('unknown')
        if (READS_INPUT.has(n)) {
          const texts = [
            ...this.inputs(n.redirects),
            ...this.inputs(around),
            ...fed.flatMap((stage) => this.writes(stage)),
          ]
          for (const text of texts) this.attach(n, text)
        }
        // The commands inside its words: a pipeline in a substitution. What
        // the command writes into `>(...)`, the commands there read (A7).
        const sinks = new Set(sinksOf(n.words, n.redirects))
        for (const l of listsIn([n.assigns, n.words, n.redirects]))
          this.deliver(l, [], sinks.has(l) ? [n] : [])
        return
      }
      case 'subshell':
      case 'group':
        return inside(n.list, n.redirects)
      case 'if':
        for (const b of n.branches) {
          inside(b.cond, n.redirects)
          inside(b.body, n.redirects)
        }
        return inside(n.else, n.redirects)
      case 'loop':
        inside(n.cond, n.redirects)
        inside(n.body, n.redirects)
        for (const l of listsIn([n.words, n.redirects])) this.deliver(l, [], [])
        return
      case 'case':
        for (const arm of n.arms) inside(arm, n.redirects)
        for (const l of listsIn([n.word, n.redirects, n.substs])) this.deliver(l, [], [])
        return
      case 'function':
        return this.deliverTo(n.body, [], [])
    }
  }

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
      else if (c === '`') this.backtick(parts, false)
      else if (c === '*' || c === '?') take({ kind: 'glob', text: c }, 1)
      else if (c === '[') {
        // A bracket expression, by the POSIX grammar; with no closing `]`, text.
        const b = bracket(s, this.i, true)
        if (b) take({ kind: 'glob', text: s.slice(this.i, b.end) }, b.end - this.i)
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
        // (An array's words hold no group and no `|`: `if=((.e)nv)` is a group.)
        const array =
          ends &&
          parts.length === 1 &&
          parts[0]!.kind === 'lit' &&
          /^\w+\+?=$/.test(s.slice(start, this.i)) &&
          !/[(|]/.test(text.slice(1, -1))
        if (!array && text.length > 2) {
          // A group is any text in its place, at any depth, also when it is
          // the whole word (`((.e)nv)`).
          const last = parts[parts.length - 1]
          const alone = parts.length === 0
          let grouped = false
          let star = false
          // `!(x)` matches what `*` matches, and no leading dot.
          const negation = last?.kind === 'lit' && !last.quoted && last.text.endsWith('!')
          if (negation) {
            last.text = last.text.slice(0, -1)
            if (last.text === '') parts.pop()
            parts.push({ kind: 'glob', text: '*' })
            this.i = end
            continue
          }
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
          else if (!grouped && !alone && ends && !/[|(~]/.test(text.slice(1, -1)))
            part.qualifier = true
          // Plain alternatives (letters, digits, `_`, `.`, `-`): read exactly.
          // One alone (`(N)`) is that text, or - a qualifier, where a program
          // cuts the word into pieces - nothing.
          else if (!grouped && /^[\w.-]*(?:\|[\w.-]*)*$/.test(text.slice(1, -1))) {
            const inner = text.slice(1, -1)
            part.alternatives = inner.includes('|') ? inner.split('|') : [inner, '']
          }
          if (grouped) part.prefixed = true
          // A qualifier that puts text into the name or runs code: `e`, `+`,
          // `P`, and every `:` modifier but `:t`, `:h`, `:a` and `:A`, which
          // give back a part, or the absolute form, of a name the word matched.
          const [filters, ...modifiers] = text.slice(1, -1).split(':')
          if (
            (part.star || part.qualifier) &&
            (/[eP+]/.test(filters!) || modifiers.some((m) => !/^[thaA]$/.test(m)))
          )
            part.rewrites = true
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
        parts.push(
          c === '>' ? { kind: 'subst', list, into: true } : { kind: 'subst', list, file: true }
        )
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
    // A word costs what its parts do. One that is a single piece of plain
    // text costs nothing: reading it takes no time worth counting, and long
    // plain text (a here-document, a message, a list of paths) is ordinary.
    if (parts.length > 1 || parts[0]!.kind !== 'lit') spend(this.frames, 4 + parts.length)
    const w = makeWord(parts, s.slice(start, this.i))
    if (this.top) PLACE.set(w, [start, this.i])
    const again = this.writtenAgain(parts)
    if (again.length > 0) w.again = again
    return w
  }

  /** The commands of each substitution written inside quotes or after a
   *  backslash (reading table A9): the shell evaluates such text again in
   *  more places than can be listed. One that cannot be read is passed over;
   *  the text floor judges it. */
  private writtenAgain(parts: Part[]): List[] {
    const out: List[] = []
    let run = ''
    let quoted = false
    const flush = () => {
      if (quoted && /\$[({]|`|[<>=]\(/.test(run)) out.push(...this.bodySubsts(run, true))
      run = ''
      quoted = false
    }
    for (const p of parts) {
      if (p.kind === 'lit') {
        run += p.text
        quoted ||= p.quoted
      } else if (p.kind === 'glob' || p.kind === 'brace' || p.kind === 'zglob') run += p.text
      else if (p.kind === 'ansic' && p.text.startsWith("$'")) {
        run += ansiC(p.text.slice(2, -1))
        quoted = true
      } else flush()
    }
    flush()
    // The whole text too, when a shell reading it again would read it
    // differently (quotes, escapes, several words): whatever hands it to a
    // shell - a pipe, a program that is one under another name - the script
    // is read as the word after `-c` is (A5b), where it parses as one.
    if (parts.some((p) => (p.kind === 'lit' && p.quoted) || p.kind === 'ansic')) {
      const text = valueOfScript(parts)
      if (/[\s'"\\$`]/.test(text)) out.push(...this.reread(text))
      // And as `echo -e`, zsh's `echo` or `printf` would write it.
      if (/\\(?:x[0-9A-Fa-f]|[0-7]|u[0-9A-Fa-f])/.test(text)) out.push(...this.reread(ansiC(text)))
    }
    return out
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
        else this.backtick(parts, true)
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
    if (next === '[') {
      // Old arithmetic: `$[...]` is `$((...))`.
      const end = closes(s, this.i + 1)
      if (end !== -1) {
        const text = s.slice(this.i, end)
        const substs = substsOf(this.inner(text.slice(2, -1)))
        parts.push(substs.length > 0 ? { kind: 'arith', text, substs } : { kind: 'arith', text })
        this.i = end
        return
      }
    }
    if (next === '(') {
      this.i += 2
      const list = this.list(new Set([')']))
      this.expect(')')
      parts.push(quoted ? { kind: 'subst', list, quoted } : { kind: 'subst', list })
    } else if (next === '{') {
      let depth = 0
      let j = this.i + 1
      for (; j < s.length; j++) {
        if (s[j] === '\\') j++
        else if (s[j] === '{') depth++
        else if (s[j] === '}' && --depth === 0) break
      }
      if (j >= s.length) throw new Unreadable('unbalanced')
      parts.push(this.expansion(s.slice(this.i + 2, j), quoted))
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
        parts.push(
          quoted
            ? { kind: 'param', name: m[0], op: '', quoted }
            : { kind: 'param', name: m[0], op: '' }
        )
        this.i += 1 + m[0].length
      } else {
        parts.push({ kind: 'lit', text: '$', quoted })
        this.i++
      }
    }
  }

  /** What stands between `${` and `}`, read by one grammar (reading table
   *  A1): something before the name, the name, subscripts, an operator and
   *  its operands. Each operand is read as words: text the expansion can put
   *  into the word is one more spelling of it (`operand`); a subscript, a
   *  pattern, an offset or a length is read for the commands inside it
   *  (`substs`). Text the grammar does not account for is unreadable. */
  private expansion(inner: string, quoted: boolean): Part {
    // bash 5.3: `${ cmd; }` and `${|cmd;}` run commands.
    if (/^[ \t\n|]/.test(inner)) {
      if (++this.frames.n > MAX_FRAMES) throw new Unreadable('depth')
      const list = new Reader(inner.slice(1), this.depth, this.frames).read()
      this.frames.n--
      return quoted ? { kind: 'subst', list, quoted } : { kind: 'subst', list }
    }
    // The name and what follows it, as the cd rules read them.
    const m = /^[#!]?(?:[A-Za-z_][A-Za-z0-9_]*|\d+|[@*#?$!-])/.exec(inner)
    const name = m ? m[0].replace(/^[#!](?=.)/, '') : ''
    const op = inner.slice(m ? m[0].length : 0)
    const named: Word[] = []
    const substs: List[] = []
    const read = (text: string) => {
      if (text !== '') substs.push(...substsOf(this.operand(text, quoted)))
    }
    let k = 0
    // zsh: flags, and `~`, `=`, `^`, `+` before the name.
    let prefixed = false
    for (;;) {
      if (inner[k] === '(') {
        const end = closes(inner, k)
        if (end === -1) throw new Unreadable('unknown')
        read(inner.slice(k + 1, end - 1))
        k = end
      } else if (/[~=^+]/.test(inner[k] ?? '')) k++
      else break
      prefixed = true
    }
    // `#` (a length) and `!` (another variable's name) before a name.
    const indirect = inner[k] === '!'
    if (/[#!]/.test(inner[k] ?? '') && /[A-Za-z_0-9@*#?$!"'-]/.test(inner[k + 1] ?? '')) k++
    if (inner[k] === '$' && /[{(]/.test(inner[k + 1] ?? '')) {
      // zsh: an expansion standing where the name does.
      if (++this.frames.n > MAX_FRAMES) throw new Unreadable('depth')
      const r = new Reader(inner.slice(k), this.depth, this.frames)
      const inside: Part[] = []
      r.dollar(inside, quoted)
      this.frames.n--
      named.push(makeWord(inside, inner.slice(k, k + r.i)))
      k += r.i
    } else if (inner[k] === '"' || (inner[k] === "'" && !quoted)) {
      // zsh: a quoted string where the name stands.
      if (++this.frames.n > MAX_FRAMES) throw new Unreadable('depth')
      const r = new Reader(inner.slice(k), this.depth, this.frames)
      const inside: Part[] = []
      if (inner[k] === '"') r.double(inside)
      else {
        const end = inner.indexOf("'", k + 1)
        if (end === -1) throw new Unreadable('unknown')
        inside.push({ kind: 'lit', text: inner.slice(k + 1, end), quoted: true })
        r.i = end - k + 1
      }
      this.frames.n--
      named.push(makeWord(inside, inner.slice(k, k + r.i)))
      k += r.i
      prefixed = true
    } else k += /^(?:[A-Za-z_][A-Za-z0-9_]*|\d+|[@*#?$!-])?/.exec(inner.slice(k))![0].length
    // `${!prefix*}` and `${!prefix@}`: the names that start so.
    if (indirect && /^[*@]$/.test(inner.slice(k))) k++
    while (inner[k] === '[') {
      const end = closes(inner, k)
      if (end === -1) throw new Unreadable('unknown')
      read(inner.slice(k + 1, end - 1))
      k = end
    }
    const rest = inner.slice(k)
    // Text the expansion can put into the word.
    let text: string | null = null
    // More than one operator, one of them holding text: it may be rewritten.
    let chained = false
    let o: RegExpExecArray | null
    if (rest === '' || /^@[A-Za-z]+$/.test(rest)) {
      // The value alone, or bash's `${x@Q}`.
    } else if ((o = /^(?:::=|:?[-=+?])/.exec(rest))) text = rest.slice(o[0].length)
    else if ((o = /^(?:##?|%%?|\^\^?|,,?|~~?)/.exec(rest))) read(rest.slice(o[0].length))
    else if ((o = /^:?\/[/#%]?/.exec(rest))) {
      // `/pat/TEXT`, `//`, `/#`, `/%`, zsh `:/`: the pattern is not text.
      const at = delimiter(rest, o[0].length, '/')
      read(rest.slice(o[0].length, at))
      if (at < rest.length) text = rest.slice(at + 1)
    } else if (rest[0] === ':') {
      // An offset and a length, or zsh's modifiers; of those `:s` and `:gs`
      // hold text, between any delimiter that is not a letter or a digit.
      const sub = /:g?s([^A-Za-z0-9\s])/.exec(rest)
      if (!sub) read(rest.slice(1))
      else {
        const d = sub[1]!
        const from = sub.index + sub[0].length
        const mid = delimiter(rest, from, d)
        const end = delimiter(rest, mid + 1, d)
        read(rest.slice(1, sub.index))
        read(rest.slice(from, mid))
        if (mid < rest.length) text = rest.slice(mid + 1, end)
        const tail = rest.slice(end + 1)
        read(tail.replace(/^:/, ''))
        chained = sub.index > 0 || tail !== ''
      }
    } else throw new Unreadable('unknown')
    const operand = [...named, ...(text !== null ? this.operand(text, quoted) : [])]
    const part: Part = { kind: 'param', name, op }
    if (text !== null || named.length > 0) part.operand = operand
    if (substs.length > 0) part.substs = substs
    if (quoted) part.quoted = true
    if ((prefixed || chained || (named.length > 0 && rest !== '')) && holdsText(operand))
      part.transforms = true
    return part
  }

  private backtick(parts: Part[], quoted: boolean): void {
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
    const list = r.read()
    parts.push(quoted ? { kind: 'subst', list, quoted } : { kind: 'subst', list })
  }

  /** The whole text. */
  read(): List {
    return this.all()
  }

  /** The whole text of a script, and how scripts reach the shells in it. */
  script(): List {
    const l = this.all()
    this.deliver(l, [], [])
    return l
  }
}

/** Where a word of the command itself, or a here-document's body, stands in
 *  the command's text (not kept for text read again: a nested script, a
 *  written value). */
const PLACE = new WeakMap<object, [from: number, to: number]>()
export const placeOf = (x: Word | Redirect): [from: number, to: number] | undefined => PLACE.get(x)

/** Text read again as a script because whatever receives it may run it
 *  (see Reader.reread): it may as well be code of another language. */
const TEXT_SCRIPTS = new WeakSet<object>()
export const isTextScript = (x: object): boolean => TEXT_SCRIPTS.has(x)

/** A shell that reads its input as its script. */
const READS_INPUT = new WeakSet<Simple>()
/** A shell given an option outside the shapes that are read (see nestedOf). */
const OPTION_UNKNOWN = new WeakSet<Simple>()
/** A stage of a pipeline that is not one command: it feeds the next stage
 *  something the reader does not take for text. */
const SOME_STAGE: Simple = { type: 'simple', assigns: [], words: [], redirects: [] }

/** The lists of the `>(...)` substitutions among a command's words and
 *  redirect targets: what the command writes there, they read. */
function sinksOf(words: readonly Word[], redirects: readonly Redirect[]): List[] {
  const out: List[] = []
  for (const w of [...words, ...redirects.map((r) => r.target)])
    for (const p of w?.parts ?? []) if (p.kind === 'subst' && p.into && p.list) out.push(p.list)
  return out
}

/** Every simple command under a node (the commands of a group, a loop). */
function simplesIn(x: unknown, out: Simple[] = []): Simple[] {
  if (Array.isArray(x)) for (const e of x) simplesIn(e, out)
  else if (x !== null && typeof x === 'object') {
    if ((x as Simple).type === 'simple') out.push(x as Simple)
    for (const [k, v] of Object.entries(x)) if (k !== 'nested' && k !== 'again') simplesIn(v, out)
  }
  return out
}

/** The lists the same reader read inside words and redirections: the
 *  commands of substitutions, at any depth of written values. A nested
 *  shell's script was read, and delivered, by a reader of its own. */
function listsIn(x: unknown): List[] {
  const out: List[] = []
  const visit = (v: unknown, key?: string): void => {
    if (key === 'nested' || key === 'again') return
    if (Array.isArray(v)) return v.forEach((e) => visit(e))
    if (v === null || typeof v !== 'object') return
    if (Array.isArray((v as List).items)) return void out.push(v as List)
    for (const [k, e] of Object.entries(v)) visit(e, k)
  }
  visit(x)
  return out
}

function parseAt(text: string, depth: number, frames: Cost): List {
  if (depth > MAX_DEPTH) throw new Unreadable('depth')
  return new Reader(text, depth, frames).script()
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
    private readonly frames: Cost
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
export function parseShell(
  command: string,
  dialect: 'sh' | 'ps',
  cost: Cost = newCost()
): ParseResult {
  if (command.length > MAX_COMMAND) return { ok: false, why: 'cost' }
  try {
    if (dialect === 'ps') return { ok: true, list: new PsReader(command, cost).read() }
    return { ok: true, list: new Reader(command, 0, cost, true).script() }
  } catch (err) {
    if (err instanceof Unreadable) return { ok: false, why: err.why }
    throw err
  }
}
