// Files the model must never read (spec 033, FR-004).
//
// Refused before the tool runs, on the path the model wrote and on the path
// after its placeholders are restored. A project adds patterns in
// .veilio/guard.json or the plugin's settings; it cannot remove these.
//
// For shell commands this is a check on the words of the command, not a
// sandbox: `cat .env` is refused, a script that opens .env is not. The
// coverage statement says so; strict mode (a later spec) is the answer to it.

// The list and its matcher live in the engine (spec 078 FR-016), shared with
// the MCP server.
export {
  DEFAULT_RAW_ONLY,
  isRawOnly,
  rawOnlyOf,
  shortNameAlias,
  windowsAlias,
} from '../vendor/engine/index.js'
import { outsideQuotes, shellExpands, shellWords, splitChain } from './shell.ts'

/** The words of a shell command that could name a file: unquoted, split on
 *  whitespace, shell operators, braces and commas, and each piece around `=`
 *  and `:` checked too: a flag's or assignment's value (`--env-file=.env`,
 *  `FOO=.env`, PowerShell's `-Path:.env`) and an NTFS stream (`.env::$DATA`).
 *  Braces and commas cover a PowerShell script block and argument list
 *  (`{gc .env}`, `gc a,.env`). Flags themselves are dropped.
 *
 *  A check on the words as written, not a shell: quoting inside a word,
 *  escapes, brace expansion and wildcards are not expanded (COVERAGE.md). */
