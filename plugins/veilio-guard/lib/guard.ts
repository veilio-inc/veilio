// The guard: what happens to a tool call, a prompt and a reminder on their way
// to the model (spec 033 US1, US2). hooks/register.ts wires Claude Code's
// events to it; file access comes in through GuardIO, so the order of every
// check below is the same in a session and in a test.
//
// Orderings that matter (Constitution IV):
//  - the raw-only check runs on the path as written AND as restored, before
//    the tool runs;
//  - an edit runs only after a strict restore;
//  - new map entries are written to .veilio/map.json before the text that uses
//    them is returned, so a placeholder the model sees can always be restored;
//  - the secret re-scan is the last thing before a result is returned.
import { deepRewrite, deepRewritePaths, rewriteFields } from './fields.ts'
import {
  mergeAdditions,
  parseMapFile,
  parseReservedFile,
  serialiseMapFile,
  type Reserved,
  type StoredMap,
  type SymbolMap,
} from './mapfile.ts'
import {
  cdIntoRawOnly,
  cdTargets,
  DEFAULT_RAW_ONLY,
  isRawOnly,
  isWriteProtected,
  normalisePath,
  pathsInCommand,
  rawOnlyDirectories,
} from './paths.ts'
import { restoreRefusal } from './shell.ts'
import { bounded, LATE, ProjectIndex } from './index.ts'
import {
  argumentPolicy,
  isSourcePath,
  languageOf,
  languageOfCommand,
  isCode,
  languageOfGrepLine,
  resultPolicy,
} from './policy.ts'
import {
  applyMap,
  Destroyed,
  destroyedValues,
  encodedName,
  restoreAdds,
  grow,
  ownedMap,
  type Withheld,
  redactKnown,
  restoresNeverRestored,
  maskShaped,
  keyedRun,
  namesSecret,
  NO_CONTEXT,
  restoreArgs,
  scrubSource,
  survivingSecrets,
  versionOf,
} from './scrub.ts'
import type { MaskContext, Numbering, Prepared, ScanResult } from './scrub.ts'
import { fileKindOf, restore, ruleBudget, scanSecrets, valueSpans } from '../vendor/engine/index.js'
import type { RuleBudget } from '../vendor/engine/index.js'
import { MODEL_NOTE } from './ui.ts'
import { NO_RULES, readGuardRules, type GuardRules } from './rules.ts'
import { wholeEntries } from './listings.ts'
import { parseSearchOutput, searchCommand, searchPath, type SearchFormat } from './search.ts'

export interface GuardIO {
  read(path: string): Promise<string>
  write(path: string, text: string): Promise<void>
  exists(path: string): Promise<boolean>
  /** Where a path really leads (symbolic links followed), or undefined. */
  realPath(path: string): Promise<string | undefined>
  /** Whether a path is a regular file (links followed). Absent: search
   *  output is masked line by line only (spec 074). */
  isFile?(path: string): Promise<boolean>
  /** A file's size in bytes (links followed), or undefined. Absent: no file
   *  is read as a mounted secret (spec 074). */
  fileSize?(path: string): Promise<number | undefined>
  /** The project's tracked files, relative to `root` (`git ls-files`), or null
   *  when it cannot be listed. Absent: the project is never listed, and only
   *  the files a result names are indexed. */
  list?(root: string): Promise<string[] | null>
  /** Resolves after `ms` ($.clock.sleep): bounds a read or `git` that hangs. */
  sleep?(ms: number): Promise<void>
  /** Spec 078 R6: makes a file owner-only (0600). Absent (Windows): files
   *  are written as the host makes them. */
  chmod?(path: string): Promise<void>
  /** A file's permission bits, or undefined when they cannot be read. */
  mode?(path: string): Promise<number | undefined>
}

// Keys whose value in a record is an enum or a status (`type`, `status`):
// Claude Code refuses a record whose enum changed, so the identifier-shape
// fallback leaves these. Every other value is shape-masked (review of ef1a533).
const ENUM_KEYS = new Set(['type', 'status', 'mode', 'kind', 'state', 'subtype', 'role'])

/** deepRewrite, with the key each string sits under. */
// The key is passed only at the record's top level, and in the blocks of a root
// list (an MCP result's `type`), as `keep` works in fields.ts; deeper it is ''.
function rewriteKeyed(
  value: unknown,
  fn: (s: string, key: string) => string,
  key = '',
  top = true
): unknown {
  if (typeof value === 'string') return fn(value, key)
  if (Array.isArray(value)) return value.map((v) => rewriteKeyed(v, fn, '', top))
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, rewriteKeyed(v, fn, top ? k : '', false)])
    )
  return value
}

export interface GuardConfig {
  rawOnly: readonly string[]
  mcpRestore: readonly string[]
}

/** A part of a text held as one mark while the rest is masked. */
type HeldSpan = { at: number; length: number; key: string }

export type GuardState = 'on' | 'off' | 'stopped'
export type ToolEvent = Record<string, unknown> & { tool: string }
export type ToolOutcome = { deny: string } | { result: unknown; isError?: true }

// Keys Claude Code adds to a tool call's event; none of them is the tool's own.
const RESERVED = new Set(['tool', 'tool_use_id', 'consent', 'agentId'])

/** What a placeholder may put back into a shell command: an identifier- or
 *  path-shaped ASCII word, never an option (security audit 2026-11-01; an
 *  allowlist, after the review of 638edbf showed `--output=...` passing). */
const SHELL_SAFE = /^(?!-)[A-Za-z0-9_./@+:-]+$/
const MAX_RETRIES = 3

export const WITHHELD_FAILED =
  'Veilio withheld this result: the guard failed while checking it. Nothing from it was sent.'
/** strings.md #11, as `withheld` completes it. */
export const RESHAPED_CREDENTIAL =
  'a credential removed earlier in this session came back in another form (spaced, split, sliced or encoded). Nothing from it was sent'
/** strings.md #12, as `withheld` completes it. */
export const ENCODED_NAME =
  'it holds a project name encoded (base64, hex, reversed or spelled down a column). Nothing from it was sent'
/** strings.md #15 and #16. */
export const BACK_ON =
  'Veilio guard is back on: an off setting in .veilio/guard.json was ignored, because a file in the project can be written by the agent. To switch the guard off for this project, run /veilio off.'
export const MCP_IGNORED =
  "Veilio: mcpRestore in .veilio/guard.json was ignored, because a file in the project can be written by the agent. Set it in the plugin's settings (/config)."
/** strings.md #9. */
const SETTINGS_PROTECTED =
  "Claude Code's settings can switch the guard off, so the agent may not change them. Ask the user to make this change"
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
export const PROMPT_FAILED =
  'Veilio could not check this prompt, so it was not sent. Try again, or run /veilio to see why.'

export function withheld(reason: string): { deny: string } {
  return { deny: `Veilio withheld this result: ${reason}.` }
}

function isPathLike(s: string): boolean {
  return s.length > 0 && s.length < 4096 && !/\s/.test(s)
}

function join(dir: string, ...parts: string[]): string {
  return [dir.replace(/[\\/]+$/, ''), ...parts].join('/')
}

function parent(dir: string): string | null {
  const trimmed = dir.replace(/[\\/]+$/, '')
  const i = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return i > 0 ? trimmed.slice(0, i) : null
}

// The words for each kind a restoration may not write back: one table, so a
// refusal reads the same wherever it is made.
const WITHHELD_TEXT: Record<Withheld['kind'], string> = {
  credential: 'a credential Veilio removed',
  manual: 'a value marked by hand',
  regulated: 'a regulated number Veilio masks',
}
const withheldText = (w: Withheld) =>
  w.label ? `${WITHHELD_TEXT[w.kind]} (${w.label})` : WITHHELD_TEXT[w.kind]

export class Guard {
  state: GuardState = 'on'
  stoppedReason = ''
  root = ''
  /** The user's home ($HOME): where the off record is kept (spec 078 FR-010). */
  home: string | undefined
  /** Said once a session (register.ts logs them): settings the guard ignored. */
  notices: string[] = []
  /** The off record could not be read: the guard stays on, and the band says so. */
  offRecordUnreadable = false
  /** The session's working directory: what a search's paths are read from. */
  cwd = ''
  /** Spec 074 pass 2 over search output; off, a search is masked exactly as
   *  before (the differential test's baseline). */
  searchPass2 = true
  /** Runs pass 2 could not write back line by line and masked whole: never
   *  expected (replaceCuts keeps the line count); the tests assert 0. */
  searchUnsplit = 0
  /** Pass 2 runs that failed and left their result as before: never
   *  expected; the tests assert 0 (T024 review). */
  searchFailed = 0
  /** A shell command this session changed directory: Claude Code's shell
   *  keeps it, so a shell search's relative paths may be another directory's
   *  and are read as before from then on (T024 review). */
  shellMoved = false
  stored: StoredMap = { version: 1, map: {} }
  extraRawOnly: string[] = []
  mcpRestore: string[] = []
  /** rulesStopped: Reads whose custom rules ran out of matching budget (security audit). */
  counts = { withheld: 0, denied: 0, outsideReserved: 0, rulesStopped: 0 }
  /** The newest hook invocation's rule budget, read by the band only: work
   *  draws on the budget it is handed, never on this. */
  latest: RuleBudget = ruleBudget()
  /** What the running index batch draws on: the budget of the hook (or the
   *  background slice) that started it. Batches run one at a time. */
  private indexBudget: RuleBudget = ruleBudget()

