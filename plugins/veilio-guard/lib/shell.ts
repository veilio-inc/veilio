// How a shell command is read before a placeholder is put back into it
// (spec 078 research R1).
//
// Ported unchanged from spec 069's placeholder-named links (CE
// feat/069-guard-core 346d167, packages/guard/src/placeholder-links.ts), where
// it passed four security reviews: one parser for both, so the Copilot
// adapter imports this file when 069 rebases (spec 078 research R9).

// The commands that may name a file by its placeholder (code review): test
// runners and read-only commands, as the start of every command in a chain.
const READS_OR_TESTS = [
  /^npx vitest\b/,
  /^npm (run )?test\b/,
  /^(pnpm|yarn)( run)? test\b/,
  /^python3? -m (unittest|pytest)\b/,
  /^pytest\b/,
  /^go test\b/,
  /^cargo test\b/,
  /^mvn( -\S+)* test\b/,
  /^ruby -Itest\b/,
  /^rake test\b/,
  /^(cat|head|tail|wc|ls|grep|rg|find)\b/,
  /^git (diff|status|log|show)\b/,
  /^node --test\b/,
]
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
      /^--(pre|pre-glob|search-zip|hostname-bin|hyperlink-format)(=|$)/.test(word) ||
      /^-[A-Za-z]*z/.test(word)
    )
  if (program === 'git') return /^--(output|ext-diff|textconv)(=|$)/.test(word) || word === '-c'
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
    const cmd = words.join(' ')
    if (cmd && !READS_OR_TESTS.some((r) => r.test(cmd)))
      return `a command that names a file by its placeholder may only read or test it, and ${cmd.split(/\s+/)[0]} is not one of those`
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
const GIT_NETWORK = new Set(['push', 'fetch', 'clone', 'pull', 'ls-remote', 'remote', 'submodule'])

/** Spec 078 R1: flags of a reader that slice or reshape what it prints, on
 *  top of 069's flags that write or run. */
function reshapes(program: string, word: string): boolean {
  if (program === 'grep') return /^--only-matching$/.test(word) || /^-[A-Za-z]*o/.test(word)
  if (program === 'rg')
    return /^--(replace|only-matching)(=|$)/.test(word) || /^-[A-Za-z]*[ro]/.test(word)
  if (program === 'head' || program === 'tail')
    return /^--bytes(=|$)/.test(word) || /^-c/.test(word)
  if (program === 'find') return /^-f?printf$/.test(word)
  if (program === 'git') return /^--(format|pretty)(=|$)/.test(word)
  return false
}

const READS =
  'a shell command gets real names back only when it reads files or runs tests (cat, head, tail, grep, rg, ls, find, wc, git diff/log/show/status, a test runner)'
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
  for (const w of words) {
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
    const cmd = w.join(' ')
    if (cmd && !READS_OR_TESTS.some((r) => r.test(cmd)))
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
function outsideQuotes(command: string): string {
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
