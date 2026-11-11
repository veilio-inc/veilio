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
  normaliseRawOnlyPattern,
  rawOnlyOf,
  shortNameAlias,
  windowsAlias,
} from '../vendor/engine/index.js'
import { DEFAULT_RAW_ONLY, normaliseRawOnlyPattern } from '../vendor/engine/index.js'
import {
  outsideQuotes,
  shellExpands,
  shellWords,
  splitChain,
  type Assign,
  type List,
  type Node,
  type Part,
  type Joint,
  type Pipeline,
  type Redirect,
  type Simple,
  type Word,
  parseShell,
} from './shell.ts'

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
  for (const written of patterns) {
    if (!written || written.startsWith('!')) continue
    // The engine's reading of a pattern, as isRawOnly's (spec 085 R2-15);
    // one it reports is read as written, as before.
    const pattern = normaliseRawOnlyPattern(written) ?? written
    if (!pattern.includes('/')) continue
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

/** A path as Windows opens it, for the tail checks below: `/`, lower case,
 *  and each part without its stream (`:x`) or trailing dots and spaces, as
 *  the engine reads a raw-only path (review of the run-2 guard branch). */
function openedAs(path: string): string {
  return normalisePath(path.replace(/^['"]+|['"]+$/g, ''))
    .toLowerCase()
    .split('/')
    .map((p) => (p === '..' ? p : p.replace(/:.*$/, '').replace(/[. ]+$/, '')))
    .join('/')
}

/** Spec 078 FR-012: Claude Code's project, user and managed settings, which
 *  can switch the guard off (`disableAllHooks`), and the files that define
 *  MCP servers. Matched as a path's tail, as written and resolved, ignoring case. */
export function isWriteProtected(path: string): boolean {
  const p = openedAs(path)
  return (
    /(^|\/)\.claude\/settings(\.local)?\.json$/.test(p) ||
    /(^|\/)managed-settings\.json$/.test(p) ||
    mcpConfigName(path) !== null
  )
}

/** Spec 085 R2-9 and its review: the files Claude Code reads MCP servers
 *  from, which decide the server `mcpRestore` hands real names to - the
 *  project's `.mcp.json`, `~/.claude.json` (user and local scope) and a
 *  managed `managed-mcp.json` - named as the refusal names them; null for
 *  any other path. */
export function mcpConfigName(path: string): string | null {
  const p = openedAs(path)
  if (/(^|\/)\.mcp\.json$/.test(p)) return '.mcp.json'
  if (/(^|\/)\.claude\.json$/.test(p)) return '~/.claude.json'
  if (/(^|\/)managed-mcp\.json$/.test(p)) return 'managed-mcp.json'
  return null
}

// ── spec 086: where a cd takes the shell (contracts/cd-verdicts.md) ─────────
//
// The walk over parseShell's tree: the directories the shell may be in at
// each simple command, every cd that lands somewhere (each landing directory
// is judged by the guard, FR-008), and the cds it cannot follow (N1, N2).

/** A shell variable the cd rules read: known, unset, or set to something the
 *  guard cannot read. PWD and OLDPWD default to where the shell is/was. */
export type Var = { value: string } | 'unset' | 'unknown'
export type Vars = { HOME: Var; CDPATH: Var; PWD: Var | 'auto'; OLDPWD: Var | 'auto' }

/** Where the shell may be (data-model.md DirState): normalised absolute
 *  directories, at most MAX_DIRS. */
export type DirState = {
  dirs: readonly string[]
  oldpwd: readonly string[] | 'unknown'
  /** pushd/popd's stack, within one call. */
  stack: readonly (readonly string[])[] | 'unknown'
  vars: Vars
}

/** research.md R6 / Q3 = A: more possible directories than this refuses the call. */
export const MAX_DIRS = 16

export type CdRefusal = { kind: 'N1'; target: string; form: string } | { kind: 'N2' }
export type CdWalk = {
  /** Each simple command's words, with where they are read from. */
  points: { dirs: readonly string[]; words: Word[]; home: string | null }[]
  /** Each followed cd: its target as written, and where it may land. */
  landings: { target: string; dirs: readonly string[] }[]
  refusal: CdRefusal | null
  /** The top-level state after the command where it most likely ended
   *  (where it succeeded, else where it failed): checked against the host's
   *  report of the shell's directory. */
  end: DirState
  /** Every directory it may have left the shell in, success or failure: the
   *  next call's start when the host reports none. Null: more than MAX_DIRS. */
  endAll: DirState | null
}
export type CdContext = {
  /** Whether a path exists (file or directory). */
  exists(path: string): Promise<boolean>
  /** Whether a path is a directory. */
  isDirectory(path: string): Promise<boolean>
}

class Refused extends Error {
  constructor(readonly refusal: CdRefusal) {
    super(refusal.kind)
  }
}

const CD_PROGRAM = new Set(['cd', 'chdir', 'pushd', 'popd'])
const TRACKED: Readonly<Record<string, keyof Vars>> = {
  HOME: 'HOME',
  CDPATH: 'CDPATH',
  cdpath: 'CDPATH',
  PWD: 'PWD',
  OLDPWD: 'OLDPWD',
}
const STACK_NAMES = new Set(['DIRSTACK', 'dirstack'])
const N1: (target: string, form: string) => never = (target, form) => {
  throw new Refused({ kind: 'N1', target, form })
}

const abs = (dir: string, path: string) =>
  normalisePath(path.startsWith('/') ? path : `${dir.replace(/\/+$/, '')}/${path}`)
const uniq = (dirs: Iterable<string>) => [...new Set(dirs)].sort()

type Outcome = { ok: DirState | null; fail: DirState | null }

function sameVar(a: Var | 'auto', b: Var | 'auto'): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function merge(a: DirState | null, b: DirState | null): DirState | null {
  if (!a) return b
  if (!b || a === b) return a
  const dirs = uniq([...a.dirs, ...b.dirs])
  if (dirs.length > MAX_DIRS) N1('', 'too many possible directories')
  const vars = { ...a.vars }
  for (const k of Object.keys(vars) as (keyof Vars)[])
    if (!sameVar(a.vars[k], b.vars[k])) (vars as Record<string, Var | 'auto'>)[k] = 'unknown'
  return {
    dirs,
    oldpwd:
      a.oldpwd === 'unknown' || b.oldpwd === 'unknown'
        ? 'unknown'
        : uniq([...a.oldpwd, ...b.oldpwd]),
    stack: mergeStacks(a.stack, b.stack),
    vars,
  }
}

/** Two possible stacks as one: each entry the directories either has there,
 *  and '' where one has none (a pop there may find the stack empty). */
function mergeStacks(a: DirState['stack'], b: DirState['stack']): DirState['stack'] {
  if (a === 'unknown' || b === 'unknown') return 'unknown'
  if (JSON.stringify(a) === JSON.stringify(b)) return a
  return Array.from({ length: Math.max(a.length, b.length) }, (_, k) =>
    uniq([...(a[k] ?? ['']), ...(b[k] ?? [''])])
  )
}

const both = (s: DirState | null): Outcome => ({ ok: s, fail: s })
const anyOf = (o: Outcome) => merge(o.ok, o.fail)

/** The value of an assignment, `~` expanded with HOME as it is: null when the
 *  shell builds it. */
function valueOf(w: Word, vars: Vars): string | null {
  let out = ''
  for (const p of w.parts) {
    if (p.kind === 'lit') out += p.text
    else if (p.kind === 'tilde' && p.user === '' && typeof vars.HOME === 'object')
      out += vars.HOME.value
    else return null
  }
  return out
}

class Walker {
  readonly points: CdWalk['points'] = []
  readonly landings: CdWalk['landings'] = []
  homeUnknown = false
  tilde = false
  /** A link this command makes: with a cd in it, refused. */
  link: string | null = null
  /** An interpreter that ran: it could have made a link, so a cd after it
   *  is refused (the coordinator's shape rule). */
  private interp: string | null = null
  /** Something in this command wrote a file before. */
  private wrote = false
  /** The cd being read resolves physically (`-P`). */
  private physical = false
  /** The directory the command just before made with `python -m venv`. */
  private venv: string | null = null
  /** The operator before the item being walked, for its first command. */
  private joint: Joint | null = null
  /** Every move of the shell the walk read: a cd that landed, or a variable
   *  a cd reads set for the rest of the call; with the subshell depth it
   *  was read at. The one model of "moves the shell" for loops (security
   *  review): the walk itself, not a second reading. */
  private readonly moves: { shown: string; depth: number }[] = []
  private depth = 0
  private current = ''
  constructor(
    private readonly ctx: CdContext,
    /** PowerShell: one runspace, so a pipeline stage, `$( )` and a script
     *  block run in it, not in a child (FR-016). */
    private readonly ps = false
  ) {}

  /** In a child shell (a subshell, `$( )`, a pipeline stage, `bash -c`):
   *  what it moves is not this shell's. */
  private async child<T>(f: () => Promise<T>): Promise<T> {
    this.depth++
    try {
      return await f()
    } finally {
      this.depth--
    }
  }

  /** The first move a list or node makes in this shell, walked from
   *  `input`; null when it moves nothing. */
  private async probe(what: List | Node, input: DirState): Promise<string | null> {
    const from = this.moves.length
    if ('items' in what) await this.list(what, input)
    else await this.node(what, input)
    return this.moves.slice(from).find((m) => m.depth === this.depth)?.shown ?? null
  }

  async list(l: List, start: DirState): Promise<Outcome> {
    let out: Outcome = { ok: start, fail: null }
    for (const { node, joinedBy } of l.items) {
      // The operator before this item, for the first command in it (venv).
      this.joint = joinedBy
      let input: DirState | null
      if (joinedBy === '&&') input = out.ok
      else if (joinedBy === '||') input = out.fail
      else input = anyOf(out)
      if (!input) continue
      const r = node.background
        ? (await this.pipeline(node, input), both(input))
        : await this.pipeline(node, input)
      if (joinedBy === '&&') out = { ok: r.ok, fail: merge(out.fail, r.fail) }
      else if (joinedBy === '||') out = { ok: merge(out.ok, r.ok), fail: r.fail }
      else out = r
    }
    return out
  }

  private async pipeline(p: Pipeline, input: DirState): Promise<Outcome> {
    let r: Outcome
    if (p.stages.length === 1) r = await this.node(p.stages[0]!, input)
    else if (this.ps) {
      // A location cmdlet takes its path from the pipeline: not followed.
      for (const s of p.stages.slice(1))
        if (s.type === 'simple' && psCd(s.words) !== null)
          N1(s.words[0]?.raw ?? '', 'a path from the pipeline')
      let at = input
      for (const s of p.stages.slice(0, -1)) at = anyOf(await this.node(s, at)) ?? at
      r = await this.node(p.stages[p.stages.length - 1]!, at)
    } else {
      // `… | source /dev/stdin`, `… | . x`: text from the pipe, as code.
      for (const st of p.stages.slice(1))
        if (st.type === 'simple' && /^(?:source|\.)$/.test(programOf(st.words)?.word.literal ?? ''))
          N1(st.words.map((w) => w.raw).join(' '), 'code run from text')
      // Every stage but the last runs in a subshell; the last one does in
      // bash, not in zsh (research R5): both readings kept.
      for (const s of p.stages.slice(0, -1)) await this.child(() => this.node(s, input))
      const last = await this.node(p.stages[p.stages.length - 1]!, input)
      r = { ok: merge(input, last.ok), fail: merge(input, last.fail) }
    }
    return p.negated ? { ok: r.fail, fail: r.ok } : r
  }

  private async node(n: Node, input: DirState): Promise<Outcome> {
    switch (n.type) {
      case 'simple':
        return this.simple(n, input)
      case 'subshell':
        await this.child(() => this.list(n.list, input))
        await this.redirects(n.redirects, input)
        return both(input)
      case 'group': {
        await this.redirects(n.redirects, input)
        return this.list(n.list, input)
      }
      case 'if': {
        let all: DirState | null = null
        let next: DirState | null = input
        for (const b of n.branches) {
          if (!next) break
          const c = await this.list(b.cond, next)
          if (c.ok) all = merge(all, anyOf(await this.list(b.body, c.ok)))
          next = c.fail
        }
        if (next) all = merge(all, n.else ? anyOf(await this.list(n.else, next)) : next)
        return both(all)
      }
      case 'loop': {
        // A loop that moves the shell, or sets what a cd reads, is not
        // followed: its directory after n turns is not told (security review).
        // One turn is walked; one that moves nothing leaves the state as it was.
        await this.words(n.words ?? [], input)
        if (n.name !== null && (Object.hasOwn(TRACKED, n.name) || STACK_NAMES.has(n.name)))
          N1(`${n.name}=`, 'a cd in a loop')
        const mover =
          (n.cond && (await this.probe(n.cond, input))) ?? (await this.probe(n.body, input))
        if (mover !== null) N1(mover, 'a cd in a loop')
        return both(input)
      }
      case 'case': {
        await this.words([n.word], input)
        let all: DirState = input
        for (const arm of n.arms) all = merge(all, anyOf(await this.list(arm, input)))!
        return both(all)
      }
      case 'function':
        // A function's effect depends on where and how it is called, and
        // what it calls then: three review rounds did not converge on a
        // model of that (085's pattern), and the corpus has none. Refused.
        return N1(n.name, 'a shell function')
    }
  }

  private redirects(rs: readonly Redirect[], at: DirState): Promise<unknown> {
    return this.words(
      rs.flatMap((r) => (r.target && !/^<<-?$/.test(r.op) ? [r.target] : [])),
      at
    )
  }

  /** A simple command's words, read at this point; substitutions in them
   *  run in a subshell from here. */
  private async words(words: readonly Word[], at: DirState, inPlace = false): Promise<void> {
    const home = typeof at.vars.HOME === 'object' ? at.vars.HOME.value : null
    this.points.push({ dirs: at.dirs, words: [...words], home })
    for (const w of words)
      for (const p of w.parts) {
        if (p.kind === 'tilde' && p.user === '') this.tilde = true
        const l = p.kind === 'subst' ? p.list : null
        // One at a time: the depth counter is the walk's own.
        if (l && !inPlace) await this.child(() => this.list(l, at))
      }
  }

  /** `record`: set for the rest of the call (not a prefix assignment). */
  private set(state: DirState, name: string, v: Var, record = true): DirState {
    if (record && (STACK_NAMES.has(name) || Object.hasOwn(TRACKED, name)))
      this.moves.push({ shown: `${name}=`, depth: this.depth })
    if (STACK_NAMES.has(name)) return { ...state, stack: 'unknown' }
    const key = TRACKED[name]
    if (!key) return state
    if (key === 'HOME' && v === 'unknown') this.homeUnknown = true
    if (key === 'OLDPWD')
      return {
        ...state,
        oldpwd: typeof v === 'object' ? [normalisePath(v.value)] : 'unknown',
        vars: { ...state.vars, OLDPWD: v },
      }
    return { ...state, vars: { ...state.vars, [key]: v } }
  }

  private assign(state: DirState, a: Assign, record = true): DirState {
    // zsh's options array: CDABLE_VARS and AUTO_CD among them.
    if (a.name === 'options') N1(`${a.name}=`, 'an option that changes cd')
    if (a.name === null) {
      let s = state
      for (const n of ['HOME', 'CDPATH', 'PWD', 'OLDPWD']) s = this.set(s, n, 'unknown', record)
      return { ...s, stack: 'unknown' }
    }
    if (!Object.hasOwn(TRACKED, a.name) && !STACK_NAMES.has(a.name)) return state
    const values = (Array.isArray(a.value) ? a.value : [a.value]).map((w) => valueOf(w, state.vars))
    let v: Var = values.some((x) => x === null) ? 'unknown' : { value: values.join(':') }
    if (a.op === '+=' && typeof v === 'object') {
      const now = state.vars[TRACKED[a.name] ?? 'HOME']
      v =
        typeof now === 'object'
          ? { value: now.value + (Array.isArray(a.value) ? ':' : '') + v.value }
          : now === 'unset'
            ? v
            : 'unknown'
    }
    return this.set(state, a.name, v, record)
  }

  private async simple(n: Simple, input: DirState): Promise<Outcome> {
    // Prefix assignments hold for this command only, unless it has none.
    let here = input
    for (const a of n.assigns) {
      for (const w of Array.isArray(a.value) ? a.value : [a.value]) await this.words([w], input)
      here = this.assign(here, a, n.words.length === 0)
    }
    // PowerShell runs `$( )` and a script block in place, before the command.
    if (this.ps)
      for (const w of n.words)
        for (const p of w.parts)
          if (p.kind === 'subst' && p.list) here = anyOf(await this.list(p.list, here)) ?? here
    await this.words(n.words, here, this.ps)
    await this.redirects(n.redirects, here)
    // ${NAME:=v} sets NAME in this shell.
    let after = n.words.length === 0 ? here : input
    for (const w of n.words)
      for (const p of w.parts)
        if (p.kind === 'param' && /^:?=/.test(p.op)) after = this.set(after, p.name, 'unknown')
    const program = n.words[0]?.literal ?? null
    const shown = n.words.map((w) => w.raw).join(' ')
    this.current = shown
    const wroteBefore = this.wrote
    // `python3 -m venv DIR` then, as the very next command, `. DIR/bin/activate`.
    const venv = this.venv
    this.venv = null
    const joint = this.joint
    this.joint = null
    // T029 reviews: what moves the shell from text, an option, or a name.
    const run = programOf(n.words)
    const name = run?.word.literal ?? null
    const rest = run ? n.words.slice(run.at + 1) : []
    const lits = rest.map((w) => w.literal ?? w.raw)
    const base = name?.replace(/^.*\//, '') ?? null
    if (name === 'eval' && !n.nested && rest.length > 0) N1(this.current, 'code run from text')
    // zsh `emulate … -c text` runs it like eval.
    if (name === 'emulate' && lits.includes('-c')) N1(this.current, 'code run from text')
    // A sourced file is the script's own (N6) only when it is a literal file
    // path: not text the call builds (`/dev/stdin`, `/dev/fd/*`, `<( )`, a
    // here-string or here-document).
    if (name === 'source' || name === '.') {
      const file = rest[0]?.literal == null ? null : normalisePath(rest[0].literal)
      if (
        file === null ||
        /^\/dev\/|^\/proc\/(?:self|[^/]+\/fd)\//.test(file) ||
        n.redirects.some((r) => /^<(?:<<?|<-|>|&)?$/.test(r.op)) ||
        (this.wrote &&
          !(venv !== null && joint === '&&' && file === normalisePath(`${venv}/bin/activate`)))
      )
        N1(this.current, 'code run from text')
    }
    // Anything this call may write before a source or an interpreter's file:
    // a redirection that writes (only `>&`/`<&` to an fd or `-` does not), or
    // any command but a plain reader (the allow-list; no path tracking).
    if (
      n.redirects.some(
        (r) =>
          /^(?:>|>>|>\||&>|&>>|<>)$/.test(r.op) ||
          (/^[<>]&$/.test(r.op) && !/^\d+$|^-$/.test(r.target?.literal ?? ''))
      ) ||
      (n.words.length > 0 && !readOnly(base, lits))
    )
      this.wrote = true
    if (name === 'trap') {
      // Past its options; an action on any signal may run within this call
      // (DEBUG, RETURN, ERR): refused as it appears. `''` and `-` set none.
      let k = 0
      while (k < lits.length && /^-./.test(lits[k]!)) if (lits[k++] === '--') break
      const action = lits[k]
      const signalOnly = lits.length - k === 1 && /^(?:SIG)?[A-Z]+$|^\d+$/.test(action ?? '')
      // A cleanup trap runs: on EXIT (or 0) only, its literal action read as
      // commands, each a plain reader or `rm` on literal paths (review).
      const signals = lits.slice(k + 1)
      const harmless =
        rest[k]?.literal != null &&
        signals.length > 0 &&
        signals.every((g) => /^(?:EXIT|SIGEXIT|0)$/i.test(g)) &&
        cleanupOnly(action ?? '')
      if (action !== undefined && action !== '' && action !== '-' && !signalOnly && !harmless)
        N1(this.current, 'code run from text')
    }
    if (
      /^(?:shopt|setopt|unsetopt|set)$/.test(name ?? '') &&
      (rest.some((w) => w.literal === null) ||
        (name !== 'set' && lits.some((l) => /^-[A-Za-z]*m/.test(l) || /[*?[]/.test(l))) ||
        lits.some(
          (l) =>
            /^(?:cdablevars|chaselinks|chasedots|physical)$/.test(
              l.toLowerCase().replace(/[_-]/g, '').replace(/^no/, '')
            ) ||
            (name !== 'shopt' && /^[-+][A-Za-z]*T/.test(l)) ||
            (name === 'set' && /^[-+][A-Za-z]*P/.test(l))
        ))
    )
      N1(this.current, 'an option that changes cd')
    if (name === 'alias' && lits.some((l) => l.includes('=')))
      N1(this.current, 'a new name for a command')
    if (this.ps && name !== null) {
      // PowerShell, by the command's shape (the second review): code from
      // text, a new name, an item set where a name or a value could be.
      const cmd = name.toLowerCase().replace(/^.*\\/, '')
      if (/^invoke-|^(?:icm|iex)$/.test(cmd)) N1(this.current, 'code run from text')
      if (/-alias$|^(?:sal|nal|ipal|epal)$/.test(cmd)) N1(this.current, 'a new name for a command')
      if (
        /^(?:set-item|new-item|ni|si)$/.test(cmd) &&
        rest.some((w) => w.literal === null || /::|^[A-Za-z]{2,}:/.test(w.literal))
      )
        N1(this.current, 'code run from text')
      if (/^(?:get-variable|gv)$/.test(cmd) && lits.some((l) => /executioncontext/i.test(l)))
        N1(this.current, 'code run from text')
    }
    if (
      ((base === 'ln' || base === 'cp') &&
        lits.some((l) => /^-[A-Za-z]*s/.test(l) || /^--sy/.test(l))) ||
      /^mklink$/i.test(name ?? '') ||
      (this.ps &&
        /^new-item$/i.test(name ?? '') &&
        rest.some((w) => /^(?:symboliclink|junction)$/i.test(w.literal ?? '')))
    )
      this.link ??= this.current
    const args = n.words.slice(1)
    // Declaration builtins and the commands that set a variable by name.
    for (const w of args) if (w.assign) after = this.assign(after, w.assign)
    if (program === 'declare' || program === 'typeset')
      if (args.some((w) => /^-[a-zA-Z]*n/.test(w.literal ?? '')))
        for (const w of args) if (w.assign?.name) after = this.set(after, w.assign.name, 'unknown')
    if (
      program === 'read' ||
      program === 'unset' ||
      program === 'printf' ||
      program === 'mapfile'
    ) {
      const names = args.map((w) => w.literal ?? '')
      const set = program === 'printf' ? names.filter((_, k) => names[k - 1] === '-v') : names
      for (const name of set)
        after = this.set(after, name, program === 'unset' ? 'unset' : 'unknown')
    }
    if (n.nested) {
      // eval runs in this shell; a nested shell in a child.
      if (program === 'eval') return this.list(n.nested, after)
      await this.child(() => this.list(n.nested!, here))
    }
    if (program === 'exit' || program === 'return') return { ok: null, fail: null }
    if (program === 'true' || program === ':') return { ok: after, fail: null }
    if (program === 'false') return { ok: null, fail: after }
    // A nested walk above read its own commands: this one is shown again.
    this.current = shown
    const out = await this.cd(n, here, after)
    // An interpreter or a shell given code by this call (`-c`, `-e`, `-`, a
    // here-document or here-string, stdin, a file the shell builds), or
    // running a file after something in the call wrote one: it could have
    // made a link, so every later cd but a logical `..`/`-` is refused. One
    // running a file the call did not write is the script's own (N6/P7).
    if (
      /^python[\d.]*$/.test(base ?? '') &&
      !wroteBefore &&
      n.redirects.length === 0 &&
      lits.length === 3 &&
      lits[0] === '-m' &&
      lits[1] === 'venv' &&
      rest[2]!.literal !== null &&
      /^[\w./@+-]+$/.test(rest[2]!.literal)
    )
      this.venv = normalisePath(rest[2]!.literal)
    if (INTERPRETER.test(base ?? '') && !runsOwnFile(base!, rest, n.redirects, wroteBefore))
      this.interp ??= this.current
    return out
  }

  /** A cd's effect (data-model.md CdEffect): the outcome when it moves, or
   *  both outcomes unchanged when the command is not a cd. */
  private async cd(n: Simple, here: DirState, after: DirState): Promise<Outcome> {
    this.physical = false
    const words = n.words
    if (this.ps) {
      const c = psCd(words)
      if (c === null) return both(after)
      if ('refuse' in c) return N1(c.shown, c.refuse)
      return this.cdWith(c.name, c.rest, false, here, after)
    }
    const found = programOf(words)
    if (!found) return both(after)
    const { word: prog, at: k } = found
    let program = prog.literal
    let possible = false
    // zsh AUTO_CD: a lone word naming a directory is a cd to it.
    if (words.length === 1 && n.assigns.length === 0 && !CD_PROGRAM.has(program ?? '')) {
      let candidates: string[]
      try {
        candidates = await this.target(prog, here)
      } catch (err) {
        if (err instanceof Refused) return both(after)
        throw err
      }
      const dirs = await this.existing(candidates)
      return dirs.length ? this.moved(here, after, prog.raw, dirs, true) : both(after)
    }
    if (program === null) {
      // An expanded program word that is not a path may be `cd` (085 round 6).
      if (prog.raw.includes('/')) return both(after)
      program = 'cd'
      possible = true
    } else if (!CD_PROGRAM.has(program)) return both(after)
    let rest = words.slice(k + 1)
    this.physical = rest.some((w) => /^-[A-Za-z@]*P/.test(w.literal ?? ''))
    while (rest.length > 0 && /^-[LPe@qs]+$|^--$/.test(rest[0]!.literal ?? '')) {
      const stop = rest[0]!.literal === '--'
      rest = rest.slice(1)
      if (stop) break
    }
    return this.cdWith(program, rest, possible, here, after)
  }

  /** A cd, pushd or popd with its targets (options set aside). */
  private async cdWith(
    name: string,
    rest: Word[],
    possible: boolean,
    here: DirState,
    after: DirState
  ): Promise<Outcome> {
    const shown = (w: Word | undefined) => w?.raw ?? name
    // A directory-stack entry: `+N`, `-N`.
    if (rest[0] && /^[+-]\d+$/.test(rest[0].literal ?? ''))
      N1(rest[0].raw, 'a directory-stack entry')
    if (name === 'popd') {
      if (rest.length > 0) return both(after)
      if (here.stack === 'unknown') N1('popd', 'a directory-stack entry')
      const [top, ...stack] = here.stack as string[][]
      if (!top) return { ok: null, fail: after }
      const out = await this.moved(here, after, 'popd', top.filter(Boolean), top.includes(''))
      return { ok: out.ok && { ...out.ok, stack }, fail: out.fail }
    }
    if (rest.length === 0) {
      if (name === 'pushd') {
        if (here.stack === 'unknown') N1('pushd', 'a directory-stack entry')
        const [top, ...stack] = here.stack as string[][]
        if (!top) return { ok: null, fail: after }
        const out = await this.moved(here, after, 'pushd', top.filter(Boolean), top.includes(''))
        return { ok: out.ok && { ...out.ok, stack: [here.dirs, ...stack] }, fail: out.fail }
      }
      if (possible) return both(after)
      return this.moved(here, after, name, this.home(here, name), possible)
    }
    if (rest.length > 2 || (this.ps && rest.length > 1))
      N1(rest.map((w) => w.raw).join(' '), 'more than one target')
    if (rest.length === 2 && name !== 'popd' && !possible) {
      // zsh `cd old new`: old replaced by new in the directory; bash: an error.
      const [o, w] = [rest[0]!.literal, rest[1]!.literal]
      if (o === null || w === null) N1(`${rest[0]!.raw} ${rest[1]!.raw}`, 'more than one target')
      const swapped = here.dirs
        .filter((d) => d.includes(o!))
        .map((d) => normalisePath(d.replace(o!, w!)))
      if (swapped.length === 0) N1(`${rest[0]!.raw} ${rest[1]!.raw}`, 'more than one target')
      const out = this.moved(here, after, `${rest[0]!.raw} ${rest[1]!.raw}`, swapped, true)
      return name === 'pushd' ? this.pushed(out, here) : out
    }
    if (rest.length > 1 && !possible) return { ok: null, fail: after }
    const target = rest[0]!
    const dirs = await this.target(target, here)
    const out = await this.moved(here, after, shown(target), dirs, possible)
    return name === 'pushd' ? this.pushed(out, here) : out
  }

  /** pushd: where the shell was goes on the stack. */
  private pushed(out: Outcome, here: DirState): Outcome {
    if (!out.ok) return out
    const stack = here.stack === 'unknown' ? 'unknown' : [here.dirs, ...here.stack]
    return { ok: { ...out.ok, stack }, fail: out.fail }
  }

  /** Where `~` and a bare cd go. A session with no HOME loses track, as
   *  main does (no directory known); one the command made unknown is N2. */
  private home(here: DirState, shown: string): string[] {
    const h = here.vars.HOME
    if (typeof h === 'object') return [normalisePath(h.value)]
    if (this.homeUnknown) throw new Refused({ kind: 'N2' })
    if (h === 'unknown') return []
    return N1(shown, 'HOME set in this command to a value Veilio cannot read')
  }

  private async existing(paths: string[]): Promise<string[]> {
    const out: string[] = []
    for (const p of paths) if (await this.ctx.isDirectory(p)) out.push(p)
    return out
  }

  /** The cd landed: each directory judged by the guard, the shell there.
   *  `possible`: it may also not have moved (both kept). */
  private moved(
    here: DirState,
    after: DirState,
    target: string,
    dirs: string[],
    possible: boolean
  ): Outcome {
    // After an interpreter only a logical `cd ..` (`..` segments only) and
    // `cd -` run: they resolve from text the shell holds ($PWD, $OLDPWD) and
    // never enter a link made in the call. `-P` and anything else: refused.
    if (this.interp !== null && (this.physical || !/^(?:-|\.\.(?:\/\.\.)*\/?)$/.test(target)))
      N1(this.interp, 'a cd after code this command ran')
    const to = uniq(dirs)
    if (to.length > MAX_DIRS) N1(target, 'too many possible directories')
    this.landings.push({ target, dirs: to })
    this.moves.push({ shown: this.current, depth: this.depth })
    const moved: DirState = { ...after, dirs: to, oldpwd: here.dirs }
    return possible ? { ok: merge(after, moved), fail: after } : { ok: moved, fail: after }
  }

  /** Where a cd target may take the shell (contracts/cd-verdicts.md
   *  "Evaluable targets"), or N1 naming its form. */
  private async target(w: Word, here: DirState): Promise<string[]> {
    const parts = w.parts
    const first = parts[0]
    const rest = parts.slice(1)
    const restText = (): string => {
      let t = ''
      for (const p of rest) {
        if (p.kind !== 'lit') return N1(w.raw, formOf(p))
        t += p.text
      }
      return t
    }
    const under = (bases: readonly string[], text: string) =>
      bases.map((b) => normalisePath(text ? `${b.replace(/\/+$/, '')}/${text}` : b))
    if (!first) return here.dirs.slice()
    // zsh extended globs in an unquoted literal: `#`, `^`, a `~` after the start.
    for (const [k, p] of parts.entries())
      if (
        !this.ps &&
        p.kind === 'lit' &&
        !p.quoted &&
        (/[#^]/.test(p.text) || (p.text.includes('~') && (k > 0 || !p.text.startsWith('~'))))
      )
        N1(w.raw, 'a glob')
    if (first.kind === 'tilde') {
      this.tilde ||= first.user === ''
      const text = restText()
      if (first.user === '') return under(this.home(here, w.raw), text)
      if (first.user === '+') return under(here.dirs, text)
      if (first.user === '-') {
        if (here.oldpwd === 'unknown') N1(w.raw, 'the previous directory is not known')
        return under(here.oldpwd as string[], text)
      }
      if (/^[+-]?\d+$/.test(first.user)) return N1(w.raw, 'a directory-stack entry')
      return N1(w.raw, "another user's home (`~name`)")
    }
    if (first.kind === 'param' && first.op === '') {
      const text = restText()
      if (first.name === 'PWD') return under(this.pwd(here), text)
      if (first.name === 'HOME') return under(this.home(here, w.raw), text)
      if (first.name === 'OLDPWD') {
        const v = here.vars.OLDPWD
        if (typeof v === 'object') return under([v.value], text)
        if (v === 'auto' && here.oldpwd !== 'unknown') return under(here.oldpwd, text)
        return N1(w.raw, 'the previous directory is not known')
      }
      return N1(w.raw, 'a variable')
    }
    if (first.kind === 'subst') {
      const text = restText()
      const what = first.list ? substOf(first.list) : null
      if (what === 'pwd') return under(here.dirs, text)
      if (what === 'toplevel') {
        const tops: string[] = []
        for (const d of here.dirs) {
          let at: string | null = d
          while (at !== null && !(await this.ctx.exists(`${at === '/' ? '' : at}/.git`)))
            at = at === '/' ? null : normalisePath(`${at}/..`)
          if (at === null) N1(w.raw, 'no repository above this directory')
          tops.push(at!)
        }
        return under(tops, text)
      }
      return N1(w.raw, 'a command substitution')
    }
    if (w.literal === null) {
      const p = parts.find((x) => x.kind !== 'lit')!
      return N1(w.raw, formOf(p))
    }
    const t = w.literal
    if (t === '-') {
      if (here.oldpwd === 'unknown') N1(w.raw, 'the previous directory is not known')
      return here.oldpwd.slice()
    }
    if (t.startsWith('/')) return [normalisePath(t)]
    const dirs = here.dirs.map((d) => abs(d, t))
    // A bare name is also looked up under each CDPATH entry.
    if (!/^\.\.?(\/|$)/.test(t)) {
      const cdpath: Var = this.ps ? 'unset' : here.vars.CDPATH
      if (cdpath === 'unknown')
        N1(w.raw, 'CDPATH set in this command to a value Veilio cannot read')
      if (typeof cdpath === 'object')
        for (const entry of cdpath.value.split(':'))
          for (const d of here.dirs) dirs.push(abs(abs(d, entry || '.'), t))
    }
    return dirs
  }

  private pwd(here: DirState): string[] {
    const v = here.vars.PWD
    if (typeof v === 'object') return [normalisePath(v.value)]
    if (v === 'auto') return here.dirs.slice()
    return N1('$PWD', 'a variable')
  }
}

/** Interpreters and shells: code they run could move the shell or make a link. */
export const INTERPRETERS =
  'python[\\d.]*|node|perl|ruby|php|deno|bun|bash|sh|zsh|dash|ksh|pwsh|powershell'
export const INTERPRETER = new RegExp(`^(?:${INTERPRETERS})$`)

/** Whether an interpreter runs a file of the project's own (N6/P7): its first
 *  operand a plain literal path, after options from a short allow-list only,
 *  and nothing in the call wrote a file before. Anything else is code the
 *  call gives it (the coordinator's allow-list). */
// Each interpreter's options that leave it running its file: true takes the
// next word as its value, false takes none; any other option fails closed.
const OWN_FILE_OPTIONS: Readonly<Record<string, Readonly<Record<string, boolean>>>> = {
  python: {
    '-I': false,
    '-B': false,
    '-E': false,
    '-O': false,
    '-OO': false,
    '-q': false,
    '-s': false,
    '-S': false,
    '-u': false,
    '-b': false,
    '-bb': false,
    '-W': true,
    '-X': true,
  },
  ruby: {
    '-I': true,
    '-w': false,
    '-W': false,
    '-W0': false,
    '-W1': false,
    '-W2': false,
    '-v': false,
  },
  perl: { '-I': true, '-w': false, '-W': false, '-X': false },
  node: {},
  php: {},
  deno: {},
  bun: {},
  sh: { '-e': false, '-u': false, '-x': false, '-o': true, '+o': true, '-O': true, '+O': true },
  pwsh: { '-NoProfile': false, '-NonInteractive': false, '-File': false },
}
const ownFileKey = (base: string) =>
  /^python/.test(base)
    ? 'python'
    : /^(?:bash|sh|zsh|dash|ksh)$/.test(base)
      ? 'sh'
      : /^(?:pwsh|powershell)$/.test(base)
        ? 'pwsh'
        : base
const ownFileTable = (base: string) => OWN_FILE_OPTIONS[ownFileKey(base)] ?? {}
/** Options whose value may be attached, where each parser reads it so. */
const ATTACHED: Readonly<Record<string, readonly string[]>> = {
  python: ['-W', '-X'],
  ruby: ['-I'],
  perl: ['-I'],
}

function runsOwnFile(
  base: string,
  rest: readonly Word[],
  redirects: readonly Redirect[],
  wrote: boolean
): boolean {
  if (wrote || redirects.some((r) => /^<(?:<<?|<-|>|&)?$/.test(r.op))) return false
  const table = ownFileTable(base)
  const lits = rest.map((w) => w.literal)
  // Code given anywhere: `-c`, `-e`, `-m`, `-` (also after the operand).
  if (
    lits.some((l) => l === null || /^-[ce]$|^-m$|^-$|^--eval|^-Command$|^-EncodedCommand$/i.test(l))
  )
    return false
  const shell = /^(?:bash|sh|zsh|dash|ksh)$/.test(base)
  for (let k = 0; k < lits.length; k++) {
    const l = lits[k]!
    if (l === '--') return /^[\w./@+-]+$/.test(lits[k + 1] ?? '')
    if (/^[-+]/.test(l)) {
      if (Object.hasOwn(table, l)) {
        if (table[l]) k++
        continue
      }
      // A value attached where the parser reads one: python -W…/-X…, ruby
      // and perl -I…; a shell's cluster letter by letter, each a no-value
      // option of the table (`-ec`, `-lc`: refused).
      const attached = /^(-[A-Za-z])(.+)$/.exec(l)
      if (attached && (ATTACHED[ownFileKey(base)] ?? []).includes(attached[1]!)) continue
      if (shell && /^[-+][A-Za-z]{2,}$/.test(l)) {
        if ([...l.slice(1)].every((c) => table[`${l[0]}${c}`] === false)) continue
        return false
      }
      return false
    }
    return /^[\w./@+-]+$/.test(l)
  }
  return false
}

/** A trap's action that only cleans up: read as commands, each a plain reader
 *  or `rm` on literal paths, no assignment (the review's narrow exemption). */
function cleanupOnly(action: string): boolean {
  if (action.includes('=')) return false
  const r = parseShell(action, 'sh')
  if (!r.ok) return false
  return r.list.items.every(({ node }) =>
    node.stages.every((n) => {
      if (n.type !== 'simple' || n.assigns.length > 0 || n.redirects.length > 0) return false
      const lits = n.words.map((w) => w.literal)
      if (lits.some((l) => l === null)) return false
      const [prog, ...args] = lits as string[]
      if (prog === 'rm') return args.every((a) => /^-[rRf]+$/.test(a) || !a.startsWith('-'))
      // A reader, never a cd (on the reader list for what it writes, not where it goes).
      return prog !== 'cd' && readOnly(prog ?? null, args)
    })
  )
}

/** Commands that only read: the allow-list a source or an interpreter's file
 *  run may follow (anything else may have written it). */
function readOnly(base: string | null, lits: readonly string[]): boolean {
  switch (base) {
    case 'ls':
    case 'cat':
    case 'head':
    case 'tail':
    case 'grep':
    case 'echo':
    case 'printf':
    case 'pwd':
    case 'test':
    case '[':
    case 'true':
    case 'false':
    case 'which':
    case 'cd':
    case 'wc':
    case 'uniq':
    case 'diff':
      return true
    case 'find':
      return !lits.some((l) => /^-(?:exec|execdir|ok|okdir|delete|fprint\w*|fls)$/.test(l))
    case 'sort':
      return !lits.some((l) => /^-[A-Za-z]*o|^--output/.test(l))
    case 'command':
      return /^-[vV]$/.test(lits[0] ?? '')
    default:
      return false
  }
}

/** The program word of a simple command, past `builtin` and `command` with
 *  their options and `--`: the one reading of it the walk uses. Null when
 *  there is none, or it only prints (`command -v`/`-V`). */
function programOf(words: readonly Word[]): { word: Word; at: number } | null {
  let k = 0
  while (k < words.length && /^(?:builtin|command)$/.test(words[k]!.literal ?? '')) {
    const wrapper = words[k]!.literal
    k++
    for (; k < words.length; k++) {
      const o = words[k]!.literal ?? ''
      if (o === '--') {
        k++
        break
      }
      if (!/^-[A-Za-z]+$/.test(o)) break
      if (wrapper === 'command' && /[vV]/.test(o)) return null
    }
  }
  const word = words[k]
  return word ? { word, at: k } : null
}

// ── PowerShell's location cmdlets (FR-016) ────────────────────────────────

const PS_CD: Readonly<Record<string, 'cd' | 'pushd' | 'popd'>> = {
  'set-location': 'cd',
  sl: 'cd',
  cd: 'cd',
  chdir: 'cd',
  'push-location': 'pushd',
  pushd: 'pushd',
  'pop-location': 'popd',
  popd: 'popd',
}
// Their parameters and the common ones, with their aliases: true takes a value.
// Every parameter the location cmdlets bind (theirs and the common ones),
// for telling a prefix apart; true: it takes a value.
const PS_PARAMS: Readonly<Record<string, boolean>> = {
  path: true,
  literalpath: true,
  stackname: true,
  passthru: false,
  erroraction: true,
  warningaction: true,
  informationaction: true,
  progressaction: true,
  errorvariable: true,
  warningvariable: true,
  informationvariable: true,
  outvariable: true,
  outbuffer: true,
  pipelinevariable: true,
  verbose: false,
  debug: false,
  whatif: false,
  confirm: false,
}
// The ones that never change where the location goes: allowed beside the path.
const PS_HARMLESS = new Set([
  'passthru',
  'erroraction',
  'warningaction',
  'informationaction',
  'progressaction',
  'errorvariable',
  'warningvariable',
  'informationvariable',
  'outvariable',
  'verbose',
  'debug',
])

/** A parameter by its name or an unambiguous prefix (as PowerShell binds
 *  it); null when it binds none or more than one. */
function psParam(given: string): string | null {
  const g = given.toLowerCase()
  if (Object.hasOwn(PS_PARAMS, g)) return g
  const all = Object.keys(PS_PARAMS).filter((p) => p.startsWith(g))
  return all.length === 1 ? all[0]! : null
}

/** A PowerShell path as the cd rules read one: `\` a separator, a drive
 *  path absolute, a leading `~` (quoted or not: the provider expands it)
 *  HOME. Its raw text is kept for the refusal (N3). */
function psPath(w: Word): Word {
  const text = w.parts
    .map((p) => (p.kind === 'lit' ? p.text : '~'))
    .join('')
    .replace(/\\/g, '/')
  const path = /^[A-Za-z]:/.test(text) ? `/${text}` : text
  const parts: Part[] = /^~(?:\/|$)/.test(path)
    ? [
        { kind: 'tilde', user: '' },
        ...(path.length > 1 ? [{ kind: 'lit', text: path.slice(1), quoted: false } as Part] : []),
      ]
    : [{ kind: 'lit', text: path, quoted: false }]
  return { parts, literal: parts[0]!.kind === 'lit' ? path : null, raw: w.raw }
}

/** PowerShell's dashes: a word starting with one is a parameter. */
const PS_DASH = /^[-–—―]/
// The founder's allow-list (2026-11-09): letters and digits of any script,
// `. _ -` and separators, a drive letter at the start; inside quotes also
// space and parentheses.
const PS_UNQUOTED = /^[\p{L}\p{N}._\-/\\~]*$/u
const PS_QUOTED = /^[\p{L}\p{N}._\-/\\~ ()]*$/u

/** Why a PowerShell location target is not followed, or null: no variable
 *  or subexpression, `@`, backtick, provider (`::`) or UNC path, or
 *  character outside the allow-list (a word led by a dash is a parameter,
 *  refused in psCd before this). */
function psTargetRefusal(w: Word): string | null {
  const [first] = w.parts
  if (!first) return 'a path that is not plain'
  if (first.kind === 'lit' && first.text.startsWith('@')) return 'splatting'
  const bad = w.parts.find(
    (p, k) => p.kind !== 'lit' && !(k === 0 && p.kind === 'tilde' && p.user === '')
  )
  if (bad) return formOf(bad)
  if (w.raw.includes('`')) return 'a path that is not plain'
  const text = w.parts.map((p) => (p.kind === 'lit' ? p.text : '~')).join('')
  const drive = /^[A-Za-z]:/.test(text) ? 2 : 0
  const ok =
    !/^(?:\\\\|\/\/|[\\/]{2})/.test(text) &&
    w.parts.every((p, k) => {
      if (p.kind !== 'lit') return true
      const t = k === 0 ? p.text.slice(drive) : p.text
      return (p.quoted ? PS_QUOTED : PS_UNQUOTED).test(t)
    })
  return ok ? null : 'a path that is not plain'
}

export type PsCd =
  { name: 'cd' | 'pushd' | 'popd'; rest: Word[] } | { refuse: string; shown: string } | null

/** A PowerShell command as a location command Veilio follows, one it
 *  refuses, or null when it is not one. */
function psCd(words: readonly Word[]): PsCd {
  let k = 0
  const call = words[0]?.literal === '&' || words[0]?.literal === '.'
  if (call) k++
  const prog = words[k]
  if (!prog) return null
  const program = prog.literal?.toLowerCase().replace(/^.*\\/, '')
  const name = program === undefined ? undefined : PS_CD[program]
  // `& $x`, `. $x`, `& 'Set-Location'`: a program Veilio cannot read as one.
  if (call && (prog.literal === null || name)) return { refuse: 'a call operator', shown: prog.raw }
  if (!name) return null
  const rest: Word[] = []
  for (let j = k + 1; j < words.length; j++) {
    const w = words[j]!
    const m = /^[-\u2013\u2014\u2015]([A-Za-z]+)(:?)$/.exec(w.literal ?? '')
    if (!m) {
      if (PS_DASH.test(w.literal ?? w.raw))
        return { refuse: 'a parameter Veilio cannot read', shown: w.raw }
      rest.push(w)
      continue
    }
    const param = psParam(m[1]!)
    if (param === null || (param !== 'path' && param !== 'literalpath' && !PS_HARMLESS.has(param)))
      return { refuse: 'a parameter Veilio cannot read', shown: w.raw }
    if (!PS_PARAMS[param]) continue
    const value = words[++j]
    if (!value) return { refuse: 'a parameter Veilio cannot read', shown: w.raw }
    if (param === 'path' || param === 'literalpath') rest.push(value)
    else if (value.literal === null || !/^[A-Za-z0-9_.]+$/.test(value.literal))
      return { refuse: 'a parameter Veilio cannot read', shown: value.raw }
  }
  if (rest.length > (name === 'popd' ? 0 : 1))
    return { refuse: 'more than one target', shown: rest.map((w) => w.raw).join(' ') }
  // Push-Location alone saves where it is and stays there.
  if (name === 'pushd' && rest.length === 0)
    rest.push({ parts: [{ kind: 'lit', text: '.', quoted: false }], literal: '.', raw: '.' })
  for (const w of rest) {
    const why = psTargetRefusal(w)
    if (why) return { refuse: why, shown: w.raw }
  }
  return { name, rest: rest.map(psPath) }
}

/** `$(pwd)` and `$(git rev-parse --show-toplevel)`: the two substitutions a
 *  cd target may be (Q1 = A). */
function substOf(l: List): 'pwd' | 'toplevel' | null {
  if (l.items.length !== 1) return null
  const p = l.items[0]!.node
  if (p.stages.length !== 1 || p.negated) return null
  const n = p.stages[0]!
  if (n.type !== 'simple' || n.assigns.length > 0 || n.redirects.length > 0) return null
  const w = n.words.map((x) => x.literal)
  if (w[0] === 'pwd' && w.length <= 2 && (w.length === 1 || w[1] === '-L' || w[1] === '-P'))
    return 'pwd'
  if (w.join(' ') === 'git rev-parse --show-toplevel') return 'toplevel'
  return null
}

function formOf(p: Part): string {
  switch (p.kind) {
    case 'param':
    case 'arith':
      return 'a variable'
    case 'subst':
      return 'a command substitution'
    case 'glob':
      return 'a glob'
    case 'brace':
      return 'braces'
    case 'ansic':
      return 'ANSI-C quoting'
    case 'tilde':
      return "another user's home (`~name`)"
    default:
      return 'a variable'
  }
}

/** A word's text as a path, `~` at its start read with HOME (`home`), or
 *  null when the shell builds it otherwise. */
export function wordPath(w: Word, home: string | null): string | null {
  if (w.literal !== null) return w.literal
  const [first, ...rest] = w.parts
  if (first?.kind !== 'tilde' || first.user !== '' || home === null) return null
  if (!rest.every((p) => p.kind === 'lit')) return null
  return home + rest.map((p) => (p as { text: string }).text).join('')
}

/** The cd walk of a command the reader read. A refusal stops it. */
export async function walkCd(
  l: List,
  start: DirState,
  ctx: CdContext,
  dialect: 'sh' | 'ps' = 'sh'
): Promise<CdWalk> {
  const w = new Walker(ctx, dialect === 'ps')
  try {
    const out = await w.list(l, start)
    if (w.link !== null && w.landings.length > 0)
      throw new Refused({ kind: 'N1', target: w.link, form: 'a link made in this command' })
    if (w.homeUnknown && w.tilde) throw new Refused({ kind: 'N2' })
    // The next call starts where the command most likely left the shell:
    // where it succeeded, else where it failed.
    const end = out.ok ?? out.fail ?? start
    let endAll: DirState | null
    try {
      endAll = merge(out.ok, out.fail) ?? start
    } catch (err) {
      if (!(err instanceof Refused)) throw err
      endAll = null
    }
    return { points: w.points, landings: w.landings, refusal: null, end, endAll }
  } catch (err) {
    if (!(err instanceof Refused)) throw err
    return {
      points: w.points,
      landings: w.landings,
      refusal: err.refusal,
      end: start,
      endAll: start,
    }
  }
}

// ── security audit 2026-11-11: spellings and interpreters ───────────────────

const INLINE_INTERPRETER =
  /(?:^|[\s;&|(`])(?:python[\d.]*|pypy[\d]*|node(?:js)?|bun|deno|ruby|perl|php|lua|osascript|pwsh|powershell|(?:ba|z|da|k|c)?sh)(?=\s|$)/i
const INLINE_CODE = /(?:\s-[A-Za-z]*[cerpEC](?=[\s=]|$)|\s--(?:eval|print|command)\b|<<)/

/** An interpreter run on code given in the command (-c, -e, --eval, -r, -p, a
 *  heredoc) whose code, once quotes, backslashes, `+` and whitespace are
 *  removed, names `.veilio`: the maps, credentials and keys kept there are read
 *  or changed by a script under a name it builds. Only the inline code or the
 *  heredoc body is read, not the rest of the command.
 *
 *  shortcut: defence in depth only. A script can build the name from pieces
 *  this does not join (chr(), a list, an environment variable), and an
 *  interpreter run on a file the agent wrote earlier is not read at all.
 *  Programs the agent runs act as the user (SECURITY.md). Upgrade: a sandbox,
 *  not a longer pattern. */
export function interpreterNamesGuardState(command: string): boolean {
  const names = (text: string) =>
    // `.veilio`, not `veilio`: a project or a folder named for the product
    // (a checkout of this repository) must still run its scripts.
    /\.veilio/i.test(text.replace(/[+\s]/g, ''))
  // `"a"."b"` (perl, php) and `"a"+"b"` join like adjacent strings.
  const unquote = (t: string) => t.replace(/['"]\s*[.+]\s*['"]/g, '').replace(/['"\\]/g, '')
  const whole = unquote(command)
  for (const segment of splitChain(command) ?? [command]) {
    const plain = unquote(segment)
    if (!INLINE_INTERPRETER.test(plain)) continue
    const flag = INLINE_CODE.exec(plain)
    if (!flag) continue
    // Only the code the interpreter is given: what follows its inline-code
    // flag, or a heredoc's body (which runs to the end of the command and may
    // hold `;` and `|`, so it is not cut at them).
    const code = flag[0] === '<<' ? whole.slice(whole.indexOf('<<')) : plain.slice(flag.index)
    if (names(code)) return true
  }
  return false
}

/** The alternatives of a brace group's inside: a comma list, or a numeric or
 *  single-letter sequence (`1..3`, `a..e`, with an optional step). Null when
 *  it is neither (`{a}` stays as written); 'big' when a sequence has more than
 *  `limit` members. */
function alternatives(inner: string, limit: number): string[] | 'big' | null {
  const parts: string[] = []
  let depth = 0
  let from = 0
  for (let j = 0; j < inner.length; j++) {
    if (inner[j] === '{') depth++
    else if (inner[j] === '}') depth--
    else if (inner[j] === ',' && depth === 0) {
      parts.push(inner.slice(from, j))
      from = j + 1
    }
  }
  if (parts.length > 0) return [...parts, inner.slice(from)]
  const m = /^(-?\d+|[A-Za-z])\.\.(-?\d+|[A-Za-z])(?:\.\.(-?\d+))?$/.exec(inner)
  if (!m) return null
  const num = /^-?\d+$/.test(m[1]!)
  if (num !== /^-?\d+$/.test(m[2]!)) return null
  const [a, b] = num
    ? [parseInt(m[1]!, 10), parseInt(m[2]!, 10)]
    : [m[1]!.charCodeAt(0), m[2]!.charCodeAt(0)]
  const step = Math.abs(parseInt(m[3] ?? '1', 10)) || 1
  if (Math.abs(b - a) / step + 1 > limit) return 'big'
  const out: string[] = []
  for (let v = a; a <= b ? v <= b : v >= b; v += a <= b ? step : -step)
    out.push(num ? String(v) : String.fromCharCode(v))
  return out
}

/** The top-level brace groups of a word: where each starts and ends, and what
 *  is inside. */
function braceGroups(word: string): { start: number; end: number; inner: string }[] {
  const out: { start: number; end: number; inner: string }[] = []
  let depth = 0
  let open = -1
  for (let i = 0; i < word.length; i++) {
    if (word[i] === '{') {
      if (depth++ === 0) open = i
    } else if (word[i] === '}' && depth > 0 && --depth === 0)
      out.push({ start: open, end: i, inner: word.slice(open + 1, i) })
  }
  return out
}

/** The words a shell word can spell: `{a,b}c` is `ac` and `bc`, `{1..3}` is
 *  `1 2 3`. At most 64; null past that (see braceNames). */
export function expandBraces(word: string, limit = 64): string[] | null {
  const out: string[] = []
  const walk = (w: string): void => {
    if (out.length > limit) return
    for (const g of braceGroups(w)) {
      const alt = alternatives(g.inner, limit)
      if (alt === null) continue
      if (alt === 'big') {
        out.push(...Array(limit + 1).fill(w))
        return
      }
      for (const a of alt) walk(w.slice(0, g.start) + a + w.slice(g.end + 1))
      return
    }
    out.push(w)
  }
  walk(word)
  return out.length > limit ? null : out
}

/** Every brace group of a word read as "anything": `**`. */
const wildBraces = (w: string): string => {
  let out = ''
  let at = 0
  for (const g of braceGroups(w))
    if (alternatives(g.inner, 64) !== null) {
      out += `${w.slice(at, g.start)}**`
      at = g.end + 1
    }
  return out + w.slice(at)
}

/** What a shell word can spell, as names and globs: expanded when it has no
 *  more than 64 spellings; otherwise one candidate per alternative of each
 *  group, the other groups read as `**` (a sum of the groups' sizes, not their
 *  product), so a name hidden among many alternatives is still seen and an
 *  ordinary `mkdir -p {a,b,c,d}/{e,f,g,h}/{i,j,k,l,m}` is not refused. */
export function braceNames(word: string): string[] {
  const exact = expandBraces(word)
  if (exact !== null) return exact
  const out: string[] = []
  for (const g of braceGroups(word)) {
    const alt = alternatives(g.inner, 64)
    if (alt === null || alt === 'big') continue
    const before = wildBraces(word.slice(0, g.start))
    const after = wildBraces(word.slice(g.end + 1))
    for (const a of alt) out.push(before + wildBraces(a) + after)
  }
  return out.length > 0 ? out : [wildBraces(word)]
}

type GlobToken =
  | { kind: 'char'; c: string }
  | { kind: 'any' }
  | { kind: 'star'; deep: boolean }
  | { kind: 'class'; set: string; negated: boolean }

function globTokens(glob: string): GlobToken[] {
  const out: GlobToken[] = []
  for (let i = 0; i < glob.length; i++) {
    const c = glob.charAt(i)
    if (c === '*') {
      const deep = glob[i + 1] === '*'
      if (deep) i++
      out.push({ kind: 'star', deep })
    } else if (c === '?') out.push({ kind: 'any' })
    else if (c === '[' && glob.indexOf(']', i + 2) > 0) {
      const end = glob.indexOf(']', i + 2)
      const negated = /^[!^]/.test(glob.slice(i + 1, end))
      out.push({ kind: 'class', set: glob.slice(i + 1 + (negated ? 1 : 0), end), negated })
      i = end
    } else out.push({ kind: 'char', c: c.toLowerCase() })
  }
  return out
}

/** Whether one string could match both globs (ignoring case, `*` and `?`
 *  stopping at `/`, `**` not). `a` is a shell word, so its wildcards do not
 *  match a leading `.` (`*.ts` is not `.env.ts`); `b` is a raw-only pattern.
 *  A class is read as able to match whatever it is set against: this errs
 *  toward refusing. */
function globsOverlap(a: string, b: string): boolean {
  const A = globTokens(a)
  const B = globTokens(b)
  const seen = new Map<number, boolean>()
  // A word's segment of nothing but wildcards (`*`, `?`) stands for no
  // particular name, or `ls *` and `lib/*/*.rb` could never run: it matches a
  // pattern's wildcards only, not its letters. And a pattern's own `*` takes
  // none of the word's letters (`*.ts` is not `id_rsa*`), only `**` does.
  const bareWild = (i: number) => {
    let k = i
    while (k > 0 && !isSlash(A[k - 1]!)) k--
    for (; k < A.length && !isSlash(A[k]!); k++) if (A[k]!.kind === 'char') return false
    return true
  }
  const dotStart = (j: number) => j === 0 || isSlash(B[j - 1]!)
  const single = (t: GlobToken, u: GlobToken, i: number, j: number): boolean => {
    if (t.kind === 'char' && u.kind === 'char') return t.c === u.c
    if (t.kind !== 'char' && u.kind === 'char') {
      if (bareWild(i) || (u.c === '.' && dotStart(j))) return false
    }
    const lit = t.kind === 'char' ? t : u.kind === 'char' ? u : null
    const other = lit === t ? u : t
    if (!lit) return true
    if (other.kind === 'any') return lit.c !== '/'
    if (other.kind === 'class') {
      const inSet = other.set.toLowerCase().includes(lit.c) || /[a-z]-[a-z]/i.test(other.set)
      return lit.c !== '/' && (other.negated ? true : inSet)
    }
    return true
  }
  const go = (i: number, j: number): boolean => {
    const key = i * (B.length + 1) + j
    const known = seen.get(key)
    if (known !== undefined) return known
    seen.set(key, false)
    const x = A[i]
    const y = B[j]
    let r: boolean
    if (!x && !y) r = true
    else if (x?.kind === 'star')
      r =
        go(i + 1, j) ||
        (!!y &&
          go(i, j + 1) &&
          (x.deep || !isSlash(y)) &&
          !(y.kind === 'char' && (bareWild(i) || (y.c === '.' && dotStart(j)))))
    else if (y?.kind === 'star') r = go(i, j + 1) || (!!x && y.deep && go(i + 1, j))
    else r = !!x && !!y && single(x, y, i, j) && go(i + 1, j + 1)
    seen.set(key, r)
    return r
  }
  return go(0, 0)
}
const isSlash = (t: GlobToken) => t.kind === 'char' && t.c === '/'

/** A word with a wildcard that could stand for a raw-only file: some tail of
 *  its path overlaps one of the patterns (a pattern without `/` is a name
 *  anywhere, as isRawOnly reads it). A segment of nothing but wildcards is
 *  not counted, or `ls *` and `rm *.o` could never run.
 *
 *  shortcut: it does not look at the files that exist, so a glob that could
 *  match a raw-only name is refused when no such file is there. */
export function globMayBeRawOnly(word: string, extra: readonly string[]): boolean {
  const segments = normalisePath(word)
    .split('/')
    .filter((s) => s !== '' && s !== '.' && s !== '..' && s !== '~')
  const literal = (s: string) => /[^*?[\]!^]/.test(s.replace(/\[[^\]]*\]/g, ''))
  if (!segments.some(literal)) return false
  const patterns = [
    ...DEFAULT_RAW_ONLY,
    ...extra.filter((p) => p && !p.startsWith('!')).map((p) => normaliseRawOnlyPattern(p) ?? p),
  ]
  return patterns.some((p) =>
    p.includes('/')
      ? segments.some((_, i) => globsOverlap(segments.slice(i).join('/'), p))
      : segments.some((s) => literal(s) && globsOverlap(s, p))
  )
}

/** What `$'...'` spells: the escapes read as bash reads them. */
function ansiC(text: string): string {
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

/** A word as the shell would spell it before it expands anything but quotes
 *  and escapes: plain text, wildcards and braces stay as they are, and a
 *  wildcard or brace that was quoted is made an ordinary character. `$'..'`
 *  is decoded, and a leading `~`, `$HOME` and `${HOME}` are the known `home`.
 *
 *  Anything else the shell builds (`$x`, `$(...)`, `~user`) is unknown and
 *  stands as `**`, "anything", but only in a word that also has a wildcard or
 *  a brace: `ls $DIR/*.ts` is judged as `**` followed by `/*.ts`, and
 *  `cat $DIR/.v*` as a glob that could be `.veilio`; a word with an unknown
 *  part and no wildcard (`cat $F`) is null, as it always was. */
export function spelledWord(w: Word, home: string | null = null): string | null {
  const quote = (t: string) => t.replace(/[*?[\]{},]/g, '\u0001')
  let out = ''
  let unknown = false
  let wild = false
  for (const p of w.parts) {
    if (p.kind === 'lit') out += p.quoted ? quote(p.text) : p.text
    else if (p.kind === 'glob' || p.kind === 'brace') {
      wild = true
      out += p.text
    } else if (p.kind === 'tilde' && p.user === '' && home !== null) out += quote(home)
    else if (p.kind === 'param' && p.name === 'HOME' && p.op === '' && home !== null)
      out += quote(home)
    else if (p.kind === 'ansic' && p.text.startsWith("$'")) out += quote(ansiC(p.text.slice(2, -1)))
    else {
      unknown = true
      out += '**'
    }
  }
  return unknown && !wild ? null : out
}