export function pathsInCommand(command: string): string[] {
  const words = new Set<string>()
  const add = (w: string) => {
    const word = w.replace(/^['"]+|['"]+$/g, '')
    if (word !== '' && !word.startsWith('-')) words.add(word)
  }
  for (const token of command.split(/[\s|&;<>()`$,{}]+/)) {
    add(token)
    for (const piece of token.split(/[=:]+/)) add(piece)
  }
  return [...words]
}

// ── spec 078 R4: `..` and cd ──────────────────────────────────────────────

/** A path with `.` dropped and `x/..` collapsed, as the file system would
 *  read it; a leading `..`, `/` or `~` is kept. */
export function normalisePath(path: string): string {
  const p = path.replace(/\\/g, '/')
  const absolute = p.startsWith('/')
  const out: string[] = []
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue
    if (
      part === '..' &&
      out.length > 0 &&
      out[out.length - 1] !== '..' &&
      out[out.length - 1] !== '~'
    )
      out.pop()
    else if (part === '..' && absolute && out.length === 0) continue
    else out.push(part)
  }
  const joined = out.join('/')
  return absolute ? `/${joined}` : joined || '.'
}

/** The directories a cd may not enter: the directory part of every pattern
 *  with a slash, and each of its leading parts (`.config/gcloud/**` gives
 *  `.config/gcloud` and `.config`). Derived, so a project's `secrets/**`
 *  gives `secrets`. */
export function rawOnlyDirectories(patterns: readonly string[]): string[] {
  const dirs = new Set<string>()
  for (const pattern of patterns) {
    if (!pattern || pattern.startsWith('!') || !pattern.includes('/')) continue
    // `dir/**` names everything in dir: dir is the directory, not its parent.
    const dir = pattern
      .replace(/\\/g, '/')
      .replace(/\/\*\*$/, '/x')
      .split('/')
      .filter((x) => x !== '' && x !== '.' && x !== '**')
      .slice(0, -1)
    for (let i = 1; i <= dir.length; i++) dirs.add(dir.slice(0, i).join('/'))
  }
  return [...dirs]
}

/** One directory of a pattern (`*` and `?` as in a glob) against one of a path. */
function part(pattern: string, name: string): boolean {
  if (!/[*?]/.test(pattern)) return pattern === name
  const re = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
  return new RegExp(`^${re}$`).test(name)
}

const CD_PROGRAMS = new Set(['cd', 'pushd', 'chdir', 'set-location', 'sl', 'push-location'])

/** PowerShell reads `\` as a separator, never an escape (its escape is the
 *  backtick): its commands are read with `/` for it (review round 4 #3). */
const asWritten = (command: string, powershell: boolean) =>
  powershell ? command.replace(/\\/g, '/') : command.replace(/\\\r?\n/g, ' ')

/** The targets of every cd or pushd in a command, wherever it stands: after
 *  `&&`, `||`, `;`, `|`, a lone `&` or a newline, or inside a subshell. */
export function cdTargets(command: string, powershell = false): string[] {
  command = asWritten(command, powershell)
  const targets: string[] = []
  for (const piece of command.split(/\r?\n|(?<!&)&(?!&)/)) {
    const chain = splitChain(piece)
    const parts = chain ? chain.map((p) => shellWords(p)) : [piece.split(/\s+/)]
    for (const raw of parts) {
      const words = (raw ?? piece.split(/\s+/)).map((w) => w.replace(/^[({]+|[)}]+$/g, ''))
      let k = 0
      while (
        k < words.length &&
        (words[k] === '' || words[k] === 'builtin' || words[k] === 'command')
      )
        k++
      // A module-qualified cmdlet is the cmdlet (round 5 #4); `\` is `/` here.
      if (!CD_PROGRAMS.has((words[k] ?? '').replace(MODULE, '').toLowerCase())) continue
      const target = words.slice(k + 1).find((w) => w !== '' && !(w.startsWith('-') && w !== '-'))
      if (target !== undefined && target !== '-') targets.push(target)
    }
  }
  return targets
}

/** Every cd target, the ones the chain split cannot see included: inside
 *  `$(...)`, backticks, `bash -c '...'` or `eval "..."` (review round 1 of
 *  spec 078). Read over the whole command, quotes ignored. */
export function allCdTargets(command: string, powershell = false): string[] {
  command = asWritten(command, powershell)
  // A target may be quoted, and follow `--` (review round 2 of spec 078) or,
  // in PowerShell, `-Path`/`-LiteralPath` (review round 4 #3).
  const programs = powershell ? 'cd|pushd|chdir|set-location|sl|push-location' : 'cd|pushd|chdir'
  const hidden = [
    ...command.matchAll(
      new RegExp(
        `(?:^|[\\s;&|(\`'"$${powershell ? '/' : ''}])(?:${programs})\\s+(?:(?:-[A-Za-z@]+|--)\\s+)*['"]?([^\\s;&|)'"\`]+)`,
        powershell ? 'gi' : 'g'
      )
    ),
  ].map((m) => m[1]!)
  return [...new Set([...cdTargets(command), ...hidden])]
}

/** The cd targets written in quotes that keep them as written - single
 *  quotes with no quote inside, or double quotes with none of `$`, a
 *  backtick, `!` or (outside PowerShell) `\` - unquoted (review round 4 #4). */
export function literalCdTargets(command: string, powershell = false): Set<string> {
  const programs = powershell ? 'cd|pushd|chdir|set-location|sl|push-location' : 'cd|pushd|chdir'
  const out = new Set<string>()
  const re = new RegExp(
    `(?:^|[\\s;&|(])(?:${programs})\\s+(?:(?:-[A-Za-z@]+|--)\\s+)*(?:'([^']*)'|"([^"]*)")(?=$|[\\s;&|)])`,
    powershell ? 'gi' : 'g'
  )
  for (const m of command.matchAll(re)) {
    if (m[1] !== undefined) out.add(asWritten(m[1], powershell))
    else if (!(powershell ? /[$`!]/ : /[$`!\\]/).test(m[2]!)) out.add(asWritten(m[2]!, powershell))
  }
  return out
}

/** Wrappers that run the next word as a program: only `builtin` and
 *  `command` may stand before a followed cd (review round 5). */
const WRAPPERS = new Set(['builtin', 'command', 'env', 'exec', 'nohup', 'sudo', 'nice'])
/** Shell words that may stand before a command and run it (round 5 #2). */
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', 'time', '!'])
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/
/** A redirection operator alone (`>`, `2>`, `>>`, `<`), whose file is the next word. */
const REDIRECT_ALONE = /^(?:\d*|&)?[<>]{1,2}$/
/** A redirection with its file or descriptor in the same word (`>/dev/null`, `2>&1`). */
const REDIRECT = /^(?:\d*|&)?[<>]{1,2}&?./
/** PowerShell common parameters that take a value (`-ErrorAction Stop`). */
const PS_VALUED = /^-(?:\w*Action|\w*Variable|OutBuffer|StackName)$/i
/** A module-qualified cmdlet (`Microsoft.PowerShell.Management\Set-Location`). */
const MODULE = /^[\w.]+\//

/** A command as the shell reads its words: quotes and backslashes removed
 *  (round 5b), word by word, joined by spaces. Checks that read the text read
 *  this too, so `C""DPATH` and `\\cd` are what they run as. */
export function quoteRemoved(command: string, powershell = false): string {
  return quoteRemovedWords(command, powershell).join(' ')
}

/** The words of quoteRemoved, each as the shell would run it. */
function quoteRemovedWords(command: string, powershell = false): string[] {
  command = asWritten(command, powershell)
  const words: string[] = []
  for (const piece of command.split(/\r?\n|(?<!&)&(?!&)/))
    for (const part of splitChain(piece) ?? [piece])
      words.push(...(powershell ? psWords(part) : (shellWords(part) ?? part.split(/\s+/))))
  return words
}

/** PowerShell's words (round 6 additions #2): a backtick escapes the next
 *  character, `'…'` is literal, `"…"` takes backtick escapes. */
function psWords(text: string): string[] {
  const words: string[] = []
  let word = ''
  let quote: '' | "'" | '"' = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (quote === "'") {
      if (ch === "'") quote = ''
      else word += ch
    } else if (ch === '`' && i + 1 < text.length) word += text[++i]
    else if (quote === '"') {
      if (ch === '"') quote = ''
      else word += ch
    } else if (ch === "'" || ch === '"') quote = ch
    else if (/\s/.test(ch)) {
      if (word) words.push(word)
      word = ''
    } else word += ch
  }
  if (word) words.push(word)
  return words
}

/** Where a simple command's program word stands: past `NAME=` assignments,
 *  shell keywords and wrappers (and a wrapper's options); whether anything
 *  but `builtin`/`command` and the keywords came before it. */
function programAt(words: readonly string[]): { k: number; prefixed: boolean } {
  let k = 0
  let prefixed = false
  while (k < words.length) {
    const w = words[k]!
    if (ASSIGNMENT.test(w)) prefixed = true
    else if (KEYWORDS.has(w)) {
      // `time` and `!` run what follows; the others start a clause.
    } else if (WRAPPERS.has(w)) prefixed ||= w !== 'builtin' && w !== 'command'
    else if (!(k > 0 && WRAPPERS.has(words[k - 1]!) && w.startsWith('-'))) break
    k++
  }
  return { k, prefixed }
}

/** Round 6 additions #3: an assignment whose variable name the shell builds
 *  (`export $'CD'PATH=…`, `declare "${x}"=…`, `$'CD'PATH=…`) may set any. */
const BUILT_NAME = [
  /(?:^|[\s;&|(])[^\s=;&|(){}$]*(?:\$['"(A-Za-z_]|`)[^\s=;&|()]*=/,
  /\b(?:export|declare|typeset|local|readonly)\b(?:\s+-\w+)*\s+[^\s=;&|]*[$`'"][^\s=;&|]*=/,
  /\bprintf\s+-v\s*\S*[$`]/,
]

/** Review rounds 4 #5 and 5: a cd is followed only in the one form whose
 *  directory its words give - the cd program first (after shell keywords
 *  such as `if` or `time`), or after `builtin` or `command`, with no `NAME=`
 *  before it; exactly one target, redirections and a comment aside; and that
 *  target absolute (`/`, `~`, `~/…`, a drive), `.`/`..`-led, or bare relative
 *  only while CDPATH is known to be unset (PowerShell has no CDPATH). A
 *  command with a cd that mentions CDPATH or DIRSTACK, one that sets HOME
 *  beside a `~` target, and any cd the simple-command reading did not account
 *  for are refused too, as is a `cd -`, a stack entry or two targets anywhere
 *  in the text. Says what is refused, or undefined. `cdpathMaybe`: CDPATH may
 *  be set for the shell. */
export function cdNotFollowed(
  command: string,
  powershell = false,
  cdpathMaybe = true
): string | undefined {
  command = asWritten(command, powershell)
  const programs = powershell ? 'cd|pushd|chdir|set-location|sl|push-location' : 'cd|pushd|chdir'
  const edge = powershell ? `[\\s;&|(\`'"$/]` : `[\\s;&|(\`'"$]`
  const judged = asJudged(command)
  const mentioned = [
    ...judged.matchAll(new RegExp(`(?:^|${edge})(?:${programs})(?=$|[\\s;&|)\`'"])`, 'gi')),
  ].length
  // Round 5b: a cd the text does not show but its words do (`c""d`, `\\cd`)
  // is one the guard cannot follow.
  const words = quoteRemovedWords(command, powershell)
  const unquoted = words.join(' ')
  const said = `${command} ${unquoted}`
  const built = !powershell && BUILT_NAME.some((re) => re.test(command))
  // Round 6 #2: a command that sets HOME and names `~` anywhere, cd or not.
  const tilde = /(?:^|[\s;&|(=:'"])~/.test(command)
  if (setsVariable(said, 'HOME') && tilde) return SETS_HOME
  const spelled = words.some((w) => CD_PROGRAMS.has(w.replace(MODULE, '').toLowerCase()))
  // Round 6 additions #1: a program word the shell still expands could be cd
  // (`$'\\x63d'`, a backtick), unless it ends in a literal path (`$(npm bin)/jest`),
  // which names a program on disk, never the cd builtin. Not in PowerShell,
  // where `$x = …` starts a line.
  const expands = !powershell && expandsToProgram(command)
  if (
    (mentioned > 0 || spelled || expands) &&
    (built || setsVariable(said, 'CDPATH') || /\bcdpath\+?=\(/.test(said))
  )
    return 'CDPATH'
  if (built && tilde) return SETS_HOME
  // DIRSTACK steers popd, which runs with no cd in sight (round 5 #5); set
  // in this command, as CDPATH (round 6 additions #4).
  if (built || setsVariable(said, 'DIRSTACK') || /\bdirstack\+?=\(/.test(said)) return 'DIRSTACK'
  if (expands) return 'cd'
  if (mentioned === 0) return spelled ? 'cd' : undefined
  // Anywhere in the text, inside another command included (round 5 #2).
  // Round 6 #1: spaces only, never a newline (which ends a command).
  const sp = '[^\\S\\r\\n]+'
  const opts = `(?:(?:-[A-Za-z@]+|--)${sp})*`
  const stack = new RegExp(
    `(?:^|${edge})(?:${programs})${sp}${opts}([-+]\\d*)(?=$|[\\s;&|)\`'"])`,
    'i'
  ).exec(judged)
  if (stack) return stack[1]
  const word = `[^\\s;&|)'"\`#<>-][^\\s;&|)'"\`<>]*`
  const two = new RegExp(
    `(?:^|${edge})(?:${programs})${sp}${opts}(${word})${sp}(${word})(?=$|[\\s;&|)])`,
    'i'
  ).exec(judged)
  if (two && !(powershell && PS_VALUED.test(two[1]!))) return `${two[1]} ${two[2]}`
  let followed = 0
  const targets: string[] = []
  for (const piece of command.split(/\r?\n|(?<!&)&(?!&)/)) {
    const chain = splitChain(piece)
    for (const part of chain ?? [piece]) {
      const words = (shellWords(part) ?? part.split(/\s+/))
        .map((w) => w.replace(/^[({]+|[)}]+$/g, ''))
        .filter((w) => w !== '')
      const { k, prefixed } = programAt(words)
      const raw = words[k]
      const program = powershell && raw ? raw.replace(MODULE, '') : raw
      if (!program || !CD_PROGRAMS.has(program.toLowerCase())) continue
      if (prefixed) return words.slice(0, k + 1).join(' ')
      const positional: string[] = []
      let options = true
      const rest = words.slice(k + 1)
      for (let i = 0; i < rest.length; i++) {
        const w = rest[i]!
        if (w.startsWith('#')) break
        if (REDIRECT_ALONE.test(w)) i++
        else if (REDIRECT.test(w) || /^&\d*$/.test(w)) continue
        else if (powershell && PS_VALUED.test(w)) i++
        else if (options && w === '--') options = false
        else if (options && /^-[A-Za-z@]/.test(w)) continue
        else positional.push(w)
      }
      if (positional.length !== 1) return [program, ...positional].join(' ')
      const t = positional[0]!
      // `cd -` (OLDPWD) and the directory stack (`+1`, `-2`).
      if (/^[-+]\d*$/.test(t)) return t
      const placed =
        /^(?:\/|~(?:\/|$)|[A-Za-z]:\/|\.\.?(?:\/|$))/.test(t) || powershell || !cdpathMaybe
      if (!placed) return t
      targets.push(t)
      followed++
    }
  }
  if (followed < mentioned) return 'cd'
  return undefined
}

/** Whether a simple command's program word holds an expansion (`$`, a
 *  backtick) and does not end in a literal path segment. Read on the raw
 *  words, before quote removal. */
function expandsToProgram(command: string): boolean {
  for (const piece of command.split(/\r?\n|(?<!&)&(?!&)/))
    for (const part of splitChain(piece) ?? [piece]) {
      const { k } = programAt(rawWords(part))
      const words = rawWords(part)
      const w = words[k]
      if (w !== undefined && /[$`]/.test(w) && !/\/[\w.+-]+["']?$/.test(w)) return true
    }
  return false
}

/** A command's words as written, quotes kept: split on spaces outside
 *  quotes and `$(…)`/backticks. */
function rawWords(text: string): string[] {
  const words: string[] = []
  let word = ''
  let quote = ''
  let depth = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (quote) {
      if (ch === '\\' && quote === '"') word += ch + (text[++i] ?? '')
      else {
        if (ch === quote) quote = ''
        word += ch
      }
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch === '`' && depth === 0 ? '`' : ch
    if (ch === '(' && text[i - 1] === '$') depth++
    else if (ch === ')' && depth > 0) depth--
    if (/\s/.test(ch) && depth === 0 && !quote) {
      if (word) words.push(word)
      word = ''
    } else word += ch
  }
  if (word) words.push(word)
  return words
}

/** cdNotFollowed's answer for a command that sets HOME and names `~`. */
export const SETS_HOME = 'HOME'

/** Round 6 #2: whether a command sets `name` - an assignment, `export`,
 *  `declare`, `typeset`, `local`, `readonly`, `read`, `printf -v`,
 *  `${name:=…}` or `unset` - not merely reads it (`$HOME`, `${HOME:-x}`, a
 *  word in grep's arguments). Judged per command: the Bash tool keeps no
 *  environment between calls. */
function setsVariable(text: string, name: string): boolean {
  const n = name
  return [
    new RegExp(`(?:^|[\\s;&|(\`'"])${n}(?:\\[[^\\]]*\\])?\\+?=`),
    new RegExp(`\\b(?:export|declare|typeset|local|readonly)\\b[^;&|\\n]*\\b${n}\\b`),
    new RegExp(`\\bread\\b[^;&|\\n]*\\b${n}\\b`),
    new RegExp(`\\bprintf\\b[^;&|\\n]*-v\\s*${n}\\b`),
    new RegExp(`\\$\\{${n}:?=`),
    new RegExp(`\\bunset\\b[^;&|\\n]*\\b${n}\\b`),
  ].some((re) => re.test(text))
}

// The programs that never run what they are given, each with the only
// options it may have (security reviews of rounds 2 and 3: `sort
// --compress-program`, `rg --pre` run one): short flags, combinable, and the
// options that take the next word as their value.
const TEXT_ONLY: Readonly<Record<string, { flags: string; values: readonly string[] }>> = {
  grep: { flags: 'rnilchHEFwvo', values: ['-e'] },
  rg: { flags: 'nilcwF', values: ['-t'] },
  echo: { flags: 'ne', values: [] },
  printf: { flags: '', values: [] },
  wc: { flags: 'lcw', values: [] },
  head: { flags: '', values: ['-n'] },
  uniq: { flags: 'c', values: [] },
}

/** Whether `words` is a TEXT_ONLY program given only its own options. */
function textOnly(words: readonly string[]): boolean {
  const allowed = Object.hasOwn(TEXT_ONLY, words[0] ?? '') ? TEXT_ONLY[words[0]!] : undefined
  if (!allowed) return false
  for (let i = 1; i < words.length; i++) {
    const w = words[i]!
    if (!w.startsWith('-') || w === '-') continue
    if (allowed.values.includes(w)) {
      if (words[++i] === undefined) return false
      continue
    }
    if (!/^-[A-Za-z]+$/.test(w) || ![...w.slice(1)].every((c) => allowed.flags.includes(c)))
      return false
  }
  return true
}

/** The cd targets a refusal judges: allCdTargets over the whole command
 *  (fail closed). Quoted text is read as text only when every part of the
 *  chain is a TEXT_ONLY program given only its own options, nothing expands, and no part has a
 *  subshell, brace, process substitution or redirection outside quotes
 *  (`grep "cd *" scripts/`; never `echo "cd x" | sh`). Split as cdTargets
 *  splits, and read with the shell's own quoting. */
export function cdTargetsToJudge(command: string, powershell = false): string[] {
  return allCdTargets(asJudged(asWritten(command, powershell)), powershell)
}

/** The command as a cd check reads it: with quoted text left out only when
 *  every part of it is a TEXT_ONLY program (see cdTargetsToJudge). */
function asJudged(command: string): string {
  const parts: string[] = []
  for (const piece of command.split(/\r?\n|(?<!&)&(?!&)/)) {
    const chain = splitChain(piece)
    if (chain === null) return command
    parts.push(...chain)
  }
  const text =
    !shellExpands(command) &&
    parts.every((part) => {
      const words = shellWords(part)
      return (
        words !== null &&
        (words.length === 0 || textOnly(words)) &&
        !/[(){}<>]/.test(outsideQuotes(part))
      )
    })
  return text ? parts.map(outsideQuotes).join(' ; ') : command
}

/** Whether a cd to `target` would put the shell in or inside one of `dirs`
 *  (from rawOnlyDirectories, leading parts included), on the normalised path. */
export function cdIntoRawOnly(target: string, dirs: readonly string[]): boolean {
  const parts = normalisePath(target)
    .split('/')
    .filter((x) => x !== '' && x !== '~' && x !== '.' && x !== '..')
    .map((x) => x.toLowerCase())
  for (const dir of dirs) {
    const d = dir.toLowerCase().split('/')
    // Equals or inside: the directory appears in the path. A leading part
    // (`.config` of `.config/gcloud`) is one of `dirs` itself.
    for (let i = 0; i + d.length <= parts.length; i++)
      if (d.every((x, j) => part(x, parts[i + j]!))) return true
  }
  return false
}

/** Spec 078 FR-012: Claude Code's project and user settings, which can switch
 *  the guard off (`disableAllHooks`). Matched as a path's tail, as written and
 *  resolved, ignoring case. */
export function isWriteProtected(path: string): boolean {
  const p = normalisePath(path.replace(/^['"]+|['"]+$/g, '')).toLowerCase()
  return /(^|\/)\.claude\/settings(\.local)?\.json$/.test(p)
}
