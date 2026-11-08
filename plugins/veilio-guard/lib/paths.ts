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

/** The targets of every cd or pushd in a command, wherever it stands: after
 *  `&&`, `||`, `;`, `|`, a lone `&` or a newline, or inside a subshell. */
export function cdTargets(command: string): string[] {
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
      if (!CD_PROGRAMS.has((words[k] ?? '').toLowerCase())) continue
      const target = words.slice(k + 1).find((w) => w !== '' && !(w.startsWith('-') && w !== '-'))
      if (target !== undefined && target !== '-') targets.push(target)
    }
  }
  return targets
}

/** Every cd target, the ones the chain split cannot see included: inside
 *  `$(...)`, backticks, `bash -c '...'` or `eval "..."` (review round 1 of
 *  spec 078). Read over the whole command, quotes ignored. */
export function allCdTargets(command: string): string[] {
  const hidden = [
    // A target may be quoted, and follow `--` (review round 2 of spec 078).
    ...command.matchAll(
      /(?:^|[\s;&|(`'"$])(?:cd|pushd|chdir)\s+(?:(?:-[LPe@]+|--)\s+)*['"]?([^\s;&|)'"`]+)/g
    ),
  ].map((m) => m[1]!)
  return [...new Set([...cdTargets(command), ...hidden])]
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
export function cdTargetsToJudge(command: string): string[] {
  const parts: string[] = []
  for (const piece of command.split(/\r?\n|(?<!&)&(?!&)/)) {
    const chain = splitChain(piece)
    if (chain === null) return allCdTargets(command)
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
  return allCdTargets(text ? parts.map(outsideQuotes).join(' ; ') : command)
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