  /** A new hook invocation's allowance of rule-matching steps, shared by every
   *  file and tool output it masks and threaded through its calls, so nothing
   *  else - a background index slice, another hook - can refill it (security
   *  review). A spent one before it is counted, for the band. */
  invocation(): RuleBudget {
    if (this.latest.spent) this.counts.rulesStopped++
    return (this.latest = ruleBudget())
  }
  /** Spec 063: this member's blocks of team numbers (.veilio/reserved.json), or why there are none. */
  reserved: Reserved | null = null
  /** Credentials destroyed this session, in memory only: removed from
   *  everything masked after, under one token each (review of 8aed5e8). */
  readonly destroyed = new Destroyed()
  /** The project's source files, indexed so a result is masked by what it
   *  contains (spec 050). Created when the guard loads. */
  index: ProjectIndex | null = null
  /** The account's custom rules, read once when the guard loads (spec 065). */
  rules: GuardRules = NO_RULES
  private writes: Promise<unknown> = Promise.resolve()
  private indexing: Promise<unknown> = Promise.resolve()
  private unsaved: SymbolMap = ownedMap()
  private batch: string[] = []

  constructor(
    private readonly io: GuardIO,
    private readonly config: GuardConfig
  ) {}

  get reservedPath(): string {
    return join(this.root, '.veilio', 'reserved.json')
  }

  /** What new names are numbered from (spec 066). No file: no team, numbered
   *  as always. A file: its usable blocks, else the checkout's local family -
   *  under the file's tag, or one held for this session when the file has
   *  none (an older CLI's) or cannot be read (never numbered from). */
  get numbering(): Numbering | undefined {
    const r = this.reserved
    if (!r) return undefined
    const retired = Object.keys(this.aliases)
    if (!r.ok) return { blocks: {}, tag: this.sessionTag(), retired }
    return { blocks: r.blocks, tag: r.tag ?? this.sessionTag(), retired }
  }

  private drawnTag: string | null = null
  private sessionTag(): string {
    if (this.drawnTag === null) {
      const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
      // Modulo bias of 2^32 % 36 is about 1e-9: immaterial for a tag.
      const draw = globalThis.crypto.getRandomValues(new Uint32Array(6))
      this.drawnTag = [...draw].map((n) => alphabet[n % alphabet.length]).join('')
    }
    return this.drawnTag
  }

  /** Spec 066 R5: the old placeholders a publish renumbered (.veilio/aliases.json),
   *  read only, so an edit written with one still lands on the real name. */
  private aliases: SymbolMap = {}

  /** What a tool's arguments are restored from: the saved map, and the
   *  renumbered old placeholders where the map does not give them another
   *  name (a contested one is in neither, as in the CLI). Quarantine never. */
  private get restoreMap(): SymbolMap {
    this.settle()
    const map = this.stored.map
    const keys = Object.keys(this.aliases)
    if (keys.length === 0) return map
    // One object per (map, aliases): restoreArgs caches its matcher by map object.
    const c = this.restoreCache
    if (c && c.map === map && c.aliases === this.aliases && c.version === versionOf(map))
      return c.out
    const out: SymbolMap = { ...this.aliases, ...map }
    for (const p of keys) if (p in map && map[p] !== this.aliases[p]) delete out[p]
    this.restoreCache = { map, aliases: this.aliases, version: versionOf(map), out }
    return out
  }
  private restoreCache: {
    map: SymbolMap
    aliases: SymbolMap
    version: number
    out: SymbolMap
  } | null = null

  get mapPath(): string {
    return join(this.root, '.veilio', 'map.json')
  }

  get settingsPath(): string {
    return join(this.root, '.veilio', 'guard.json')
  }

  /** Names that hold a credential Veilio destroyed, each with a placeholder
   *  of its own: masked this session, never saved, never restored (review of
   *  7b930ad). */
  private quarantine: SymbolMap = {}
  private quarantineNext = 0
  private merged: { base: SymbolMap; size: number; map: SymbolMap } | null = null

  /** Spec 078 FR-006, at load: a saved entry sharing 12 characters with a
   *  credential removed this session goes to the quarantine, in memory only,
   *  so it is never restored. Re-run when the map or that set changes. */
  private settledFor: { stored: StoredMap; version: number } | null = null
  private quarantinedNames = new Map<string, string>()
  private settle(): void {
    const s = this.settledFor
    if (s && s.stored === this.stored && s.version === this.destroyed.version) return
    const map = this.stored.map
    const out = Object.entries(map).filter(([, name]) => !this.destroyed.sharesWindow(name))
    if (out.length < Object.keys(map).length) {
      for (const [, name] of Object.entries(map)) {
        if (!this.destroyed.sharesWindow(name) || this.quarantinedNames.has(name)) continue
        const own = `__QUARANTINED__${++this.quarantineNext}`
        this.quarantinedNames.set(name, own)
        this.quarantine[own] = name
        this.destroyed.hold(name, own)
      }
      this.stored = { ...this.stored, map: ownedMap(Object.fromEntries(out)) }
    }
    this.settledFor = { stored: this.stored, version: this.destroyed.version }
  }

  /** What masking reads: the saved map and this session's quarantine. */
  get map(): SymbolMap {
    this.settle()
    const size = Object.keys(this.quarantine).length
    if (size === 0) return this.stored.map
    if (!this.merged || this.merged.base !== this.stored.map || this.merged.size !== size) {
      for (const key of Object.keys(this.quarantine))
        if (Object.hasOwn(this.stored.map, key))
          throw new Error('a quarantined placeholder is also a saved one')
      this.merged = { base: this.stored.map, size, map: { ...this.stored.map, ...this.quarantine } }
    }
    return this.merged.map
  }

  /** The project root: the nearest directory with .veilio or .git, as the CLI finds it. */
  async load(cwd: string, home?: string): Promise<void> {
    let dir: string | null = cwd
    this.root = cwd
    this.cwd = cwd
    while (dir) {
      if (
        (await this.io.exists(join(dir, '.veilio'))) ||
        (await this.io.exists(join(dir, '.git')))
      ) {
        this.root = dir
        break
      }
      dir = parent(dir)
    }
    // Security audit 2026-11-01: files under .veilio/ committed to the
    // repository are its author's, not this checkout's.
    const committed = await this.trackedVeilioFiles()
    // Spec 078 R7: with no listing, nobody can tell who wrote the map.
    this.noListing = committed === null
    this.home = home
    await this.readSettings()
    await this.readOffRecord()
    await this.reloadMap()
    // A committed map or aliases file: its values would be restored into
    // commands the model only saw as placeholders.
    const tracked = (committed ?? []).filter((f) => f !== '.veilio/guard.json')
    if (tracked.length)
      this.stop(
        `${tracked.join(' and ')} ${tracked.length > 1 ? 'are' : 'is'} tracked by git: a map in the repository is not yours to restore from. Remove it from git (git rm --cached) and pull or build your own`
      )
    this.rules = await readGuardRules((path) => this.io.read(path), home)
    this.index = new ProjectIndex(
      {
        list: () => (this.io.list ? this.io.list(this.root) : Promise.resolve(null)),
        read: (rel) => this.io.read(join(this.root, rel)),
        now: () => Date.now(),
        wait: this.io.sleep ? (ms) => this.io.sleep!(ms) : undefined,
      },
      async (rel, text, language) => {
        const { additions, outside, rulesStopped } = scrubSource(
          text,
          { ...this.map, ...this.unsaved },
          language,
          undefined,
          undefined,
          this.numbering,
          this.rules.rules,
          this.indexBudget
        )
        this.counts.outsideReserved += outside
        if (rulesStopped) this.counts.rulesStopped++
        grow(this.unsaved, additions)
        this.batch.push(rel)
      },
      (rel) => isRawOnly(join(this.root, rel), this.extraRawOnly)
    )
  }

  // ── project index (spec 050) ──────────────────────────────────────────────

  /** Indexes `paths` before `deadline` and saves what they add, in one write.
   *  Returns the paths it could not index. One batch at a time: the map's
   *  placeholders are numbered from what the last batch saved. */
  indexFiles(
    paths: readonly string[],
    deadline: number,
    budget: RuleBudget = ruleBudget()
  ): Promise<string[]> {
    const run = this.indexing.then(() =>
      this.indexBatch(deadline, budget, () => this.index!.index(paths, deadline))
    )
    this.indexing = run.catch(() => undefined)
    // Waiting for the batch ahead counts against this deadline too: late, every
    // path is unchecked, and the result naming them is withheld.
    return bounded(run, deadline, this.clock).then((r) => (r === LATE ? [...paths] : r))
  }

  private get clock() {
    return {
      now: () => Date.now(),
      wait: this.io.sleep ? (ms: number) => this.io.sleep!(ms) : undefined,
    }
  }

