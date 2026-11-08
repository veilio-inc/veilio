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
// Review round 4b #2: vitest's commands other than run (init installs
// packages). Refused as any positional word, wherever the options put it.
const VITEST_COMMANDS = new Set([
  'init',
  'bench',
  'doctor',
  'list',
  'watch',
  'dev',
  'related',
  'typecheck',
])
const RUNNERS: readonly [readonly string[], Allowed, ReadonlySet<string>?][] = [
  [['npx', 'vitest'], VITEST, VITEST_COMMANDS],
  [['vitest'], VITEST, VITEST_COMMANDS],
  [['node_modules/.bin/vitest'], VITEST, VITEST_COMMANDS],
  [['./node_modules/.bin/vitest'], VITEST, VITEST_COMMANDS],
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

/** Whether every option in `rest` is on `allowed`, and no positional word is
 *  one of the runner's `commands` that is not a test run. */
function onlyAllowed(
  rest: readonly string[],
  allowed: Allowed,
  commands?: ReadonlySet<string>
): boolean {
  for (let i = 0; i < rest.length; i++) {
    const w = rest[i]!
    if (!w.startsWith('-')) {
      if (commands?.has(w)) return false
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
  for (const [start, allowed, commands] of RUNNERS)
    if (start.every((w, i) => words[i] === w))
      return onlyAllowed(words.slice(start.length), allowed, commands)
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