  /** Continues through the project's files not indexed yet, until `deadline`. */
  indexProject(deadline: number, budget: RuleBudget = ruleBudget()): Promise<string[]> {
    const run = this.indexing.then(() =>
      this.indexBatch(deadline, budget, async () => {
        await this.index!.run(deadline)
        return []
      })
    )
    this.indexing = run.catch(() => undefined)
    return run
  }

  private async indexBatch(
    deadline: number,
    budget: RuleBudget,
    work: () => Promise<string[]>
  ): Promise<string[]> {
    if (!this.index) return []
    this.indexBudget = budget
    // The listing gives the project's shape (what is external); a late one
    // only means fewer names are exempt, so the batch goes on without it.
    await bounded(this.index.start(), deadline, this.clock)
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      this.unsaved = ownedMap()
      this.batch = []
      const missed = await work()
      if (Object.keys(this.unsaved).length === 0) return missed
      let saved: 'saved' | 'conflict'
      let quarantined: number
      try {
        ;({ status: saved, quarantined } = await this.save(this.unsaved))
      } catch (err) {
        // Not left marked as indexed: their names were never saved.
        for (const rel of this.batch) this.index.forget(rel)
        throw err
      } finally {
        this.unsaved = ownedMap()
      }
      // Files whose names went to the quarantine are indexed again later, so
      // nothing of theirs is taken as saved.
      if (quarantined > 0) for (const rel of this.batch) this.index.forget(rel)
      if (saved === 'saved') return missed
      // Another program changed the map: this batch's numbers may clash with
      // its, so the batch is indexed again from the map as it is now.
      for (const rel of this.batch) this.index.forget(rel)
    }
    throw new Error('another program kept changing .veilio/map.json while Veilio was writing to it')
  }

  /** The project source files a result names, relative to the root: a Grep
   *  match's path, a path in output or a stack trace, the file a command
   *  prints. `unresolved` counts source-shaped paths that name no file the
   *  guard can find: their file may be one it has not indexed yet. */
  private namedSources(
    args: ToolEvent,
    texts: string[]
  ): { found: string[]; unresolved: string[] } {
    const roots = [this.root, this.root.replace(/^\/private(?=\/)/, ''), `/private${this.root}`]
    const found = new Set<string>()
    const loose: string[] = []
    const consider = (raw: string) => {
      let p = raw.replace(/:\d+(?::\d+)?$/, '')
      const under = roots.find((r) => p.startsWith(`${r}/`))
      if (under) p = p.slice(under.length + 1)
      else if (p.startsWith('/')) return // outside the project
      p = p.replace(/^(?:\.\.?\/)+/, '')
      if (!p || !isSourcePath(p) || /(^|\/)node_modules\//.test(p)) return
      if (this.index) {
        const resolved = this.index.resolve(p)
        if (resolved !== null) return void found.add(resolved)
      }
      loose.push(p)
    }
    for (const text of texts) {
      // Windows separators and file URLs name the same files.
      const plain = text.replace(/file:\/\//g, '').replace(/\\/g, '/')
      for (const m of plain.matchAll(
        /(?:^|[\s('"`=[<;:|,])((?:\.{0,2}\/|\/)?[\w@.$-]+(?:\/[\w@.$-]+)*\.[A-Za-z0-9]+)(?=$|[\s:)'"`,\]>;}|])/gm
      ))
        consider(m[1]!)
    }
    if (typeof args.command === 'string' && languageOfCommand(args.command) !== 'unknown')
      for (const word of pathsInCommand(args.command)) consider(word)
    return { found: [...found], unresolved: loose }
  }

  /** Indexes what a result names, and says why not when it cannot. The reason
   *  reaches the model, so it names no path: a path can hold a project name. */
  private async indexNamed(
    args: ToolEvent,
    texts: string[],
    deadline: number,
    budget: RuleBudget
  ): Promise<string | null> {
    if (!this.index) return null
    // Paths resolve against the listing, so it comes first (bounded: a late
    // listing leaves every unknown path to the disk check below).
    await bounded(this.index.start(), deadline, this.clock)
    const { found, unresolved } = this.namedSources(args, texts)
    const exist: string[] = []
    let missing = 0
    for (const rel of [...found, ...unresolved]) {
      const onDisk = await this.findOnDisk(rel)
      if (onDisk) exist.push(onDisk)
      // Found only by stripping directories, it may be another file than the
      // one printed: indexed, but not counted as checked (security review of
      // 2947c81). Only a complete index then lets the result through.
      if (onDisk !== rel) missing++
    }
    const missed = exist.length ? await this.indexFiles(exist, deadline, budget) : []
    // A path the guard could not find may be in a file it has not indexed yet
    // (a name with a space, a form it does not read): the index is finished
    // first, or the result waits.
    if (missing > 0 && this.index.state === 'indexing') await this.indexProject(deadline, budget)
    const files = (n: number) => `${n} source file${n === 1 ? '' : 's'}`
    const unread = missed.filter((rel) => this.index!.failed.has(rel)).length
    if (unread) return `it names ${files(unread)} Veilio could not read to check`
    if (missed.length)
      return `Veilio is still indexing the project and has not checked ${files(missed.length)} it names yet`
    // Only a complete index can say a path it cannot find is not the project's.
    // With no listing, or a late one, the result waits (final review of b0dded9).
    if (missing > 0 && this.index.state !== 'complete')
      return this.index.state === 'indexing'
        ? 'Veilio is still indexing the project and could not tell which file it names'
        : 'Veilio could not list the project, and the result names a source file it could not find'
    return null
  }

  /** `rel` as a file under the root, in the forms tools print it: as written,
   *  without a diff's `a/` or `b/`, or without up to three leading directories
   *  (output printed from a subdirectory). */
  private async findOnDisk(rel: string): Promise<string | null> {
    const parts = rel.replace(/^[ab]\//, '').split('/')
    const forms = [rel, ...[0, 1, 2, 3].map((n) => parts.slice(n).join('/'))]
    for (const form of new Set(forms))
      if (form.includes('.') && (await this.io.exists(join(this.root, form)))) return form
    return null
  }

  /** Spec 078 FR-009: guard.json, which the agent's tools can write by some
   *  route, may only tighten - add raw-only paths - whoever wrote it, tracked
   *  or not. Its mcpRestore and enabled are ignored, and said once. */
  private async readSettings(): Promise<void> {
    this.extraRawOnly = [...this.config.rawOnly]
    this.mcpRestore = [...this.config.mcpRestore]
    if (!(await this.io.exists(this.settingsPath))) return
    let settings: { enabled?: unknown; rawOnly?: unknown; mcpRestore?: unknown }
    try {
      settings = JSON.parse(await this.io.read(this.settingsPath))
    } catch {
      this.stop(`.veilio/guard.json is not valid JSON`)
      return
    }
    if (Array.isArray(settings.rawOnly)) {
      this.extraRawOnly.push(...settings.rawOnly.filter((p): p is string => typeof p === 'string'))
    }
    if (settings.enabled === false) this.notice(BACK_ON)
    if (settings.mcpRestore !== undefined) this.notice(MCP_IGNORED)
  }

  private said = new Set<string>()
  private notice(text: string): void {
    if (this.said.has(text)) return
    this.said.add(text)
    this.notices.push(text)
  }

  get offRecordPath(): string | undefined {
    return this.home ? join(this.home, '.veilio', 'guard-state.json') : undefined
  }

  /** The project's key in the off record: the root's real path. */
  private async recordKey(): Promise<string> {
    return (await this.io.realPath(this.root)) ?? this.root
  }

  /** The off record, or null when there is none; throws when it cannot be read. */
  private async offRecord(): Promise<{ version: 1; projects: Record<string, unknown> } | null> {
    const path = this.offRecordPath
    if (!path || !(await this.io.exists(path))) return null
    const parsed: unknown = JSON.parse(await this.io.read(path))
    const projects = (parsed as { projects?: unknown } | null)?.projects
    if (!projects || typeof projects !== 'object' || Array.isArray(projects))
      throw new Error('not an off record')
    return { version: 1, projects: projects as Record<string, unknown> }
  }

  /** Spec 078 FR-010: whether /veilio off was run for this project. An
   *  unreadable record never turns the guard off. */
  private async readOffRecord(): Promise<void> {
    this.offRecordUnreadable = false
    try {
      const record = await this.offRecord()
      const entry = record?.projects[await this.recordKey()] as { enabled?: unknown } | undefined
      if (entry?.enabled === false && this.state === 'on') this.state = 'off'
    } catch {
      this.offRecordUnreadable = true
    }
  }

  /** Spec 063: read the member's blocks. Never fatal: without them the guard numbers as it always did. */
  async reloadReserved(): Promise<void> {
    if (!(await this.io.exists(this.reservedPath))) {
      this.reserved = null
      return
    }
    try {
      this.reserved = parseReservedFile(await this.io.read(this.reservedPath))
    } catch (err) {
      this.reserved = { ok: false, reason: err instanceof Error ? err.message : String(err) }
    }
  }

  /** reserved.json and aliases.json, re-read whenever the map is: a CLI
   *  publish rewrites all three at once (code review of spec 066). */
  private async reloadSideFiles(): Promise<void> {
    await this.reloadReserved()
    this.aliases = await this.readAliases()
    // A session tag whose placeholders a publish retired is not used again.
    const tag = this.drawnTag
    if (tag && Object.keys(this.aliases).some((p) => p.startsWith(`__LOCAL_${tag}_`)))
      this.drawnTag = null
  }

  async reloadMap(): Promise<void> {
    await this.reloadSideFiles()
    if (!(await this.io.exists(this.mapPath))) {
      this.stored = { version: 1, map: {} }
      return
    }
    const parsed = parseMapFile(await this.io.read(this.mapPath))
    if (!parsed.ok) {
      this.stop(`the map at .veilio/map.json could not be read: ${parsed.reason}`)
      return
    }
    this.stored = parsed.stored
  }

  /** Never fatal: a missing or unreadable file restores nothing extra. */
  private async readAliases(): Promise<SymbolMap> {
    const path = join(this.root, '.veilio', 'aliases.json')
    try {
      if (!(await this.io.exists(path))) return {}
      const parsed = JSON.parse(await this.io.read(path)) as { aliases?: unknown }
      const a = parsed?.aliases
      if (!a || typeof a !== 'object' || Array.isArray(a)) return {}
      return Object.fromEntries(
        Object.entries(a).filter((e): e is [string, string] => typeof e[1] === 'string')
      )
    } catch {
      return {}
    }
  }

  /** `.veilio/map.json`, `aliases.json` and `guard.json` when git tracks
   *  them; null when that cannot be known (not a git checkout, no listing in
   *  time, or no way to list). */
  private async trackedVeilioFiles(): Promise<string[] | null> {
    if (!this.io.list) return null
    let listed: string[] | null
    // shortcut: a git that answers in no 5 s counts as no listing - guard.json
    // may then only tighten, but a committed map is not detected (the shell
    // allowlist still holds); upgrade if a slow-git bypass of that is shown.
    const late = this.io.sleep ? this.io.sleep(5000).then(() => null) : null
    try {
      const listing = this.io.list(this.root)
      listed = await (late ? Promise.race([listing, late]) : listing)
    } catch {
      return null
    }
    // Case-insensitive (a macOS checkout reads .Veilio/Map.json as the map),
    // and a tracked `.veilio` entry is a committed link to somewhere else.
    if (listed === null) return null
    const files = new Set(listed.map((f) => f.toLowerCase()))
    if (files.has('.veilio')) return ['.veilio']
    return ['.veilio/map.json', '.veilio/aliases.json', '.veilio/guard.json'].filter((f) =>
      files.has(f)
    )
  }

  stop(reason: string): void {
    this.state = 'stopped'
    this.stoppedReason = reason
  }

  /** /veilio off|on: recorded in ~/.veilio/guard-state.json (spec 078
   *  FR-010), never in the project. Says whether it was recorded. */
  async setEnabled(enabled: boolean): Promise<boolean> {
    const path = this.offRecordPath
    let recorded = false
    if (path) {
      let record: { version: 1; projects: Record<string, unknown> } = { version: 1, projects: {} }
      try {
        record = (await this.offRecord()) ?? record
      } catch {
        // An unreadable record is replaced: this is the user's own choice.
      }
      const key = await this.recordKey()
      const projects = { ...record.projects }
      if (enabled) delete projects[key]
      else projects[key] = { enabled: false, changedAt: new Date().toISOString().slice(0, 10) }
      const text = `${JSON.stringify({ version: 1, projects }, null, 2)}\n`
      if (!(await this.io.exists(path))) await this.createOwnerOnly(path, '', false)
      await this.io.write(path, text)
      this.offRecordUnreadable = false
      recorded = true
    }
    this.state = enabled ? 'on' : 'off'
    if (enabled) {
      this.stoppedReason = ''
      await this.readSettings()
      await this.reloadMap()
    }
    return recorded
  }

  /** Spec 078 FR-014: .veilio and the map must be where they appear, not a
   *  link to somewhere else (the CLI's refuseLinks, through the host's stat). */
  private async refuseLinks(): Promise<void> {
    const root = (await this.io.realPath(this.root)) ?? this.root
    const dir = await this.io.realPath(join(this.root, '.veilio'))
    const map = await this.io.realPath(this.mapPath)
    if (
      (dir !== undefined && dir !== join(root, '.veilio')) ||
      (map !== undefined && map !== join(root, '.veilio', 'map.json'))
    ) {
      this.stop(
        'the map at .veilio/map.json is a link to somewhere else, so Veilio will not write the real names there. Fix it, then start a new session'
      )
      throw new Error(this.stoppedReason)
    }
  }

  private async ensureIgnored(): Promise<void> {
    // The store holds the real names; it must never be committed.
    const ignore = join(this.root, '.veilio', '.gitignore')
    await this.refuseLinks()
    if (!(await this.io.exists(ignore))) {
      await this.createOwnerOnly(ignore, '', false)
      await this.io.write(ignore, '*\n')
    }
  }

  /** Spec 078 R6: a file the guard creates is written with no names in it,
   *  made 0600, and checked, before its content is written. `names`: a file
   *  that holds them stops the guard when it cannot be made owner-only. */
  private async createOwnerOnly(path: string, empty: string, names = true): Promise<void> {
    await this.io.write(path, empty)
    if (!this.io.chmod) return
    await this.io.chmod(path).catch(() => undefined)
    const mode = this.io.mode ? await this.io.mode(path).catch(() => undefined) : undefined
    if (names && (mode === undefined || (mode & 0o077) !== 0)) {
      this.stop(
        'the map at .veilio/map.json is readable by other users, so Veilio will not write the real names there. Fix it, then start a new session'
      )
      throw new Error(this.stoppedReason)
    }
  }

  // ── text ──────────────────────────────────────────────────────────────────

  /** Prompts, reminders, output: known names replaced, credentials removed. */
  applyText(
    text: string,
    kind: MaskContext['kind'] = 'result',
    scan?: ScanResult,
    budget: RuleBudget = ruleBudget()
  ): string {
    return this.gate(this.maskText(text, kind, scan, budget))
  }

  /** Spec 065: the names a replace rule matches in text bound for the model
   *  that the map does not mask yet - a prompt, a reminder, a skill's text -
   *  minted under the rule's placeholder and saved before the text is masked,
   *  so the masking that follows writes them over and an edit restores them.
   *  Found in the masked text, so a credential is never minted. */
  async learnRuleNames(texts: readonly string[], budget: RuleBudget = ruleBudget()): Promise<void> {
    if (!this.rules.rules.some((r) => r.type === 'replace')) return
    const ctx = this.context('unknown', 'prompt', budget)
    const working = ownedMap(this.map)
    const additions = ownedMap()
    for (const t of texts) {
      const r = maskShaped(
        this.maskText(t, 'prompt', undefined, budget),
        working,
        ctx,
        this.numbering
      )
      grow(working, r.additions)
      grow(additions, r.additions)
    }
    if (Object.keys(additions).length > 0 && (await this.save(additions)).status === 'conflict')
      throw new Error('another program changed .veilio/map.json while Veilio was writing to it')
  }

  /** Masks without the last gate: for a caller that has a fallback. */
  maskText(
    text: string,
    kind: MaskContext['kind'] = 'result',
    scan?: ScanResult,
    budget: RuleBudget = ruleBudget()
  ): string {
    return applyMap(text, this.map, this.context('unknown', kind, budget), {
      known: this.destroyed,
      scan,
    })
  }

  /** The same last gate as a tool's result: a credential still here fails the
   *  text (the hook drops the prompt or leaves the text out). */
  private gate(out: string): string {
    if (survivingSecrets(out, this.map).length > 0)
      throw new Error('a credential remained after masking')
    return this.see(out)
  }

  /** Spec 078 R7: the placeholders this session put into text bound for the
   *  model. Outside git only these are restored. The guard's own note names
   *  example placeholders, which are not shown ones. */
  private shown = new Set<string>()
  private noListing = false
  private see(text: string): string {
    if (!this.noListing) return text
    for (const m of text
      .split(MODEL_NOTE)
      .join('')
      .matchAll(/__[A-Z0-9_]+__\d*/g))
      this.shown.add(m[0])
    return text
  }
  private shownCache: { from: SymbolMap; size: number; map: SymbolMap } | null = null
  /** What restores outside git: the entries of `from` this session showed. */
  private shownMap(from: SymbolMap): SymbolMap {
    const c = this.shownCache
    if (c && c.from === from && c.size === this.shown.size) return c.map
    const map: SymbolMap = {}
    for (const p of this.shown) if (Object.hasOwn(from, p)) map[p] = from[p]!
    this.shownCache = { from, size: this.shown.size, map }
    return map
  }

  /** Texts that reach the model together (a prompt and its context, the
   *  first message's blocks): each is scanned once, a credential any of them
   *  holds with its key is learned for all of them, and each scan is handed
   *  back for its own text's masking (review of 99325ba). */
  learnTogether(texts: readonly string[]): ScanResult[] {
    const scans = texts.map((t) => scanSecrets(t, 'redact'))
    const values = new Set<string>()
    texts.forEach((t, i) => {
      for (const v of destroyedValues([t], this.map, scans[i])) values.add(v)
    })
    this.destroyed.learn([...values])
    return scans
  }

  /** Text this guard masked for the first message's context, so that the
   *  copy Claude Code passes back as an attachment is not judged a second
   *  time: masked text scanned again reads a placeholder as key material
   *  (review of 99325ba). Bounded: the newest are kept. */
  private produced: string[] = []
  remember(text: string): string {
    if (text.length > 0 && !this.produced.includes(text)) {
      this.produced.push(text)
      if (this.produced.length > 64) this.produced.shift()
    }
    return text
  }

  /** The context Claude Code sends with the first message (the blocks
   *  prompt.context answered, as an attachment or a prompt's context): masked
   *  as a whole, secret scan included, with the guard's own note and the
   *  blocks it already masked each held as one opaque mark and put back
   *  after, the blocks with any name learned since. The note is a constant
   *  with no project information; masked word by word it cost ~110 tokens on
   *  every request (guard follow-up d08). A mark is not a word character, so
   *  nothing written against it joins it, and a secret laid across it is
   *  still one match (review of d18b5c5). A text that already holds a mark's
   *  characters gets no exemption. */
  applyContext(text: string, scan?: ScanResult, budget: RuleBudget = ruleBudget()): string {
    // Every copy is held as one opaque mark while the text is masked, so a
    // secret laid across one is still one match. Only a copy that is a whole
    // section (a body that is the held text, or starts with it before a
    // blank line) goes back as written; any other copy goes back masked like
    // the text around it (security review of 933156e).
    const held = [MODEL_NOTE, ...this.produced].filter((h) => text.includes(h))
    if (held.length === 0 || text.includes('\u0000') || text.includes('\u0001'))
      return this.applyText(text, 'result', scan, budget)
    const isWhole = (at: number, h: string) =>
      (at === 0 || text[at - 1] === '\n') &&
      (at + h.length === text.length ||
        text.startsWith('\n\n', at + h.length) ||
        text.startsWith('\n#', at + h.length))
    // One forward pass: each held string's next copy is searched for again
    // only once the pass has gone past it; a mark is fixed for each (held
    // string, whole or not), and what goes back is worked out once for each
    // (review of 6e14ec6).
    const nextAt = held.map((h) => text.indexOf(h))
    const spans: HeldSpan[] = []
    let at = 0
    for (;;) {
      let k = -1
      for (let i = 0; i < held.length; i++) {
        if (nextAt[i]! !== -1 && nextAt[i]! < at) nextAt[i] = text.indexOf(held[i]!, at)
        if (nextAt[i]! === -1) continue
        if (
          k === -1 ||
          nextAt[i]! < nextAt[k]! ||
          (nextAt[i] === nextAt[k] && held[i]!.length > held[k]!.length)
        )
          k = i
      }
      if (k === -1) break
      const h = held[k]!
      const pos = nextAt[k]!
      spans.push({ at: pos, length: h.length, key: `${k}:${isWhole(pos, h) ? 1 : 0}` })
      at = pos + h.length
    }
    // The whole, read back, scanned once more: anything a hold let through
    // sends the text through full masking first; only if that too leaves a
    // credential does the text fail (review of 6e14ec6).
    return this.holdAndMask(text, spans, budget, (key) => {
      const h = held[Number(key.slice(0, key.indexOf(':')))]!
      if (!key.endsWith(':1')) return this.maskText(h, 'result', undefined, budget)
      if (h === MODEL_NOTE) return h
      return applyMap(
        redactKnown(h, this.destroyed),
        this.map,
        this.context('unknown', 'result', budget),
        {
          scanned: true,
        }
      )
    })
  }

  /** A skill or agent listing (guard decision 1, spec 050 R7): each public
   *  entry (lib/listings.ts) where it stands whole is held while the listing
   *  is masked as a whole, then put back as written, less any credential
   *  this session destroyed. Everything else is masked as any reminder is. */
  applyListing(
    text: string,
    entries: readonly string[],
    budget: RuleBudget = ruleBudget()
  ): string {
    if (entries.length === 0 || text.includes('\u0000') || text.includes('\u0001'))
      return this.applyText(text, 'result', undefined, budget)
    const spans = wholeEntries(text, entries).map(({ at, entry }) => ({
      at,
      length: entry.length,
      key: entry,
    }))
    return this.holdAndMask(text, spans, budget, (entry) => redactKnown(entry, this.destroyed))
  }

  /** Masks `text` as a whole with each span held as one opaque mark, and puts
   *  back what `back` gives for the span's key: the one device applyContext
   *  and applyListing share (code review of d705b14). A mark is not a word
   *  character, so nothing written against it joins it, and a secret laid
   *  across it is still one match. A text that already holds a mark's
   *  characters, spans that overlap, a mark the masking altered, or a
   *  credential left in the result: the whole text goes through full
   *  masking instead, and fails if that too leaves one. */
  private holdAndMask(
    text: string,
    spans: readonly HeldSpan[],
    budget: RuleBudget,
    back: (key: string) => string
  ): string {
    const full = () => this.gate(this.maskText(text, 'result', undefined, budget))
    if (text.includes('\u0000') || text.includes('\u0001')) return full()
    const marks = new Map<string, string>()
    let marked = ''
    let at = 0
    for (const span of spans) {
      if (span.at < at) return full()
      let mark = marks.get(span.key)
      if (!mark) marks.set(span.key, (mark = `\u0000${marks.size}\u0001`))
      marked += text.slice(at, span.at) + mark
      at = span.at + span.length
    }
    marked += text.slice(at)
    let out = this.maskText(marked, 'result', undefined, budget)
    for (const [key, mark] of marks) out = out.split(mark).join(back(key))
    if (out.includes('\u0000') || out.includes('\u0001')) return full()
    if (survivingSecrets(out, this.map).length > 0) return full()
    return this.see(out)
  }

  /** What masking knows about a text of `language` (spec 050). */
  context(
    language: MaskContext['language'],
    kind: MaskContext['kind'] = 'result',
    budget: RuleBudget
  ): MaskContext {
    const rules = this.rules.rules
    if (!this.index) return { ...NO_CONTEXT, language, kind, rules, budget }
    return {
      language,
      kind,
      rules,
      budget,
      projectLanguages: this.index.languages,
      // Less every name the project declares anywhere (spec 050 data-model).
      // Only once every file is indexed: before that, a name imported here may
      // be declared in a file not read yet, so nothing is exempt - the
      // exemption fails closed (security review of 9355866).
      external: this.index.externalFor(language),
      declared: this.index.declared,
    }
  }

  /** The language of a tool's result text (spec 050 R2): a Read's file, the
   *  one file a command prints; otherwise unknown. Grep is per line. */
  private resultLanguage(tool: string, args: ToolEvent, filePath: string): MaskContext['language'] {
    if (tool === 'Read' || tool === 'NotebookRead') {
      const language = languageOf(filePath)
      return language === 'auto' ? 'unknown' : language
    }
    if (typeof args.command === 'string') return languageOfCommand(args.command)
    return 'unknown'
  }

  /** The real names, for drawing on this machine only. Never sent anywhere. */
  displayText(text: string): string {
    if (!text.includes('__')) return text
    return restore(text, this.map, { strip: 'none' }).restored
  }

  // ── tool calls ────────────────────────────────────────────────────────────

  private async rawOnlyHit(path: string): Promise<boolean> {
    // As written and with `.`/`..` resolved (spec 078 FR-007).
    if (isRawOnly(path, this.extraRawOnly) || isRawOnly(normalisePath(path), this.extraRawOnly))
      return true
    const real = await this.io.realPath(path)
    return real !== undefined && isRawOnly(real, this.extraRawOnly)
  }

  /** Before the tool runs: the raw-only check, then the arguments restored. */
  async beforeTool(
    e: ToolEvent,
    budget: RuleBudget = ruleBudget()
  ): Promise<{ deny: string } | { args: ToolEvent }> {
    const policy = argumentPolicy(e.tool, this.mcpRestore)
    const unresolved = new Set<string>()
    const altered = new Set<string>()
    const resolved = new Set<string>()
    const from = this.restoreMap
    const restorable = this.noListing ? this.shownMap(from) : from
    const unshown = new Set<string>()
    const restoreOne = (s: string) => {
      // Only saved entries are restored: a quarantined name never is.
      const r = restoreArgs(s, restorable)
      r.unresolved.filter((p) => Object.hasOwn(from, p)).forEach((p) => unshown.add(p))
      r.resolved.forEach((p) => resolved.add(p))
      // Only tokens Veilio could have minted end in a number: __DEV__,
      // __FILE__ and __CLASS__ belong to the language and stay as written.
      r.unresolved.filter((p) => /\d$/.test(p)).forEach((p) => unresolved.add(p))
      r.altered.forEach((p) => altered.add(p))
      restoresWhat ??= restoresNeverRestored(s, r.resolved, this.restoreMap)
      return r.text
    }

    // What the call would write back that Veilio keeps from it, if anything.
    let restoresWhat: Withheld | null = null
    let args: ToolEvent = e
    // A credential Veilio destroyed is never put back, whatever a placeholder
    // says it stands for (security review of 933156e).
    const learned = this.destroyed.values
    // Decided from what the restoration puts back, not only from what this
    // session learned: a provider-format key that was not in the arguments as
    // written is refused (security review of 2af9fca).
    const putsBack = (before: string, after: string) =>
      after === before
        ? null
        : learned.some((v) => after.includes(v) && !before.includes(v))
          ? ({ kind: 'credential' } as const)
          : restoreAdds(before, after)
    const guarded = (s: string) => {
      const out = restoreOne(s)
      restoresWhat ??= putsBack(s, out)
      return out
    }
    if (policy.restore.includes('*')) {
      const own: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(e)) if (!RESERVED.has(k)) own[k] = v
      args = { ...e, ...(deepRewrite(own, guarded) as Record<string, unknown>) }
    } else if (policy.restore.length > 0) {
      const r = rewriteFields(e, policy.restore, guarded)
      if (!r.ok) return this.deny(`its arguments are not in the expected form (${r.reason})`)
      args = r.value as ToolEvent
    }
    if (restoresWhat)
      return this.deny(
        `a placeholder in it stands for ${withheldText(restoresWhat)}, which is never written back. Ask the user`
      )
    // Security audit 2026-11-01: the model chose the command seeing only the
    // placeholder, so a value that is itself shell syntax (a planted or pulled
    // map) would run unseen. Identifiers and paths never need these characters.
    if (policy.command && [...resolved].some((p) => !SHELL_SAFE.test(this.restoreMap[p] ?? '')))
      return this.deny(
        'a placeholder in it stands for text that is not a plain name or path (spaces, shell syntax or an option), which is never put back into a shell command. Ask the user to run it'
      )

    // Spec 078 FR-012: Claude Code's settings, in every permission mode.
    if (WRITE_TOOLS.has(e.tool))
      for (const field of policy.paths)
        for (const p of [e[field], args[field]])
          if (typeof p === 'string' && isWriteProtected(p)) return this.deny(SETTINGS_PROTECTED)
    if (policy.command)
      for (const c of [e[policy.command], args[policy.command]])
        if (typeof c === 'string' && pathsInCommand(c).some(isWriteProtected))
          return this.deny(SETTINGS_PROTECTED)

    for (const field of policy.paths) {
      for (const p of [e[field], args[field]]) {
        if (typeof p === 'string' && (await this.rawOnlyHit(p))) {
          return this.deny(
            `Veilio keeps ${this.applyText(p, 'result', undefined, budget)} away from the model. Ask the user for what you need from it`,
            false
          )
        }
      }
    }
    if (policy.command) {
      const dirs = rawOnlyDirectories([...DEFAULT_RAW_ONLY, ...this.extraRawOnly])
      for (const c of [e[policy.command], args[policy.command]]) {
        if (typeof c !== 'string') continue
        // Spec 078 FR-008: a cd there would let a later command read it by a
        // short name, in this call or the next (the shell keeps its directory).
        const into = cdTargets(c).find((t) => cdIntoRawOnly(t, dirs))
        if (into !== undefined)
          return this.deny(
            `Veilio keeps \`${this.applyText(into, 'result', undefined, budget)}\` away from the model, and a cd there would let a later command read it. Name the files you need by their full path, or ask the user`,
            false
          )
        for (const word of pathsInCommand(c)) {
          if (await this.rawOnlyHit(word)) {
            return this.deny(
              `Veilio keeps ${this.applyText(word, 'result', undefined, budget)} away from the model. Ask the user for what you need from it`,
              false
            )
          }
        }
      }
    }

    // A tool with no row (an MCP server, a tool added later): any argument that
    // is a raw-only path, as written or restored, refuses the call.
    if (policy.paths.length === 0 && !policy.command) {
      for (const source of [e, args]) {
        const strings: string[] = []
        for (const [k, v] of Object.entries(source)) {
          if (!RESERVED.has(k)) deepRewrite(v, (s) => (strings.push(s), s))
        }
        for (const s of strings) {
          // A path, not prose that mentions one: no whitespace.
          if (isPathLike(s) && (await this.rawOnlyHit(s))) {
            return this.deny(
              `Veilio keeps ${this.applyText(s, 'result', undefined, budget)} away from the model. Ask the user for what you need from it`,
              false
            )
          }
        }
      }
    }

    // An edit, or a shell command, which can write a file too (sed -i, echo >).
    const writes = policy.mode === 'strict' || policy.command !== undefined
    const viaEdit = policy.command ? '. Make the change with the Edit tool' : ''

    // A redaction token written to a file would replace the real credential
    // for good: refused, so the line is edited by a person.
    if (writes) {
      const redacted = new Set<string>()
      for (const field of policy.restore) {
        rewriteFields(args, [field], (s) => {
          for (const m of s.matchAll(/__REDACTED_[A-Z0-9_]+__/g)) redacted.add(m[0])
          return s
        })
      }
      if (redacted.size > 0) {
        return this.deny(
          `the call writes ${[...redacted].join(', ')}, ${WITHHELD_TEXT.credential}. Writing it would ` +
            'replace the real value in the file. Leave that line as it is, or ask the user to change it'
        )
      }
    }

    if (writes && (unresolved.size > 0 || altered.size > 0)) {
      const names = [...unresolved, ...altered].join(', ')
      // strings.md #10: outside git, a planted entry is one never shown.
      const which = [...unresolved].every((p) => unshown.has(p)) && altered.size === 0
      return this.deny(
        `the call names ${names}, ${which ? 'which this session has not shown you' : "which the project's map does not have"}` +
          (altered.size ? ' (a placeholder was changed: keep its exact spelling)' : '') +
          '. Read the file again and use the placeholders it shows' +
          viaEdit
      )
    }
    // Spec 078 R1 (A#1): a placeholder goes back into a shell command only
    // when the command reads files or runs tests; anything else could reshape
    // the real name or send it off the machine.
    if (policy.command && resolved.size > 0) {
      const command = e[policy.command]
      const why = restoreRefusal(
        typeof command === 'string' ? command : '',
        e.tool === 'PowerShell' ? 'PowerShell' : 'Bash'
      )
      if (why) return this.deny(why)
    }
    return { args }
  }

  private deny(reason: string, prefix = true): { deny: string } {
    this.counts.denied++
    return { deny: prefix ? `Veilio refused this call: ${reason}.` : `${reason}.` }
  }

  private withhold(reason: string): { deny: string } {
    this.counts.withheld++
    return withheld(reason)
  }

  /** A denial's or an error's text, as the model reads it: the files it names
   *  indexed, the map applied, leftover names shaped like identifiers masked
   *  and saved, then the secret re-scan. One path for both, so neither can
   *  skip a step (security review of f03f45c). */
  private async maskMessage(
    raw: string,
    args: ToolEvent,
    deadline: number,
    budget: RuleBudget,
    indexed = false
  ): Promise<ToolOutcome> {
    if (!indexed) {
      const unchecked = await this.indexNamed(args, [raw], deadline, budget)
      if (unchecked) return this.withhold(unchecked)
    }
    const ctx = this.context('unknown', 'result', budget)
    const shaped = maskShaped(
      applyMap(raw, this.map, ctx, { known: this.destroyed }),
      this.map,
      ctx,
      this.numbering
    )
    if (
      Object.keys(shaped.additions).length > 0 &&
      (await this.save(shaped.additions)).status === 'conflict'
    )
      return this.withhold(
        'another program changed .veilio/map.json while Veilio was writing to it'
      )
    const left = survivingSecrets(shaped.text, { ...this.map, ...shaped.additions })
    if (left.length > 0)
      return this.withhold(`a secret remained after masking (${[...new Set(left)].join(', ')})`)
    return { deny: this.see(shaped.text) }
  }

  /** After the tool ran: the listed fields scrubbed, new names saved, then the secret re-scan. */
  async afterTool(
    tool: string,
    args: ToolEvent,
    received: { deny?: string; result?: unknown; text?: string; isError?: boolean },
    deadline = Date.now() + 6_000,
    budget: RuleBudget = ruleBudget()
  ): Promise<ToolOutcome> {
    let outcome = received
    // First, whatever the outcome: a failed command may have moved the shell.
    if (tool === 'Bash' && typeof args.command === 'string' && MOVES.test(args.command))
      this.shellMoved = true
    // A denial reaches the model as text, like an error's: masked the same way.
    if (outcome.deny !== undefined) return this.maskMessage(outcome.deny, args, deadline, budget)
    // Spec 050: the files this result names are indexed before it is masked,
    // so their names are in the map even if Claude never read them.
    const texts: string[] = []
    deepRewrite(outcome.isError ? (outcome.text ?? outcome.result ?? '') : outcome.result, (s) => {
      texts.push(s)
      return s
    })
    const unchecked = await this.indexNamed(args, texts, deadline, budget)
    if (unchecked) return this.withhold(unchecked)
    // What any scan of this result destroys is removed from all of it, as
    // written, before anything is masked: no repeat of a credential on
    // another line, in another field or in a source's literal can reach the
    // map or the model (security reviews of 75fe4c0 and fe5078c). Learned
    // from what the model would be sent, after raw-only lines are dropped
    // (review of 99325ba). Enum fields are left for the last scan, which
    // withholds the result.
    const strip = (s: string) => redactKnown(s, this.destroyed)
    const shell = tool === 'Bash' || tool === 'PowerShell'
    // An error's text never fits the tool's output schema, which Claude Code
    // checks a hook's `{ result }` against: it goes back as the error text the
    // model reads, masked.
    if (outcome.isError) {
      const raw = typeof outcome.text === 'string' ? outcome.text : String(outcome.result ?? '')
      // A failed command's text reaches the model too (security review of
      // the encoded-name check).
      if (shell && encodedName(raw, this.map) !== null) return this.withhold(ENCODED_NAME)
      this.destroyed.learn(destroyedValues([raw], this.map))
      if (this.destroyed.reshaped(strip(raw))) return this.withhold(RESHAPED_CREDENTIAL)
      return this.maskMessage(strip(raw), args, deadline, budget, true)
    }
    const filePath = typeof args.file_path === 'string' ? args.file_path : ''
    // The file's kind, never its path (engine spec 013 R19): the
    // environment-style credential rules apply, the test-file relaxation does not.
    const fileKind = filePath ? fileKindOf(filePath) : undefined
    outcome = { ...outcome, result: this.dropRawOnly(tool, outcome.result) }
    const policy = resultPolicy(tool, outcome.result, filePath)
    if (policy.kind === 'withhold') return this.withhold(policy.reason)
    const sent: string[] = []
    deepRewrite(outcome.result, (s) => {
      sent.push(s)
      return s
    })
    // One scan per string, for learning here and for masking below while the
    // string is as scanned. A Grep result mixes files the guard cannot tell
    // apart safely (a secret file named by its path, a .pgpass line, a search
    // without -n): the key rule learns nothing from it (e72 ship check).
    const prepared: Prepared = new Map()
    const code = isCode(filePath, args)
    this.destroyed.learn(
      tool === 'Grep'
        ? destroyedValues(sent, this.map, undefined, fileKind, { keyed: false })
        : destroyedValues(sent, this.map, undefined, fileKind, {
            code,
            known: this.destroyed,
            prepared,
          })
    )
    // Spec 074 pass 2: a search's lines read as their files' text, after the
    // learning above (on the result as sent) and before the sweep below, so
    // what it learns is removed from the whole result.
    const search = policy.kind === 'fields' ? this.searchOf(tool, args, outcome.result) : null
    if (search) {
      const record = outcome.result as Record<string, unknown>
      const text = record[search.field] as string
      outcome = {
        ...outcome,
        result: { ...record, [search.field]: await this.searchPass(text, search.format, deadline) },
      }
    }
    if (this.destroyed.values.length > 0)
      outcome = {
        ...outcome,
        result:
          policy.kind === 'text'
            ? strip(outcome.result as string)
            : deepRewrite(
                outcome.result,
                strip,
                new Set(policy.kind === 'fields' ? policy.keep : [])
              ),
      }

    // Spec 078 FR-005: what the sweep above removed whole may still be here
    // reformatted, sliced or encoded; read before masking, which would mint
    // a slice as a name.
    let reshaped = false
    deepRewrite(outcome.result, (s) => {
      // Exact copies left in a kept field are the last scan's (it names them).
      reshaped ||= this.destroyed.reshaped(strip(s))
      return s
    })
    if (reshaped) return this.withhold(RESHAPED_CREDENTIAL)

    // Spec 078 FR-018a: a shell can print a project name encoded, which
    // masking does not read; read before masking, which would mint it.
    if (shell) {
      let encoded = false
      deepRewrite(outcome.result, (s) => {
        encoded ||= encodedName(s, this.map) !== null
        return s
      })
      if (encoded) return this.withhold(ENCODED_NAME)
    }

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const working: SymbolMap = ownedMap(this.map)
      const additions: SymbolMap = ownedMap()
      let value: unknown = outcome.result
      const ctx = this.context(this.resultLanguage(tool, args, filePath), 'result', budget)
      // A Grep result mixes files: each line is masked in its own file's language.
      const perLine = (s: string, fn: (line: string, c: MaskContext) => string) =>
        tool === 'Grep'
          ? s
              .split('\n')
              .map((line) => fn(line, this.context(languageOfGrepLine(line), 'result', budget)))
              .join('\n')
          : fn(s, ctx)
      // Swept already, above: each string is scanned once here, with the
      // learning pass's work while it is the text and the map that pass saw.
      const apply = (s: string) =>
        perLine(s, (t, c) => {
          if (tool === 'Grep')
            return applyMap(t, working, c, {
              known: this.destroyed,
              swept: true,
              fileKind,
              learn: false,
            })
          const ready = attempt === 0 ? prepared.get(t) : undefined
          const same = ready && ready.code === code && ready.fileKind === fileKind
          return applyMap(t, working, c, {
            known: this.destroyed,
            swept: true,
            fileKind,
            code,
            scan: same ? ready.scan : undefined,
            keyed: same ? ready.keyed : undefined,
          })
        })
      // A listed field, already scanned for credentials as written, only has
      // the names the map has learned since replaced in the pass over every
      // string; every other field is masked in full. Told apart by where the
      // string stands, never by what it says (review of 99325ba).
      const listed = new Set(policy.kind === 'fields' ? policy.fields.map((f) => f.path) : [])
      const again = (s: string, path: string) =>
        listed.has(path)
          ? perLine(s, (t, c) => applyMap(t, working, c, { scanned: true }))
          : apply(s)
      if (policy.kind === 'text') value = apply(value as string)
      else if (policy.kind === 'deep') value = deepRewrite(value, apply)
      else {
        for (const field of policy.fields) {
          const r = rewriteFields(value, [field.path], (s) => {
            if (field.mode === 'apply') return apply(s)
            const scrubbed = scrubSource(
              s,
              working,
              languageOf(filePath),
              ctx.external,
              fileKind,
              this.numbering,
              this.rules.rules,
              budget
            )
            this.counts.outsideReserved += scrubbed.outside
            if (scrubbed.rulesStopped) this.counts.rulesStopped++
            grow(working, scrubbed.additions)
            grow(additions, scrubbed.additions)
            return scrubbed.text
          })
          if (!r.ok)
            return this.withhold(
              `its result is not in the form Veilio checks (${tool}: ${r.reason})`
            )
          value = r.value
        }
        // Every string, the listed ones included: in a source file this masks
        // the names the map already has where the engine leaves text as
        // written, in comments. Everyday words from literals are not applied.
        value = deepRewritePaths(value, again, new Set(policy.keep))
      }
      // A name shaped like an identifier that is still here - in a file the
      // index has not reached - is masked and added (spec 050 R1).
      const keep = policy.kind === 'fields' ? new Set(policy.keep) : new Set<string>()
      value = rewriteKeyed(value, (s, key) => {
        if (keep.has(key)) return s
        // An enum is one bare token at the top of a record; a sentence under
        // `status`, or a value deeper down, is masked like any other.
        if (policy.kind !== 'text' && ENUM_KEYS.has(key) && /^[\w$.-]+$/.test(s)) return s
        return perLine(s, (t, c) => {
          const shaped = maskShaped(t, working, c, this.numbering)
          grow(working, shaped.additions)
          grow(additions, shaped.additions)
          return shaped.text
        })
      })

      if (Object.keys(additions).length > 0) {
        const { status: saved } = await this.save(additions)
        if (saved === 'conflict') continue
      }

      const left: string[] = []
      deepRewrite(value, (s) => {
        left.push(...survivingSecrets(s, working))
        return s
      })
      if (left.length > 0)
        return this.withhold(`a secret remained after masking (${[...new Set(left)].join(', ')})`)
      deepRewrite(value, (s) => this.see(s))
      return { result: value }
    }
    return this.withhold(
      'another program kept changing .veilio/map.json while Veilio was writing to it'
    )
  }

  /** Where a result holds search output, and how it was printed: the Grep
   *  tool's content, or the stdout of one plain `rg`/`grep` in a shell that
   *  is where the session started (research R5). */
  private searchOf(
    tool: string,
    args: ToolEvent,
    result: unknown
  ): { field: 'content' | 'stdout'; format: ReturnType<typeof grepFormat> } | null {
    const record = (result ?? {}) as Record<string, unknown>
    if (tool === 'Grep' && record.mode === 'content' && typeof record.content === 'string')
      return { field: 'content', format: grepFormat(args) }
    if (tool !== 'Bash' || this.shellMoved || typeof args.command !== 'string') return null
    const format = searchCommand(args.command)
    return format && typeof record.stdout === 'string' ? { field: 'stdout', format } : null
  }

  /** Spec 074 pass 2 (research R4): each file's run of search lines read as
   *  that file's text - a key on one line and its value on the next are one
   *  value - with each key-rule value replaced where it stands, and the
   *  values CE #204's rules carry forward learned. A run whose line count
   *  would change is left as it is; a line whose file the disk cannot name is
   *  left to the per-line masking, as is everything when pass 2 cannot finish
   *  in time or fails. `oneFile`: the path argument, used when it is a file. */
  private async searchPass(
    text: string,
    format: Omit<SearchFormat, 'base' | 'oneFile'> & { oneFile?: string },
    deadline: number
  ): Promise<string> {
    const isFile = this.io.isFile
    if (!this.searchPass2 || !isFile || !this.cwd) return text
    try {
      const full = (p: string) => searchPath(this.cwd, p)
      const one = format.oneFile !== undefined ? full(format.oneFile) : null
      const oneFile = one !== null && (await isFile(one)) ? format.oneFile : undefined
      // Late, the parse goes on in the background: told to stop asking the disk.
      const stop = { aborted: false }
      const parsed = await bounded(
        parseSearchOutput(text, { ...format, oneFile, base: this.cwd, fileExists: isFile, stop }),
        deadline,
        this.clock
      )
      if (parsed === LATE) {
        stop.aborted = true
        return text
      }
      const { lines, runs } = parsed
      const out = lines.map((l) => l.text)
      const learned: string[] = []
      for (const run of runs) {
        if (this.clock.now() > deadline) return text
        const shown = run.lines.map((i) => lines[i]!)
        // A file named for its key (`secrets/db_password`) that holds only a
        // value is read as that key's value (FR-004).
        const at = full(run.path)
        const name = at === null ? null : await this.mountedSecret(at, run.path, shown, deadline)
        const bare = name !== null
        const prefix = bare ? `${name}: ` : ''
        const r = keyedRun(
          shown.map((l) => prefix + l.body).join('\n'),
          this.map,
          this.destroyed,
          isCode(run.path),
          fileKindOf(run.path),
          bare,
          shown.map((l) => l.prefix!)
        )
        learned.push(...r.learned)
        const back = r.text.split('\n')
        if (back.length !== shown.length || back.some((b) => !b.startsWith(prefix))) {
          // Fail closed: each line's text under a token of its own.
          this.searchUnsplit++
          for (const i of run.lines) {
            const l = lines[i]!
            out[i] = l.prefix! + this.destroyed.tokenFor(l.body!)
          }
          continue
        }
        run.lines.forEach((i, j) => {
          const l = lines[i]!
          out[i] = l.prefix! + back[j]!.slice(prefix.length)
        })
      }
      this.destroyed.learn(learned)
      return out.join('\n')
    } catch {
      // Pass 2 only ever adds: without it the result is masked as before.
      this.searchFailed++
      return text
    }
  }

  /** The key a mounted secret's file name gives its value (`db_password`), or
   *  null (T024 review: code and documents named for a secret were read as
   *  one). Only a file with no extension, `.txt` or `.secret`,
   *  whose whole text on disk (4 KB at most) is one value with no whitespace
   *  and no key of its own - the value every line shown is. */
  private async mountedSecret(
    full: string,
    path: string,
    shown: readonly { body?: string }[],
    deadline: number
  ): Promise<string | null> {
    const base = path.split(/[\\/]/).pop() ?? ''
    const dot = base.lastIndexOf('.')
    const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
    const name = dot > 0 ? base.slice(0, dot) : base
    // Not code either: no language has these extensions.
    if ((ext && ext !== 'txt' && ext !== 'secret') || !namesSecret(name)) return null
    // One file's error or a late disk touches its own run only: unconfirmed,
    // it is masked line by line as on main, by its path (review of a5ca329).
    let text: string
    try {
      const size = await bounded(
        this.io.fileSize?.(full) ?? Promise.resolve(undefined),
        deadline,
        this.clock
      )
      if (size === LATE || size === undefined || size > 4096) return null
      const read = await bounded(this.io.read(full), deadline, this.clock)
      if (read === LATE) return null
      text = read
    } catch {
      return null
    }
    const value = text.replace(/^\uFEFF/, '').replace(/\s+$/, '')
    if (!value || /\s/.test(value) || valueSpans(value).length > 0) return null
    return shown.every((l) => l.body!.replace(/\s+$/, '') === value) ? name : null
  }

  /** A search over a directory or a glob can reach raw-only files the call
   *  never named: their lines and names are dropped from the result. */
  private dropRawOnly(tool: string, result: unknown): unknown {
    if ((tool !== 'Grep' && tool !== 'Glob') || !result || typeof result !== 'object') return result
    const record = result as Record<string, unknown>
    const raw = (p: string) => isRawOnly(p, this.extraRawOnly)
    const out: Record<string, unknown> = { ...record }
    if (Array.isArray(record.filenames)) {
      out.filenames = record.filenames.filter((f) => typeof f !== 'string' || !raw(f))
    }
    if (typeof record.content === 'string') {
      // `path:12:text` for a match, `path-12-text` for a context line, and
      // without -n `path:text` / `path-text`. Where the path ends cannot be
      // told from the line (a dated directory has `-31-` in it, a Windows
      // drive a ':'), so the prefix before every ':' and '-' is checked
      // (security audit 2026-11-01; review of aac1f66).
      out.content = record.content
        .split('\n')
        .filter((line) => {
          // shortcut: a path is at most PATH_MAX (4096) - git cannot check out a
          // longer one, so a repository cannot plant it; scanning further would
          // stall the hook on a minified line. Upgrade if a longer path is shown.
          for (let i = 1; i < Math.min(line.length, 4097); i++)
            if ((line[i] === ':' || line[i] === '-') && raw(line.slice(0, i))) return false
          return true
        })
        .join('\n')
    }
    return out
  }

  /** Adds entries to the map file: read what is there now, merge, write.
   *  Says how many names went to the quarantine instead
   *  (review of 6e14ec6: returned, not shared through guard state). */
  private save(
    additions: SymbolMap
  ): Promise<{ status: 'saved' | 'conflict'; quarantined: number }> {
    // No credential Veilio destroyed is ever minted into the map (security
    // review of 933156e).
    // The entry that holds one goes to the in-memory quarantine; the rest
    // are saved (reviews of da4ff84 and 7b930ad).
    const learned = this.destroyed.values
    let quarantined = 0
    if (learned.length > 0) {
      const kept: SymbolMap = {}
      for (const [placeholder, name] of Object.entries(additions)) {
        // Spec 078 FR-006: 12 characters of one is enough (N1).
        if (learned.some((v) => name.includes(v)) || this.destroyed.sharesWindow(name)) {
          // A namespace of its own, which no saved entry can share (review
          // of 58d3dae). Minted before any text holds the engine's number:
          // only indexing raw files sends a name here.
          const own = this.quarantinedNames.get(name) ?? `__QUARANTINED__${++this.quarantineNext}`
          void placeholder
          this.quarantinedNames.set(name, own)
          this.quarantine[own] = name
          this.destroyed.hold(name, own)
          quarantined++
        } else kept[placeholder] = name
      }
      additions = kept
    }
    const run = this.writes.then(async () => {
      await this.refuseLinks()
      let onDisk: StoredMap = { version: 1, map: {} }
      const existed = await this.io.exists(this.mapPath)
      if (existed) {
        const parsed = parseMapFile(await this.io.read(this.mapPath))
        if (!parsed.ok) {
          this.stop(`the map at .veilio/map.json could not be read: ${parsed.reason}`)
          throw new Error(this.stoppedReason)
        }
        onDisk = parsed.stored
      }
      await this.reloadSideFiles()
      // Everything this guard knows, not only the new entries: a writer that
      // dropped ours (two programs saving at once) gets them back.
      const { merged, conflicts } = mergeAdditions(onDisk.map, { ...this.stored.map, ...additions })
      if (conflicts.length > 0) {
        this.stored = onDisk
        return { status: 'conflict' as const, quarantined }
      }
      const next: StoredMap = { ...onDisk, map: merged }
      if (!existed)
        await this.createOwnerOnly(this.mapPath, serialiseMapFile({ version: 1, map: {} }))
      await this.io.write(this.mapPath, serialiseMapFile(next))
      if (!existed) await this.ensureIgnored()
      this.stored = next
      return { status: 'saved' as const, quarantined }
    })
    // A failed write must not wedge every later one.
    this.writes = run.catch(() => undefined)
    return run
  }
}

/** A command that changes the shell's directory: `cd`, `pushd` or `popd`
 *  at its start or after `&&`, `||`, `;`, `|`, a lone `&`, a newline or `(`. */
const MOVES = /(?:^|&&|\|\||[;|&\n(])\s*(?:cd|pushd|popd)(?:\s|$)/

/** How the Grep tool printed its content (research R1, T001): line numbers
 *  unless `-n` is false, context lines when asked for, no path when `path`
 *  is one file. */
function grepFormat(
  args: ToolEvent
): Omit<SearchFormat, 'base' | 'oneFile'> & { oneFile?: string } {
  return {
    numbered: args['-n'] !== false,
    context: ['-A', '-B', '-C', 'context'].some((k) => Number(args[k]) > 0),
    ...(typeof args.path === 'string' ? { oneFile: args.path } : {}),
  }
}
