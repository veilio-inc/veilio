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
import {
  deepRewrite,
  deepRewritePaths,
  KeyClash,
  rewriteFields,
  setOnce,
  type DataKeys,
} from './fields.ts'
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
  allCdTargets,
  cdIntoRawOnly,
  cdTargets,
  cdTargetsToJudge,
  DEFAULT_RAW_ONLY,
  braceNames,
  globMayBeRawOnly,
  namesRawOnlyFolder,
  isRawOnly,
  mcpConfigName,
  isWriteProtected,
  normaliseRawOnlyPattern,
  normalisePath,
  pathsInCommand,
  rawOnlyDirectories,
  rawOnlyOf,
  shortNameAlias,
  walkCd,
  windowsAlias,
  wordPath,
  MAX_DIRS,
  type CdContext,
  type DirState,
  type Var,
} from './paths.ts'
import {
  MAX_COMMAND,
  MAX_STEPS,
  newCost,
  isTextScript,
  parseShell,
  restoreRefusal,
  spend,
  type Cost,
  type Word,
} from './shell.ts'
import {
  dotsMatch,
  isWord,
  namesVeilioFolder,
  bracketsRead,
  dataPositions,
  judgedWords,
  ownScripts,
  type Data,
  withoutData,
  pieces,
  textPieces,
  readsStrictly,
  rereadLists,
  spellings,
  textsOf,
  wordsWithin,
} from './reading.ts'
import { bounded, LATE, ProjectIndex } from './index.ts'
import {
  argumentPolicy,
  callsOwnCommand,
  OWN_COMMAND_REFUSED,
  isSourcePath,
  isMcpTool,
  mcpServersOf,
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
  decodedRuns,
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
import {
  fileKindOf,
  isName,
  parseWrittenRecord,
  restore,
  ruleBudget,
  scanSecrets,
  valueSpans,
  WRITTEN_RECORD_FILE,
  writtenRecordValue,
} from '../vendor/engine/index.js'
import type { RuleBudget } from '../vendor/engine/index.js'
import { MODEL_NOTE, printable } from './ui.ts'
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
  /** What git tracks under `.veilio`, any letter case, relative to `root`;
   *  null when it cannot be listed. Absent: `list` is used. */
  listVeilio?(root: string): Promise<string[] | null>
  /** Resolves after `ms` ($.clock.sleep): bounds a read or `git` that hangs. */
  sleep?(ms: number): Promise<void>
  /** Spec 078 R6: makes a file owner-only (0600). Absent (Windows): files
   *  are written as the host makes them. */
  chmod?(path: string): Promise<void>
  /** A file's permission bits, or undefined when they cannot be read. */
  mode?(path: string): Promise<number | undefined>
  /** Whether the path itself is a link, not followed (review round 1 #5).
   *  Absent: a link that leads nowhere is found only once written through. */
  isLink?(path: string): Promise<boolean>
  /** Removes a file (a leftover of an older version's off switch). Absent: it
   *  is left where it is, and still never read. */
  remove?(path: string): Promise<void>
  /** Whether the machine is Windows. Absent: the engine reads the platform. */
  windows?(): Promise<boolean>
}

// Keys whose value in a record is an enum or a status (`type`, `status`):
// Claude Code refuses a record whose enum changed, so the identifier-shape
// fallback leaves these. Every other value is shape-masked (review of ef1a533).
const ENUM_KEYS = new Set(['type', 'status', 'mode', 'kind', 'state', 'subtype', 'role'])

/** deepRewrite, with the key each string sits under. */
// The key is passed only at the record's top level, and in the blocks of a root
// list (an MCP result's `type`), as `keep` works in fields.ts; deeper it is ''.
// `at`: the string's place in the record, in the field-list syntax. `keys`:
// the keys that are data (an MCP result's), masked as a value is, minting
// included, so a new identifier used as a key never reaches the model as
// written (spec 085 L16, review round 2 #3).
function rewriteKeyed(
  value: unknown,
  fn: (s: string, key: string, at: string) => string,
  keys?: DataKeys,
  key = '',
  top = true,
  at = ''
): unknown {
  if (typeof value === 'string') return fn(value, key, at)
  if (Array.isArray(value)) return value.map((v) => rewriteKeyed(v, fn, keys, '', top, `${at}[]`))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value))
      setOnce(
        out,
        keys?.(k, at) ? fn(k, '', '') : k,
        rewriteKeyed(v, fn, keys, top ? k : '', false, at === '' ? k : `${at}.${k}`)
      )
    return out
  }
  return value
}

/** Spec 085 L16: the keys of an MCP result that are data - every key but
 *  the CallToolResult's own at its root and a content block's. An allow-list:
 *  a key not named here is masked. */
const MCP_RESULT_KEYS = new Set(['content', 'structuredContent', 'isError', '_meta'])
const MCP_BLOCK_KEYS = new Set(['type', 'text', 'annotations'])
const MCP_BLOCK_TYPE = /^(?:content)?\[\]\.type$/
const mcpDataKeys: DataKeys = (key, at) =>
  !(at === '' && MCP_RESULT_KEYS.has(key)) &&
  !((at === '[]' || at === 'content[]') && MCP_BLOCK_KEYS.has(key))

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
/** What a placeholder may put into an MCP tool's arguments (spec 085 L18):
 *  SHELL_SAFE with letters, combining marks and digits of any script and `$`
 *  (not a shell), and no URL or path that climbs out (review round 1 #7). */
const NAME_OR_PATH = /^(?!-)[\p{L}\p{M}\p{N}_./@+:$-]+$/u
const nameOrPath = (v: string) =>
  NAME_OR_PATH.test(v) &&
  !v.includes('://') &&
  // A protocol-relative URL (`//host/x`) too (final review).
  !v.startsWith('//') &&
  !/(?:^|\/)\.\.(?:\/|$)/.test(v) &&
  // A leading scheme (`file:`, `javascript:`), not a drive letter or `::`.
  !/^(?![A-Za-z]:\/)[A-Za-z][A-Za-z0-9+.-]*:(?!:)/.test(v)
const MAX_RETRIES = 3
/** What the engine mints a placeholder for: a name (round 4 #2). */
const MINTED_NAME = /^[\p{L}_$][\p{L}\p{N}_$]*$/u
/** The least time a save gives git to say whether .veilio is tracked. */
const MIN_GIT_WAIT = 500

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
  'Veilio guard is back on: an off setting in .veilio/guard.json was ignored, because a file in the project can be written by the agent. To switch the guard off until this session ends, run /veilio off.'
export const MCP_IGNORED =
  "Veilio: mcpRestore in .veilio/guard.json was ignored, because a file in the project can be written by the agent. Set it in the plugin's settings (/config)."
/** strings.md #9. */
const SETTINGS_PROTECTED =
  "Claude Code's settings can switch the guard off, so the agent may not change them. Ask the user to make this change"
/** What one path check costs of a command's budget (it asks the file system). */
const PATH_STEPS = 12
/** Longer than any path a system opens. */
const MAX_PATH = 4096

const INTERPRETER_GUARD_STATE =
  "a script run from the command line that names Veilio's own files could read or change them, so the agent may not run it. Ask the user to run this call"
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
export const PROMPT_FAILED =
  'Veilio could not check this prompt, so it was not sent. Try again, or run /veilio to see why.'

export function withheld(reason: string): { deny: string } {
  return { deny: `Veilio withheld this result: ${reason}.` }
}

/** A string whose last path part has no whitespace: it may name a file. */
function endsInAName(s: string): boolean {
  return !/\s/.test(s.slice(Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\')) + 1))
}

/** Every object key under `value`, at any depth, into `into`. */
function keysOf(value: unknown, into: string[]): void {
  if (Array.isArray(value)) for (const v of value) keysOf(v, into)
  else if (value && typeof value === 'object')
    for (const [k, v] of Object.entries(value)) {
      into.push(k)
      keysOf(v, into)
    }
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
  /** The user's home ($HOME): where an older version's leftovers are removed from. */
  home: string | undefined
  /** Said once a session (register.ts logs them): settings the guard ignored. */
  notices: string[] = []
  /** A guard-state.json from an older version named this project as off: it
   *  is removed and not honoured, and the band says so for this session. */
  legacyOffRecord = false
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
   *  name (a contested one is in neither, as in the CLI). Quarantine never,
   *  and no alias whose name shares 12 characters with a removed credential
   *  (FR-006, review round 1 item 4). */
  private get restoreMap(): SymbolMap {
    this.settle()
    const map = this.stored.map
    const keys = Object.keys(this.aliases)
    if (keys.length === 0) return map
    // One object per (map, aliases, removed credentials): restoreArgs caches
    // its matcher by map object.
    const c = this.restoreCache
    const learned = this.destroyed.version
    if (
      c &&
      c.map === map &&
      c.aliases === this.aliases &&
      c.version === versionOf(map) &&
      c.learned === learned
    )
      return c.out
    const out: SymbolMap = { ...this.aliases, ...map }
    for (const p of keys)
      if ((p in map && map[p] !== this.aliases[p]) || this.destroyed.sharesWindow(this.aliases[p]!))
        delete out[p]
    this.restoreCache = { map, aliases: this.aliases, version: versionOf(map), learned, out }
    return out
  }
  private restoreCache: {
    map: SymbolMap
    aliases: SymbolMap
    version: number
    learned: number
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
      for (const [, name] of Object.entries(map))
        if (this.destroyed.sharesWindow(name)) this.quarantineName(name)
      this.stored = { ...this.stored, map: ownedMap(Object.fromEntries(out)) }
    }
    this.settledFor = { stored: this.stored, version: this.destroyed.version }
  }

  /** `name` under a placeholder of its own namespace, which no saved entry
   *  can share (review of 58d3dae): masked this session, never saved. */
  private quarantineName(name: string, hold = true): void {
    const own = this.quarantinedNames.get(name) ?? `__QUARANTINED__${++this.quarantineNext}`
    this.quarantinedNames.set(name, own)
    this.quarantine[own] = name
    if (hold) this.destroyed.hold(name, own)
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
    // A host may answer with a promise or a plain boolean (review round 3).
    const host = this.io.windows
    this.windows = host
      ? await Promise.resolve()
          .then(() => host())
          .catch(() => undefined)
      : undefined
    await this.readSettings()
    await this.retireLegacyOffRecord()
    await this.reloadMap()
    this.stopIfTracked(committed)
    await this.checkRecord()
    this.loaded = true
    this.shellDir = cwd
    this.dirs = this.sessionState([cwd])
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
        // A file holding a removed credential in another form (pieces under
        // 12 characters each, review round 1 item 7): its names are masked
        // this session and never saved. Not swept as held names: a result
        // that shows the pieces must still read as reshaped, and be withheld.
        if (this.destroyed.reshaped(text))
          for (const name of Object.values(additions)) this.quarantineName(name, false)
        else grow(this.unsaved, additions)
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
        ;({ status: saved, quarantined } = await this.save(this.unsaved, deadline))
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
    // The list is built whole and then swapped in: a call judged while the
    // file is read (`/veilio on` in a running session) sees the list as it
    // was, never the plugin's own patterns alone.
    const rawOnly = [...this.config.rawOnly]
    this.mcpRestore = [...this.config.mcpRestore]
    if (!(await this.io.exists(this.settingsPath))) {
      this.extraRawOnly = rawOnly
      return
    }
    let settings: { enabled?: unknown; rawOnly?: unknown; mcpRestore?: unknown }
    // A read that fails throws to the caller (round 4 #6: /veilio on stops
    // with #43); only text that is not JSON stops the guard here.
    const text = await this.io.read(this.settingsPath)
    try {
      settings = JSON.parse(text)
    } catch {
      this.stop(`.veilio/guard.json is not valid JSON`)
      return
    }
    rawOnly.push(...rawOnlyOf(settings))
    this.extraRawOnly = rawOnly
    // Spec 085 R2-15 (#61): a pattern that can never match protects nothing.
    for (const p of this.extraRawOnly)
      if (p && !p.startsWith('!') && normaliseRawOnlyPattern(p) === null)
        this.notice(unmatchableRawOnly(p))
    if (settings.enabled === false) this.notice(BACK_ON)
    if (settings.mcpRestore !== undefined) this.notice(MCP_IGNORED)
  }

  private said = new Set<string>()
  private notice(text: string): void {
    if (this.said.has(text)) return
    this.said.add(text)
    this.notices.push(text)
  }

  /** /veilio off lasts for the session and lives only in this object: nothing
   *  about on or off is read from or written to disk, so no file can switch the
   *  guard off. Files an older version kept for it are removed, and the band
   *  says so once when one had this project off. */
  private async retireLegacyOffRecord(): Promise<void> {
    this.legacyOffRecord = false
    if (!this.home) return
    const dir = join(this.home, '.veilio')
    const state = join(dir, 'guard-state.json')
    try {
      if (await this.io.exists(state)) {
        let wasOff = false
        try {
          const projects = (JSON.parse(await this.io.read(state)) as { projects?: unknown } | null)
            ?.projects as Record<string, { enabled?: unknown } | undefined> | undefined
          const key = (await this.io.realPath(this.root)) ?? this.root
          wasOff = projects?.[key]?.enabled === false
        } catch {
          // Any content: it is removed all the same.
        }
        await this.io.remove?.(state).catch(() => undefined)
        // Said only when it is gone: a file that stays is never read, and the
        // band cannot tell later sessions it was already said.
        this.legacyOffRecord = wasOff && !(await this.io.exists(state))
      }
      const secret = join(dir, 'guard-secret')
      if (await this.io.exists(secret)) await this.io.remove?.(secret).catch(() => undefined)
    } catch {
      // Not removed: still never read.
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
    const aliases = this.aliases
    await this.reloadSideFiles()
    if (!(await this.io.exists(this.mapPath))) {
      this.stored = { version: 1, map: {} }
      this.onDisk = {}
      this.mapText = ''
      return
    }
    const text = await this.io.read(this.mapPath)
    const parsed = parseMapFile(text)
    if (!parsed.ok) {
      this.stop(`the map at .veilio/map.json could not be read: ${parsed.reason}`)
      return
    }
    this.mapText = text
    // Review round 1 item (c): a map already there that others can read
    // (an older guard's, a copy) is made owner-only, and checked. One with
    // names stops the guard; one without is said once, and a save stops it
    // before a name is written there (review round 2).
    this.mapReadable = false
    if (this.io.chmod && !(await this.ownerOnly(this.mapPath))) {
      await this.io.chmod(this.mapPath).catch(() => undefined)
      if (!(await this.ownerOnly(this.mapPath))) {
        if (Object.keys(parsed.stored.map).length > 0) {
          this.stopReadable()
          return
        }
        this.mapReadable = true
        this.notice(EMPTY_MAP_READABLE)
      }
    }
    // Spec 085 L12: after load, what the disk holds that this guard did not
    // write is adopted (setEnabled checks git right after).
    if (this.loaded) this.adopt(parsed.stored.map, aliases)
    this.onDisk = parsed.stored.map
    this.stored = parsed.stored
  }

  /** Spec 085 L12: the map as this guard last read or wrote it. */
  private onDisk: SymbolMap = {}
  /** The map's and aliases file's text as last read or written ('' for no
   *  file): any change sends a save to git (review round 1 #1). */
  private mapText = ''
  private aliasesText = ''
  /** The last save's git check had no answer: the next one asks again. */
  private recheck = false
  private loaded = false
  /** Load had a git listing (spec 085 review round 1). */
  private listed = false
  /** Placeholders taken from the disk after load, or from a map git tracked:
   *  restored only once this session has shown them (078's shown set). */
  private adopted = new Set<string>()
  /** Spec 085 R2-3: the store at load had entries and no matching record. */
  private unrecordedAtLoad = false
  /** Records the placeholders of `map` and the re-read aliases that now
   *  stand for another name than they did, or for a name this guard never
   *  held; says whether there was any. A new placeholder for a name the guard
   *  held is not: a CLI publish renumbers the guard's own names (spec 066). */
  private adopt(map: SymbolMap, aliasesBefore: SymbolMap): boolean {
    // Only names under placeholders this guard trusts: a second placeholder
    // for an adopted name is adopted too (review round 1 #1).
    const trusted = (m: SymbolMap) =>
      Object.entries(m)
        .filter(([p]) => !this.adopted.has(p))
        .map(([, name]) => name)
    const known = new Set([
      ...trusted(this.onDisk),
      ...trusted(this.stored.map),
      ...trusted(aliasesBefore),
    ])
    const changed =
      (before: SymbolMap) =>
      ([p, name]: [string, string]) =>
        // One already judged keeps its verdict until its name changes.
        Object.hasOwn(before, p) ? before[p] !== name : !known.has(name)
    const foreign = [
      ...Object.entries(map).filter(changed(this.onDisk)),
      ...Object.entries(this.aliases).filter(changed(aliasesBefore)),
    ].map(([p]) => p)
    for (const p of foreign) {
      this.adopted.add(p)
      // Shown under another name: shown again before it restores. A new one
      // was shown only by its minter (seeMinted), or outside git.
      const before = this.onDisk[p] ?? aliasesBefore[p]
      if (before !== undefined && before !== (map[p] ?? this.aliases[p]) && this.shown.delete(p))
        this.shownVersion++
    }
    return foreign.length > 0
  }
  /** The map at load was readable by others and held no names (round 2). */
  private mapReadable = false

  // ── the record of maps Veilio wrote (spec 085 R2-3) ───────────────────────

  /** SHA-256 of `text`, lowercase hex (the record's format). */
  private static async sha256(text: string): Promise<string> {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
  }

  private recordPath(): string | undefined {
    return this.home ? join(this.home, '.veilio', WRITTEN_RECORD_FILE) : undefined
  }

  /** The record, or {} when there is none or it cannot be read. */
  private async readRecord(): Promise<Record<string, string>> {
    const path = this.recordPath()
    if (!path) return {}
    try {
      return parseWrittenRecord(await this.io.read(path)) ?? {}
    } catch {
      return {}
    }
  }

  /** What the record holds, or would hold, for the store's `mapText` and
   *  `aliasesText`, and the key it is held under. */
  private async recordEntry(mapText: string, aliasesText: string): Promise<[string, string]> {
    const key = (await this.io.realPath(this.root)) ?? this.root
    return [key, writtenRecordValue(await Guard.sha256(mapText), await Guard.sha256(aliasesText))]
  }

  /**
   * At load (spec 085 R2-3, T078a): a store that holds names but does not
   * match the record - a map that came with the files, with or without its
   * own .git, or one changed since Veilio wrote it - restores only names this
   * session has shown, and #51r says so once. The guard adopts nothing
   * itself: `veilio maps adopt` is the only way a map becomes recorded.
   */
  private async checkRecord(): Promise<void> {
    const entries = [...Object.keys(this.stored.map), ...Object.keys(this.aliases)]
    if (entries.length === 0) return
    // No home, no record: unrecorded, without hashing anything.
    if (this.recordPath() !== undefined) {
      const [key, value] = await this.recordEntry(this.mapText, this.aliasesText)
      if ((await this.readRecord())[key] === value) return
    }
    this.unrecordedAtLoad = true
    for (const p of entries) this.adopted.add(p)
    this.notice(NOT_RECORDED)
  }

  /** After a save over a recorded store: records what it wrote. Never fatal:
   *  without a record the next session asks for each name to be shown. */
  private async recordWrite(mapText: string): Promise<void> {
    const path = this.recordPath()
    if (!path) return
    try {
      const record = await this.readRecord()
      const [key, value] = await this.recordEntry(mapText, this.aliasesText)
      record[key] = value
      const text = `${JSON.stringify(record, null, 2)}\n`
      if (await this.io.exists(path)) await this.io.write(path, text)
      else await this.createOwnerOnly(path, text, false)
    } catch {
      // not recorded: shown-gated next time, the safe side
    }
  }

  /** Never fatal: a missing or unreadable file restores nothing extra. */
  private async readAliases(): Promise<SymbolMap> {
    const path = join(this.root, '.veilio', 'aliases.json')
    this.aliasesText = ''
    try {
      if (!(await this.io.exists(path))) return {}
      const text = await this.io.read(path)
      this.aliasesText = text
      const parsed = JSON.parse(text) as { aliases?: unknown }
      const a = parsed?.aliases
      if (!a || typeof a !== 'object' || Array.isArray(a)) return {}
      return Object.fromEntries(
        // Names only, as the CLI reads them (spec 085 R2-18).
        Object.entries(a).filter((e): e is [string, string] => isName(e[1]))
      )
    } catch {
      return {}
    }
  }

  /** `.veilio/map.json`, `aliases.json` and `guard.json` when git tracks
   *  them; null when that cannot be known (not a git checkout, no listing in
   *  time, or no way to list). */
  private async trackedVeilioFiles(deadline = Date.now() + 5000): Promise<string[] | null> {
    // At load, the whole project says whether this is a git checkout: an
    // empty listing is a folder inside a repository that tracks none of its
    // files (review round 1 #2); one the host cut short (a large repository)
    // is still git (round 3 #3). The verdict on .veilio always comes from the
    // .veilio-only listing when the host has one; after load, only it is
    // asked, and only if load had a listing (a save holds the map's lock).
    const whole = !this.loaded
    if (!whole && !this.listed) return null
    // shortcut: a git that answers in no 5 s (or before the result's deadline)
    // counts as no listing - guard.json may then only tighten, a committed
    // map is not detected yet (the next save asks again), and what was
    // adopted restores only once shown; upgrade if a slow-git bypass is shown.
    // Round 3 #2: at least 500 ms, however little of the result's time is left.
    const wait = Math.min(5000, Math.max(MIN_GIT_WAIT, deadline - Date.now()))
    const late = this.io.sleep ? this.io.sleep(wait).then(() => null) : null
    const answer = (p: Promise<string[] | null>) => (late ? Promise.race([p, late]) : p)
    const veilioOnly = this.io.listVeilio?.bind(this.io)
    let listed: string[] | null
    try {
      if (whole) {
        if (!this.io.list) return null
        const all = await answer(this.io.list(this.root))
        if (all === null || all.length === 0) return null
        this.listed = true
        // An IO with no .veilio-only listing (tests, another host) gets the
        // verdict from the whole one; the hooks always give one.
        listed = veilioOnly ? await answer(veilioOnly(this.root)) : all
      } else {
        const list = veilioOnly ?? this.io.list?.bind(this.io)
        if (!list) return null
        listed = await answer(list(this.root))
      }
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

  /** A committed map or aliases file: its values would be restored into
   *  commands the model only saw as placeholders. */
  private stopIfTracked(committed: string[] | null): void {
    const tracked = (committed ?? []).filter((f) => f !== '.veilio/guard.json')
    if (tracked.length === 0) return
    // Spec 085 L14: once git no longer tracks it, what the repository put
    // there still restores only once shown.
    for (const p of [...Object.keys(this.stored.map), ...Object.keys(this.aliases)])
      this.adopted.add(p)
    this.stop(
      `${tracked.join(' and ')} ${tracked.length > 1 ? 'are' : 'is'} tracked by git: a map in the repository is not yours to restore from. Remove it from git (git rm --cached) and pull or build your own`
    )
  }

  stop(reason: string): void {
    this.state = 'stopped'
    this.stoppedReason = reason
  }

  /** /veilio off|on: held in memory for the session (see
   *  retireLegacyOffRecord). */
  async setEnabled(enabled: boolean): Promise<void> {
    this.legacyOffRecord = false
    if (!enabled) {
      this.state = 'off'
      return
    }
    // Review round 1 #6: stopped while the settings and the map are read
    // again and git is asked, so no call runs on what was not checked; on
    // only if none of that stopped it.
    this.stop(SWITCHING_ON)
    try {
      await this.readSettings()
      await this.reloadMap()
      // Spec 085 H14: on again is never past the stop a tracked map puts on it.
      this.stopIfTracked(await this.trackedVeilioFiles())
    } catch {
      // Round 3 #6: what failed, not the passing "checking" reason; a fixed
      // text, as the host's error can name a path and a stop reaches the model.
      this.stop(ON_FAILED)
    }
    if (this.stoppedReason === SWITCHING_ON) {
      this.state = 'on'
      this.stoppedReason = ''
    }
  }

  /** Spec 078 FR-014: .veilio and the map must be where they appear, not a
   *  link to somewhere else (the CLI's refuseLinks, through the host's stat). */
  /** A real path the host gave and one the guard built name one file: on
   *  Windows with either separator and in any letter case (review round 1,
   *  correctness #5). */
  private samePath(real: string | undefined, built: string): boolean {
    if (real === undefined) return false
    // On Windows only: elsewhere a backslash is a character of a name.
    const norm = (p: string) => (this.windows ? p.replace(/\\/g, '/').toLowerCase() : p)
    return norm(real) === norm(built)
  }

  private async refuseLinks(): Promise<void> {
    const root = (await this.io.realPath(this.root)) ?? this.root
    const dir = await this.io.realPath(join(this.root, '.veilio'))
    const map = await this.io.realPath(this.mapPath)
    if (
      (dir !== undefined && !this.samePath(dir, join(root, '.veilio'))) ||
      (map !== undefined && !this.samePath(map, join(root, '.veilio', 'map.json')))
    ) {
      this.stop(
        'the map at .veilio/map.json is a link to somewhere else, so Veilio will not write the real names there. Fix it, then start a new session'
      )
      throw new Error(this.stoppedReason)
    }
  }

  /** Run in save(), after refuseLinks and before a name is written: the
   *  store holds the real names, and must never be committed. Spec 085 L4:
   *  one already there must be a plain file whose only pattern is `*` (a
   *  repository can commit its own); it is never rewritten. A missing one is
   *  written unless the path is a link (one that leads nowhere included), and
   *  the file is checked where it leads after that write as well. */
  private async ensureIgnored(): Promise<void> {
    const ignore = join(this.root, '.veilio', '.gitignore')
    if (!(await this.io.exists(ignore))) {
      if (await this.io.isLink?.(ignore)) {
        this.stop(IGNORE_STOP)
        throw new Error(this.stoppedReason)
      }
      await this.createOwnerOnly(ignore, '', false)
      await this.io.write(ignore, '*\n')
    }
    const root = (await this.io.realPath(this.root)) ?? this.root
    if (
      !this.samePath(await this.io.realPath(ignore), join(root, '.veilio', '.gitignore')) ||
      !onlyStar(await this.io.read(ignore))
    ) {
      this.stop(IGNORE_STOP)
      throw new Error(this.stoppedReason)
    }
  }

  /** Spec 078 R6: a file the guard creates is written with no names in it,
   *  made 0600, and checked, before its content is written. `names`: a file
   *  that holds them stops the guard when it cannot be made owner-only. */
  private async createOwnerOnly(path: string, empty: string, names = true): Promise<void> {
    await this.io.write(path, empty)
    if (!this.io.chmod) return
    await this.io.chmod(path).catch(() => undefined)
    if (names && !(await this.ownerOnly(path))) {
      this.stopReadable()
      throw new Error(this.stoppedReason)
    }
  }

  private async ownerOnly(path: string): Promise<boolean> {
    const mode = this.io.mode ? await this.io.mode(path).catch(() => undefined) : undefined
    return mode !== undefined && (mode & 0o077) === 0
  }

  private stopReadable(): void {
    this.stop(
      'the map at .veilio/map.json is readable by other users, so Veilio will not write the real names there. Fix it, then start a new session'
    )
  }

  // ── text ──────────────────────────────────────────────────────────────────

  /** Prompts, reminders, output: known names replaced, credentials removed. */
  applyText(
    text: string,
    kind: MaskContext['kind'] = 'result',
    scan?: ScanResult,
    budget: RuleBudget = ruleBudget()
  ): string {
    return this.gate(this.maskText(text, kind, scan, budget), text)
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
  private gate(out: string, before: string): string {
    if (survivingSecrets(out, this.map).length > 0)
      throw new Error('a credential remained after masking')
    return this.see(out, before)
  }

  /** Spec 078 R7: the placeholders this session put into text bound for the
   *  model. Outside git only these are restored. Only what masking put there
   *  counts: a token already in `before` - one the model wrote and got
   *  echoed back in a refusal, a result or a denial - is not shown. So are
   *  not the example placeholders of the guard's own note, which comes in
   *  with the text. */
  private shown = new Set<string>()
  /** Changes whenever `shown` does: what shownMap's cache is keyed by. */
  private shownVersion = 0
  private noListing = false
  private see(text: string, before: string): string {
    if (!this.noListing && this.adopted.size === 0) return text
    const token = /__[A-Z0-9_]+__\d*/g
    const had = new Set(before.match(token) ?? [])
    for (const m of text.matchAll(token)) {
      if (had.has(m[0]) || this.shown.has(m[0])) continue
      this.shown.add(m[0])
      this.shownVersion++
    }
    return text
  }
  /** Review round 1 (correctness) #1, round 2 #1: Veilio's own MCP server
   *  (the one server the tool name parses to is exactly `veilio`, from the
   *  user's config) writes the placeholders it returns into the map. One in
   *  its result counts as shown only when it is in the map now and was not
   *  when the guard last read it, the model did not write it into the call,
   *  and its name is in what the tool was asked to mask: the text given to
   *  `anonymize_text`, or the file `anonymize_file` names, read by the guard
   *  itself inside the project and not through a link. Anything else: not. */
  private async seeMinted(
    tool: string,
    texts: readonly string[],
    args: ToolEvent,
    readBefore: SymbolMap
  ): Promise<void> {
    const servers = mcpServersOf(tool)
    if (servers.length !== 1 || servers[0] !== 'veilio') return
    const source = await this.mintSource(tool.slice('mcp__veilio__'.length), args)
    if (source === null) return
    if (!(await this.io.exists(this.mapPath))) return
    const parsed = parseMapFile(await this.io.read(this.mapPath))
    if (!parsed.ok) return
    const map = parsed.stored.map
    const token = /__[A-Z0-9_]+__\d*/g
    const written = new Set<string>()
    for (const [k, v] of Object.entries(args))
      if (!RESERVED.has(k))
        deepRewrite(v, (s) => (s.match(token)?.forEach((t) => written.add(t)), s))
    for (const t of texts.join('\n').match(token) ?? [])
      if (
        Object.hasOwn(map, t) &&
        !Object.hasOwn(readBefore, t) &&
        !written.has(t) &&
        // Round 4 #2: the engine mints names only; a value that is not one
        // was not minted, whatever the file says now.
        MINTED_NAME.test(map[t]!) &&
        source.includes(map[t]!) &&
        // Written in the source already: not minted by this call (round 3 #1).
        !source.includes(t) &&
        !this.shown.has(t)
      ) {
        this.shown.add(t)
        this.shownVersion++
      }
  }

  /** What a Veilio MCP tool was asked to mask, or null when the guard cannot
   *  tell (review round 2 #1). */
  private async mintSource(name: string, args: ToolEvent): Promise<string | null> {
    if (name === 'anonymize_text') return typeof args.text === 'string' ? args.text : null
    if (name !== 'anonymize_file' || typeof args.path !== 'string') return null
    // Round 4 #1: a relative path from the session's directory, as the
    // server reads it, not from the project root.
    const path = normalisePath(
      /^[/\\]|^[A-Za-z]:/.test(args.path) ? args.path : join(this.cwd || this.root, args.path)
    )
    if (!path.startsWith(`${this.root}/`) || isRawOnly(path, this.extraRawOnly)) return null
    const root = (await this.io.realPath(this.root)) ?? this.root
    if (!this.samePath(await this.io.realPath(path), join(root, path.slice(this.root.length + 1))))
      return null
    return this.io.read(path).catch(() => null)
  }

  private shownCache: {
    from: SymbolMap
    size: number
    only?: ReadonlySet<string>
    onlySize: number
    map: SymbolMap
  } | null = null
  /** What restores outside git: the entries of `from` this session showed.
   *  With `only`, the entries outside it restore too (spec 085 L12). */
  private shownMap(from: SymbolMap, only?: ReadonlySet<string>): SymbolMap {
    const c = this.shownCache
    const onlySize = only?.size ?? 0
    if (
      c &&
      c.from === from &&
      c.size === this.shownVersion &&
      c.only === only &&
      c.onlySize === onlySize
    )
      return c.map
    const map: SymbolMap = {}
    if (only) {
      for (const [p, name] of Object.entries(from))
        if (!only.has(p) || this.shown.has(p)) map[p] = name
    } else for (const p of this.shown) if (Object.hasOwn(from, p)) map[p] = from[p]!
    this.shownCache = { from, size: this.shownVersion, only, onlySize, map }
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
    const full = () => this.gate(this.maskText(text, 'result', undefined, budget), text)
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
    return this.see(out, text)
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
    return restore(text, this.displayMap(), { strip: 'none' }).restored
  }

  /** Spec 085 R2-18: what the screen may show - only what a tool call would
   *  have restored (not a name still waiting to be shown), and each value
   *  through printable(), so a format character cannot drive the terminal. */
  private displayMap(): SymbolMap {
    const from = this.restorableMap(this.map)
    if (this.displayCache?.from !== from) {
      const map: SymbolMap = {}
      for (const [p, name] of Object.entries(from)) map[p] = printable(name)
      this.displayCache = { from, map }
    }
    return this.displayCache.map
  }
  private displayCache: { from: SymbolMap; map: SymbolMap } | null = null

  /** The map a placeholder may be restored from: outside git, or with
   *  entries this guard did not write, only what this session has shown. */
  private restorableMap(from: SymbolMap): SymbolMap {
    return this.noListing
      ? this.shownMap(from)
      : this.adopted.size
        ? this.shownMap(from, this.adopted)
        : from
  }

  // ── tool calls ────────────────────────────────────────────────────────────

  /** Spec 085 H17: where the shell is now, as far as the cds that ran tell;
   *  null once a cd went somewhere that cannot be told (`~` with no home).
   *  Spec 086: kept for the commands parseShell cannot read (FR-003). */
  private shellDir: string | null = null
  /** Spec 086 DirState: where the shell may be, read from every command
   *  parseShell reads. Empty: not known (main's null shellDir). */
  private dirs: DirState = {
    dirs: [],
    oldpwd: 'unknown',
    stack: [],
    vars: { HOME: 'unknown', CDPATH: 'unset', PWD: 'auto', OLDPWD: 'auto' },
  }
  /** CDPATH as the session's environment has it (unset when it has none). */
  cdpath: Var = 'unset'
  /** FR-011: the host reports the shell's directory at the start of a call
   *  (atHost). While it does, the next call starts there and the inference
   *  is only checked against it; until it does, every directory a command
   *  may have left the shell in is carried. */
  private hostReports = false
  /** This call's start, the host's directory and the guard's, is past the bound. */
  private hostOverflow = false
  /** Where the last call most likely left the shell: what proves the host. */
  private likely: readonly string[] = []
  private disagreementLogged = false
  /** The differential replay (tests/guard/fixtures/cd-project.ts) only: the
   *  benchmark corpus has no host directories, so each call is carried where
   *  it most likely ended, as a host would have reported it. */
  assumeSuccess = false
  /** Spec 086 FR-011: where Claude Code says the shell is as a call starts
   *  ($.session.cwd()). It is the truth; where the guard's reading of the
   *  last call disagrees, this call is checked in both (the host's alone
   *  past the bound), and the disagreement is logged once. */
  atHost(dir: string): void {
    const host = normalisePath(dir)
    const inferred = this.dirs.dirs
    this.hostOverflow = false
    this.shellDir = host
    // Trusted to narrow once proved live, from the call after the proof: it
    // named, away from where the session started, the one directory the
    // guard's walk most likely left the shell in. A report that never
    // moves - an older host, a host bug - never narrows (security review).
    const trusted = this.hostReports
    if (
      !trusted &&
      host !== normalisePath(this.cwd) &&
      this.likely.length === 1 &&
      this.likely[0] === host
    )
      this.hostReports = true
    if (trusted && (inferred.length === 0 || inferred.includes(host))) {
      this.dirs = { ...this.dirs, dirs: [host] }
      return
    }
    if (trusted && !this.disagreementLogged) {
      this.disagreementLogged = true
      this.notice(
        `Veilio guard: Claude Code says the shell is in ${host}, where Veilio's reading of the last command left it in ${inferred.join(', ')}. Both are checked for this call.`
      )
    }
    // Never discarded: the host's directory joins the walk's. Past the
    // bound the call is refused, never narrowed.
    const both = [...new Set([host, ...inferred])]
    this.hostOverflow = both.length > MAX_DIRS
    this.dirs = { ...this.dirs, dirs: both }
  }

  /** A call starts with an empty stack and the session's variables: the Bash
   *  tool keeps only its directory between calls (research R0, T003); the
   *  host sets OLDPWD to the project root. */
  private sessionState(dirs: readonly string[]): DirState {
    return {
      dirs,
      oldpwd: [normalisePath(this.root)],
      stack: [],
      vars: {
        HOME: this.home ? { value: this.home } : 'unknown',
        CDPATH: this.cdpath,
        PWD: 'auto',
        OLDPWD: 'auto',
      },
    }
  }
  private readonly cdContext: CdContext = {
    exists: (p) => this.io.exists(p),
    isDirectory: async (p) =>
      (await this.io.exists(p)) && !(this.io.isFile && (await this.io.isFile(p))),
  }
  /** Whether a directory a cd may land in is, or is inside, a raw-only one:
   *  read inside the project from its root (so a root under `~/.config`
   *  does not refuse every cd), and where it really leads. */
  private async landsRawOnly(dir: string, rawDirs: readonly string[]): Promise<boolean> {
    const root = normalisePath(this.root)
    const rel = (d: string) =>
      d === root ? '.' : d.startsWith(`${root}/`) ? d.slice(root.length + 1) : d
    if (cdIntoRawOnly(rel(dir), rawDirs)) return true
    const real = await this.io.realPath(dir)
    return real !== undefined && cdIntoRawOnly(rel(normalisePath(real)), rawDirs)
  }
  /** Windows, as the host says; undefined: the engine reads the platform. */
  private windows: boolean | undefined
  private moved(dir: string | null, target: string): string | null {
    if (target === '~' || target.startsWith('~/'))
      return this.home ? normalisePath(join(this.home, target.slice(1))) : null
    if (/^[/\\]|^[A-Za-z]:/.test(target)) return normalisePath(target)
    return dir === null ? null : normalisePath(join(dir, target))
  }
  /** The directories a command's relative words may be read from: where the
   *  shell is, and where each of its own cds takes it. */
  private shellDirsOf(command: string): string[] {
    const dirs: string[] = []
    // Spec 086: from each directory the shell may be in (one, as on main,
    // until a command parseShell reads leaves more).
    const starts: (string | null)[] = this.dirs.dirs.length ? [...this.dirs.dirs] : [null]
    for (const start of starts) {
      let dir = start
      if (dir !== null && dir !== this.cwd) dirs.push(dir)
      for (const t of allCdTargets(command)) {
        dir = this.moved(dir, t)
        if (dir !== null) dirs.push(dir)
      }
    }
    return [...new Set(dirs)]
  }

  /** Spec 086 FR-011: where the shell is after a call, success or failure:
   *  the top-level state of the command as run (restored), stack emptied
   *  and variables the session's. A command the reader cannot read moves
   *  each directory as main moves its one. */
  private async shellRan(tool: string, command: string): Promise<void> {
    const dialect = tool === 'PowerShell' ? 'ps' : 'sh'
    const parsed = parseShell(command, dialect)
    if (parsed.ok) {
      const walk = await walkCd(parsed.list, this.dirs, this.cdContext, dialect)
      const carry = this.hostReports || this.assumeSuccess ? walk.end : (walk.endAll ?? walk.end)
      this.dirs = this.sessionState(carry.dirs)
      this.likely = walk.end.dirs
    } else {
      // Only a top-level cd moves the shell the next call runs in; one in a
      // substitution or a nested shell does not (review round 2 of spec 078).
      const starts: (string | null)[] = this.dirs.dirs.length ? [...this.dirs.dirs] : [null]
      const ends = starts.map((start) => {
        let dir = start
        for (const t of cdTargets(command)) dir = this.moved(dir, t)
        return dir
      })
      this.dirs = this.sessionState(ends.filter((d): d is string => d !== null))
      this.likely = this.dirs.dirs
    }
    this.shellDir = this.dirs.dirs[0] ?? null
  }

  /** A relative path from the session's directory: the host resolves one
   *  from the mod's own, which is not where the agent's shell is. */
  private here(path: string): string {
    return /^[/\\~]|^[A-Za-z]:/.test(path) || !this.cwd ? path : join(this.cwd, path)
  }

  /** Whether a path is write-protected (spec 078 FR-012) and whether it is
   *  raw-only (as written, with `.`/`..` resolved, FR-007), each as written
   *  or where it leads: resolved once for both (review round 2). */
  private async pathHits(
    path: string
  ): Promise<{ written: boolean; rawOnly: boolean; mcp: string | null; folder: boolean }> {
    // One command asks about the same path several times (as a word, as raw
    // text, in each directory): answered once per call.
    const known = this.hitsThisCall?.get(path)
    if (known) return known
    // A word that is still longer than any path a system opens (PATH_MAX is
    // 4,096 on Linux, 1,024 on macOS) once `./`, `//` and `x/../` are read
    // out of it is text, not a file's name: a quoted script of a hundred
    // lines is one word. A long spelling of a short path is judged by the
    // short path (`././…/.env`).
    if (path.length > MAX_PATH) {
      const short = normalisePath(path)
      if (short.length > MAX_PATH)
        return { written: false, rawOnly: false, mcp: null, folder: false }
      if (short !== path) return this.pathHits(short)
    }
    // The engine's matcher tries each pattern at each part of the path.
    spend(
      this.cost ?? undefined,
      PATH_STEPS + Math.ceil((path.split('/').length * path.length) / 400)
    )
    const hits = (async () => {
      const raw = this.rawOnlyPath(path) || this.rawOnlyPath(normalisePath(path))
      const written = isWriteProtected(path)
      if (raw && written) return { written, rawOnly: raw, mcp: mcpConfigName(path), folder: false }
      const real = await this.io.realPath(this.here(path))
      return {
        // A folder all of whose files are raw-only (A11), named or led to.
        folder:
          namesRawOnlyFolder(path, this.extraRawOnly) ||
          (real !== undefined && namesRawOnlyFolder(real, this.extraRawOnly)),
        written: written || (real !== undefined && isWriteProtected(real)),
        rawOnly: raw || (real !== undefined && this.rawOnlyPath(real)),
        mcp: mcpConfigName(path) ?? (real !== undefined ? mcpConfigName(real) : null),
      }
    })()
    this.hitsThisCall?.set(path, hits)
    return hits
  }

  /** The budget of the shell command being read (A13); null outside one. */
  private cost: Cost | null = null
  /** The steps the last shell command took of MAX_STEPS. */
  lastSteps = 0
  /** A command Veilio cannot read - unbalanced, a shell given a script or an
   *  option the reader does not know, a zsh module, past the budget, or
   *  anything the reader threw: refused, with the command as typed (cut
   *  where it is longer than anyone would read). */
  private unreadable(command: string, budget: RuleBudget | undefined): { deny: string } {
    const shown = command.length > 400 ? `${command.slice(0, 400)}…` : command
    return this.deny(
      `Veilio refused this call: Veilio cannot read \`${this.applyText(shown, 'result', undefined, budget)}\` as a shell command, so it cannot tell whether it names a file Veilio keeps away from the model. Write it more simply, or ask the user to run it`,
      false
    )
  }
  /** What pathHits answered in the call being judged; null outside one. */
  private hitsThisCall: Map<
    string,
    Promise<{ written: boolean; rawOnly: boolean; mcp: string | null; folder: boolean }>
  > | null = null
  private rawOnlyKnown = new Map<string, boolean>()
  private rawOnlyKnownFor: { list: string[]; size: number } | null = null

  /** isRawOnly for the guard's list, remembered by path: the engine compiles
   *  every pattern on each call, which was most of a call's time. The answer
   *  depends on the path and the list only; a changed list forgets it. */
  private rawOnlyPath(path: string): boolean {
    const list = this.extraRawOnly
    if (
      this.rawOnlyKnownFor?.list !== list ||
      this.rawOnlyKnownFor.size !== list.length ||
      this.rawOnlyKnown.size > 20_000
    ) {
      this.rawOnlyKnown.clear()
      this.rawOnlyKnownFor = { list, size: list.length }
    }
    let answer = this.rawOnlyKnown.get(path)
    if (answer === undefined) {
      answer = isRawOnly(path, list)
      this.rawOnlyKnown.set(path, answer)
    }
    return answer
  }

  /** A command word as it was typed, for a refusal: known names are put back
   *  to their placeholders, and nothing else is changed, so `$DIR/.env` and
   *  `"$PWD"/.en*` read as written (the secret scan took `/.en*` for a key).
   *  A word that still holds a credential, or is long or not printable, is
   *  masked as any text for the model is. */
  private typed(raw: string, budget: RuleBudget): string {
    let text = raw
    const names = Object.entries({ ...this.map, ...this.unsaved }).sort(
      (a, b) => b[1].length - a[1].length
    )
    for (const [placeholder, real] of names) if (real) text = text.split(real).join(placeholder)
    return text.length <= 200 &&
      printable(text) === text &&
      survivingSecrets(text, this.map).length === 0
      ? text
      : this.applyText(raw, 'result', undefined, budget)
  }

  /** A name the shell spells without a wildcard: an absolute path as it is,
   *  a relative one in the session's directory (as written) and in each other
   *  directory `dirs` the shell may be in during the command. */
  private async spelledHits(name: string, dirs: readonly string[]) {
    const path = normalisePath(name)
    const at = /^[/\\~]|^[A-Za-z]:/.test(path)
      ? [path]
      : [name, ...dirs.filter((d) => d !== this.cwd).map((d) => join(d, path))]
    const out = { written: false, rawOnly: false, mcp: null as string | null, folder: false }
    for (const p of at) {
      const h = await this.pathHits(p)
      out.written ||= h.written
      out.rawOnly ||= h.rawOnly
      out.folder ||= h.folder
      out.mcp ??= h.mcp
    }
    return out
  }

  /** The refusal for a write-protected path: settings, or the MCP list (#59). */
  private denyProtected(hits: readonly { written: boolean; mcp: string | null }[]): {
    deny: string
  } {
    const mcp = hits.find((h) => h.written && h.mcp !== null)?.mcp
    return mcp ? this.deny(mcpConfigProtected(mcp), false) : this.deny(SETTINGS_PROTECTED)
  }

  /** Spec 085 R2-9 and its review: why a listed server's declaration is in
   *  doubt - `project` when a project's .mcp.json declares it (at the root, or
   *  where the session started, which is where Claude Code reads it), `twice`
   *  when ~/.claude.json declares it both for the user and for this project.
   *  `project` or `unreadable` alone when .mcp.json or ~/.claude.json cannot
   *  be read (it may declare any name).
   *  The scopes are Claude Code's documented ones: the host declares none. */
  private async mcpDoubts(): Promise<Map<string, Doubt> | Doubt> {
    const doubts = new Map<string, Doubt>()
    // As the tool prefix spells it, too: characters other than letters,
    // digits, `_` and `-` read as `_` (fail closed on either spelling).
    const spellings = (servers: object) =>
      Object.keys(servers).flatMap((n) => [n, n.replace(/[^A-Za-z0-9_-]/g, '_')])
    const read = async (path: string): Promise<unknown> => {
      if (!(await this.io.exists(path).catch(() => true))) return undefined
      return JSON.parse(await this.io.read(path))
    }
    const serversOf = (o: unknown): object | null | undefined => {
      const servers = (o as { mcpServers?: unknown } | null | undefined)?.mcpServers
      if (servers === undefined) return undefined
      return typeof servers === 'object' && servers !== null ? servers : null
    }
    try {
      for (const dir of new Set([this.root, this.cwd || this.root])) {
        let parsed: unknown
        try {
          parsed = await read(join(dir, '.mcp.json'))
        } catch {
          return 'project'
        }
        const servers = serversOf(parsed)
        if (servers === null) return 'project'
        for (const n of spellings(servers ?? {})) doubts.set(n, 'project')
      }
      if (!this.home) return 'unreadable'
      // shortcut: ~/.claude.json is read whole on each listed server's call;
      // cache it by mtime if a large one shows in the hook's time.
      const claude = (await read(join(this.home, '.claude.json'))) as
        { projects?: Record<string, unknown> } | undefined
      if (claude === undefined) return doubts
      const user = serversOf(claude)
      if (user === null) return 'unreadable'
      const keys = new Set([this.root, this.cwd || this.root])
      for (const k of [...keys]) keys.add((await this.io.realPath(k)) ?? k)
      const local = new Set<string>()
      for (const k of keys) {
        const servers = serversOf(claude.projects?.[k])
        if (servers === null) return 'unreadable'
        for (const n of spellings(servers ?? {})) local.add(n)
      }
      for (const n of spellings(user ?? {}))
        if (local.has(n) && !doubts.has(n)) doubts.set(n, 'twice')
      return doubts
    } catch {
      return 'unreadable'
    }
  }

  /** Before the tool runs: the raw-only check, then the arguments restored. */
  async beforeTool(
    e: ToolEvent,
    budget: RuleBudget = ruleBudget()
  ): Promise<{ deny: string } | { args: ToolEvent }> {
    try {
      return await this.judgeCall(e, budget)
    } finally {
      // What pathHits remembered holds for this call only.
      this.hitsThisCall = null
    }
  }

  private async judgeCall(
    e: ToolEvent,
    budget: RuleBudget
  ): Promise<{ deny: string } | { args: ToolEvent }> {
    // Spec 093 item 10: /veilio is typed by the person, never called by the model.
    if (callsOwnCommand(e)) return { deny: OWN_COMMAND_REFUSED }
    let policy = argumentPolicy(e.tool, this.mcpRestore)
    const servers = mcpServersOf(e.tool)
    // Spec 085 R2-9: a listed server the project's .mcp.json declares too may
    // be the repository's, not the developer's: placeholders, said once.
    if (policy.mcp) {
      const doubts = await this.mcpDoubts()
      const server = servers[0]!
      const doubt = typeof doubts === 'string' ? doubts : doubts.get(server)
      if (doubt !== undefined) {
        policy = argumentPolicy(e.tool, [])
        this.notice(
          doubt === 'twice'
            ? declaredTwice(server)
            : doubt === 'unreadable'
              ? claudeJsonUnread(server)
              : redeclaredServer(server)
        )
      }
    }
    if (servers.length > 1 && servers.some((s) => this.mcpRestore.includes(s)))
      this.notice(ambiguousServer(e.tool))
    const unresolved = new Set<string>()
    const altered = new Set<string>()
    const resolved = new Set<string>()
    const from = this.restoreMap
    const restorable = this.restorableMap(from)
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
      // Round 5 #6: a kind never written back says so, shown or not.
      restoresWhat ??= restoresNeverRestored(
        s,
        [...r.resolved, ...r.unresolved.filter((p) => Object.hasOwn(from, p))],
        this.restoreMap
      )
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
    // Spec 085 L18 (strings.md #10): an MCP tool gets a real name only in the
    // shape of a name or a path; a planted or pulled value could be SQL or a
    // query the model never saw.
    const unshaped = policy.mcp
      ? [...resolved].find((p) => !nameOrPath(this.restoreMap[p] ?? ''))
      : undefined
    if (unshaped !== undefined)
      return this.deny(
        `the real name for ${unshaped} is not shaped like a name or a path, so it is not put into an MCP tool's arguments. Ask the user to run this call`
      )

    const named: [string, { written: boolean; rawOnly: boolean; mcp: string | null }][] = []
    for (const field of policy.paths)
      for (const p of [e[field], args[field]])
        if (typeof p === 'string') named.push([p, await this.pathHits(p)])
    // Spec 078 FR-012: Claude Code's settings, in every permission mode.
    if (WRITE_TOOLS.has(e.tool) && named.some(([, h]) => h.written))
      return this.denyProtected(named.map(([, h]) => h))

    // A Windows stream or short name may stand for a raw-only file.
    for (const [p, h] of named)
      if (windowsAlias(p) || h.rawOnly)
        return this.deny(
          `Veilio keeps ${this.applyText(p, 'result', undefined, budget)} away from the model. Ask the user for what you need from it`,
          false
        )
    if (policy.command) {
      this.hitsThisCall = new Map()
      const dirs = rawOnlyDirectories([...DEFAULT_RAW_ONLY, ...this.extraRawOnly])
      // One budget for reading this call's command (reading table A13); a
      // command read past it, or anything the reader throws, is a command
      // Veilio cannot read: refused.
      const cost = newCost()
      this.cost = cost
      let reading = ''
      try {
        // The command as given and with its placeholders restored: read once
        // when the two are the same text (no placeholder in it).
        for (const c of new Set([e[policy.command], args[policy.command]])) {
          if (typeof c !== 'string') continue
          reading = c
          if (c.length > MAX_COMMAND) return this.unreadable(c, budget)
          // Spec 091 FR-011: text in the command (code after -c or -e, a quoted
          // argument, a here-document) that names Veilio's folder as a path,
          // whatever program receives it. A command the reader cannot read is
          // judged on its whole text.
          const shRead = parseShell(c, 'sh', cost)
          // Text a program only prints, stores or searches for is not judged
          // (reading table A12): `data` for the reader's checks, `seen` - the
          // command with those places blanked - for the checks on its text.
          const data = e.tool === 'Bash' && shRead.ok ? dataPositions(shRead.list) : undefined
          const seen = data ? withoutData(c, data) : c
          // Scripts in another program's own language (`sed`, `awk`, `jq`,
          // `python -c`, ...): judged for a name written plainly in them, not
          // as shell wildcards and not as a shell's script (reading table §9).
          const own = e.tool === 'Bash' && shRead.ok ? ownScripts(shRead.list) : null
          const notShell: Data | undefined =
            data && own
              ? {
                  words: new Set([...data.words, ...own.words]),
                  bodies: data.bodies,
                  inside: new Set([...data.inside, ...own.inside]),
                }
              : data
          if (shRead.ok ? textsOf(shRead.list, data).some(namesVeilioFolder) : namesVeilioFolder(c))
            return this.deny(INTERPRETER_GUARD_STATE)
          // Spec 078 FR-008: a cd there would let a later command read it by a
          // short name, in this call or the next (the shell keeps its directory).
          // A glob target could be any of them (review round 1 of spec 078).
          const into = cdTargetsToJudge(c).find((t) => /[*?[]/.test(t) || cdIntoRawOnly(t, dirs))
          if (into !== undefined)
            return this.deny(
              `Veilio keeps \`${this.applyText(into, 'result', undefined, budget)}\` away from the model, and a cd there would let a later command read it. Name the files you need by their full path, or ask the user`,
              false
            )
          // Spec 086: the cd rules, on what the reader reads; a command it
          // cannot read is judged as main judges it (FR-003).
          const dialect = e.tool === 'PowerShell' ? 'ps' : 'sh'
          const parsed =
            e.tool === 'Bash'
              ? shRead
              : e.tool === 'PowerShell'
                ? parseShell(c, dialect, cost)
                : null
          let moves: string[] = []
          // T029 review: code run from text, and new names for commands, in a
          // PowerShell command the reader read too.
          const psCode =
            parsed?.ok && dialect === 'ps'
              ? PS_CODE.test(c)
                ? 'code run from text'
                : PS_ALIAS.test(c)
                  ? 'a new name for a command'
                  : null
              : null
          if (psCode)
            return this.deny(
              `Veilio refused this call: Veilio cannot tell where \`${this.applyText(c, 'result', undefined, budget)}\` takes the shell (${psCode}), so a later command could read a file Veilio keeps away from the model. Use cd with a plain path, or name the files by their full path`,
              false
            )
          if (parsed?.ok && dialect === 'ps' && PS_DRIVE.test(c) && PS_LOCATION.test(c))
            return this.deny(
              `Veilio refused this call: Veilio cannot tell where \`${this.applyText(c, 'result', undefined, budget)}\` takes the shell (a drive this command creates), so a later command could read a file Veilio keeps away from the model. Use cd with a plain path, or name the files by their full path`,
              false
            )
          if (parsed?.ok) {
            // One step for each word that will be judged, charged before the
            // command is walked: a flood of words is refused for its cost
            // here, not after the work each of them takes.
            const judged = judgedWords(
              parsed.list,
              notShell ? { ...notShell, words: data!.words } : data
            )
            spend(cost, judged.words)
            // Each word costs two steps more when it is spelled out, and each
            // distinct plain word a path check at least: a command that
            // cannot pay for them is refused before that work is done.
            if (judged.spelled * 2 + judged.literals * PATH_STEPS > cost.steps)
              return this.unreadable(c, budget)
            const walk = await walkCd(parsed.list, this.dirs, this.cdContext, dialect)
            // Q3 = A: with no host report, a call that would leave the shell
            // in more directories than the bound is refused before it runs.
            const r =
              walk.refusal ??
              (this.hostOverflow ||
              (walk.endAll === null && !this.hostReports && !this.assumeSuccess)
                ? { kind: 'N1' as const, target: c, form: 'too many possible directories' }
                : null)
            if (r?.kind === 'N2')
              return this.deny(
                'Veilio refused this call: it sets HOME and names `~`, so Veilio cannot tell which files `~` stands for. Name the files by their full path, or ask the user',
                false
              )
            if (r)
              return this.deny(
                `Veilio refused this call: Veilio cannot tell where \`${this.applyText(r.target || c, 'result', undefined, budget)}\` takes the shell (${r.form}), so a later command could read a file Veilio keeps away from the model. Use cd with a plain path, or name the files by their full path`,
                false
              )
            for (const l of walk.landings)
              for (const d of l.dirs)
                if (await this.landsRawOnly(d, dirs))
                  return this.deny(
                    // A target with no path in it (`cd`, `cd -`, `popd`) is shown as where it goes.
                    `Veilio keeps \`${this.applyText(/^(?:cd|chdir|pushd|popd|-)$/.test(l.target) ? d : l.target, 'result', undefined, budget)}\` away from the model, and a cd there would let a later command read it. Name the files you need by their full path, or ask the user`,
                    false
                  )
            // Spec 091: every word of the command, wherever it stands (the
            // reading table), as the shell can read it - quotes and escapes
            // gone, braces and bracket lists expanded, a written default as one
            // more spelling - and in the pieces a program may take as a file
            // name, in each directory the shell may be in where the word is
            // read. A wildcard is refused when it could name a raw-only file.
            const home = typeof this.dirs.vars.HOME === 'object' ? this.dirs.vars.HOME.value : null
            const homeKnown = home !== null && walk.points.every((point) => point.home === home)
            // A word the cd walk read is judged where the walk says the shell
            // is at that point. A word the walk does not read (a redirect on a
            // loop, a written default, a command inside arithmetic or a
            // here-document) is judged where the nearest word or command
            // around it is read; one in a command the walk never reaches, in
            // the session's directory alone.
            // A command that changes how the shell reads words (`setopt`, an
            // unusual `shopt` or `set` option) is read strictly.
            const strict = readsStrictly(parsed.list)
            // Text read again as a script is still text: a folder's bare name
            // in it is a mention (`-t '.veilio folder'`), `.veilio/` a path (A11).
            const reread = rereadLists(parsed.list)
            const where = new Map<Word, Set<string>>()
            for (const point of walk.points)
              for (const w of point.words) {
                const dirs = where.get(w) ?? new Set()
                for (const d of point.dirs) dirs.add(d)
                where.set(w, dirs)
              }
            const around = new Map<object, string[]>()
            const dirsAround = (x: object): string[] => {
              let dirs = around.get(x)
              if (dirs === undefined) {
                dirs = [
                  ...new Set(wordsWithin(x).flatMap(({ word }) => [...(where.get(word) ?? [])])),
                ]
                around.set(x, dirs)
              }
              return dirs
            }
            for (const { word: w, within } of wordsWithin(parsed.list)) {
              if (notShell && within.some((x) => notShell.inside.has(x))) continue
              if (data?.words.has(w)) {
                // Text a program only prints or stores: not matched against
                // the list. What the shell does while expanding the word is
                // judged all the same - one it rewrites or runs code in
                // (`echo *(e:'...':)`) is refused here as anywhere.
                if (spellings(w, { home: null, homeKnown: false, strict: false, cost }) === 'any')
                  return this.deny(
                    `Veilio keeps ${this.typed(w.raw, budget)} away from the model. Ask the user for what you need from it`,
                    false
                  )
                continue
              }
              // Text read again as a script because some program may run it
              // may be code of another language, where `f(x)` is a call, not
              // a glob: there a word holding a plain group that is not read
              // exactly is left to the text floor. Every other word and
              // command of the text is judged (reading table §8.1, A5 (b)).
              if (
                within.some(isTextScript) &&
                w.parts.some((p) => p.kind === 'zglob' && p.any && !p.alternatives && !p.prefixed)
              )
                continue
              let at = [...(where.get(w) ?? [])]
              for (let k = within.length - 1; k >= 0 && !where.has(w) && at.length === 0; k--)
                if (isWord(within[k]!) || 'type' in within[k]!) at = dirsAround(within[k]!)
              // A word of many bracket expressions is charged before it is
              // matched: the matcher's work grows with their number squared.
              const brackets = w.parts.reduce((n, p) => n + (p.kind === 'glob' ? 1 : 0), 0)
              if (brackets > 8) spend(cost, brackets * brackets)
              const read = spellings(w, { home, homeKnown, strict, cost })
              // A zsh expansion that rewrites text written in the command:
              // the word could be any name.
              if (read === 'any')
                return this.deny(
                  `Veilio keeps ${this.typed(w.raw, budget)} away from the model. Ask the user for what you need from it`,
                  false
                )
              const dots = dotsMatch(w, strict)
              for (const spelling of read) {
                const name = dialect === 'ps' ? spelling.replace(/\\/g, '/') : spelling
                for (const piece of pieces(name)) {
                  const h = /[*?[\ue000]/.test(piece)
                    ? {
                        written: false,
                        mcp: null,
                        rawOnly: globMayBeRawOnly(piece, this.extraRawOnly, dots, cost),
                        folder: namesRawOnlyFolder(piece, this.extraRawOnly, dots, cost),
                      }
                    : await this.spelledHits(piece, at)
                  if (h.written) return this.denyProtected([h])
                  // A raw-only file, or a folder that holds only such files (A11).
                  if (h.rawOnly || (h.folder && !within.some((x) => reread.has(x))))
                    return this.deny(
                      // A word spelled as it was typed is shown by its piece
                      // that names the file (`.env` of `--env-file=.env`).
                      `Veilio keeps ${this.typed(spelling === w.raw ? piece : w.raw, budget)} away from the model. Ask the user for what you need from it`,
                      false
                    )
                }
              }
            }
            // Each plain word of each command, in every directory the shell may
            // be in there, `~` read with HOME as it is there (FR-010).
            for (const point of walk.points)
              for (const w of point.words) {
                if (data?.words.has(w)) continue
                const path = wordPath(w, point.home)
                if (path === null) continue
                // PowerShell's separator is `\\` too.
                const text = dialect === 'ps' ? path.replace(/\\/g, '/') : path
                for (const piece of pathsInCommand(text)) {
                  // An absolute path as written is checked below; one `~` became is not.
                  const at = /^[/\\]|^[A-Za-z]:/.test(piece)
                    ? w.literal === null
                      ? [normalisePath(piece)]
                      : []
                    : // The session's directory: checked below, as written.
                      point.dirs.filter((d) => d !== this.cwd).map((d) => join(d, piece))
                  for (const p of at) {
                    const h = await this.pathHits(p)
                    if (h.written) return this.denyProtected([h])
                    if (h.rawOnly)
                      return this.deny(
                        `Veilio keeps ${this.typed(w.literal === null ? w.raw : piece, budget)} away from the model. Ask the user for what you need from it`,
                        false
                      )
                  }
                }
              }
          } else if (dialect === 'sh' && parsed)
            // Spec 091 FR-010: a bash/zsh command the reader cannot read
            // (unbalanced, or past its bounds) is refused.
            return this.unreadable(c, budget)
          else if (dialect === 'ps' && parsed && !parsed.ok && parsed.why === 'cost')
            return this.unreadable(c, budget)
          else if (dialect === 'ps' && parsed && PS_UNREADABLE.test(c))
            // A PowerShell command the reader does not model, naming a
            // location command anywhere: refused (review of the PowerShell
            // path), in the words for a command Veilio cannot read. The cd
            // refusals above keep theirs.
            return this.unreadable(c, budget)
          else moves = this.shellDirsOf(c)
          // Spec 085 H17: a word after a cd names a file in the directory the
          // shell moved to, in this call or an earlier one: checked there too.
          // Spec 091 FR-009: then the same check on the text with line
          // continuations, quotes and backslashes removed - a floor that does
          // not depend on the reader, showing the chunk as it was typed.
          const floor = textPieces(parsed?.ok ? parsed.list : null, seen, data)
          // A piece with a wildcard, a bracket or a brace is judged as a word
          // (reading table A8): expanded, and matched against the list.
          // Another program's own script is not shell wildcards.
          const wild =
            notShell && own && own.words.size > 0
              ? textPieces(parsed?.ok ? parsed.list : null, withoutData(c, notShell), notShell)
              : floor
          for (const [typed, read] of wild) {
            spend(cost)
            if (!/[*?[{]/.test(read)) continue
            const brackets = read.split('[').length - 1
            if (brackets > 8) spend(cost, brackets * brackets)
            for (const name of braceNames(bracketsRead(read)))
              for (const piece of pieces(name)) {
                if (piece.startsWith('-')) continue
                const hit = /[*?[]/.test(piece)
                  ? globMayBeRawOnly(piece, this.extraRawOnly, false, cost)
                  : (await this.spelledHits(piece, [])).rawOnly
                if (hit)
                  return this.deny(
                    `Veilio keeps ${this.typed(typed, budget)} away from the model. Ask the user for what you need from it`,
                    false
                  )
              }
          }
          const texts: [word: string, typed: string | null][] = [
            ...pathsInCommand(seen).map((word): [string, null] => [word, null]),
            ...floor.flatMap(([typed, read]) =>
              pathsInCommand(read).map((word): [string, string] => [word, typed])
            ),
          ]
          // The path checks these will cost, before one is made.
          const unasked = new Set(
            texts.map(([word]) => word).filter((w) => !this.hitsThisCall?.has(w))
          )
          if (unasked.size * PATH_STEPS > cost.steps) return this.unreadable(c, budget)
          for (const [word, typed] of texts) {
            const under = /^[/~\\]|^[A-Za-z]:/.test(word) ? [] : moves.map((d) => join(d, word))
            // Spec 078 FR-012, found the way raw-only files are (review round 1).
            const hits = []
            for (const at of [word, ...under]) hits.push(await this.pathHits(at))
            if (hits.some((h) => h.written)) return this.denyProtected(hits)
            const hit =
              hits[0]!.rawOnly || shortNameAlias(word, this.windows) || hits.some((h) => h.rawOnly)
            if (hit) {
              return this.deny(
                `Veilio keeps ${typed === null ? this.applyText(word, 'result', undefined, budget) : this.typed(typed, budget)} away from the model. Ask the user for what you need from it`,
                false
              )
            }
          }
        }
      } catch {
        return this.unreadable(reading, budget)
      } finally {
        this.lastSteps = MAX_STEPS - cost.steps
        this.cost = null
      }
    }

    // A tool with no row (an MCP server, a tool added later): any argument that
    // is a raw-only path, as written or restored, refuses the call.
    if (policy.paths.length === 0 && !policy.command) {
      for (const source of [e, args]) {
        const strings: string[] = []
        for (const [k, v] of Object.entries(source)) {
          if (!RESERVED.has(k)) {
            deepRewrite(v, (s) => (strings.push(s), s))
            keysOf(v, strings)
          }
        }
        for (const s of strings) {
          // Spec 085 R2-13: every string and key, whatever its length, and
          // spaces in its folders (`/tmp/My Project/.env`), and Windows short
          // names. Prose that names one in passing ("the config/.env file is
          // stale") ends in words, not a file, and passes. Where it leads is
          // asked only for what can be a path the host opens.
          const hit =
            endsInAName(s) &&
            (isRawOnly(s, this.extraRawOnly) ||
              isRawOnly(normalisePath(s), this.extraRawOnly) ||
              shortNameAlias(s, this.windows) ||
              (isPathLike(s) && (await this.pathHits(s)).rawOnly))
          if (hit) {
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
      (await this.save(shaped.additions, deadline)).status === 'conflict'
    )
      return this.withhold(
        'another program changed .veilio/map.json while Veilio was writing to it'
      )
    const left = survivingSecrets(shaped.text, { ...this.map, ...shaped.additions })
    if (left.length > 0)
      return this.withhold(`a secret remained after masking (${[...new Set(left)].join(', ')})`)
    return { deny: this.see(shaped.text, raw) }
  }

  /** After the tool ran: the listed fields scrubbed, new names saved, then the secret re-scan. */
  async afterTool(
    tool: string,
    args: ToolEvent,
    received: { deny?: string; result?: unknown; text?: string; isError?: boolean },
    deadline = Date.now() + 6_000,
    budget: RuleBudget = ruleBudget()
  ): Promise<ToolOutcome> {
    try {
      return await this.afterResult(tool, args, received, deadline, budget)
    } catch (err) {
      // Spec 085 L16 (strings.md #12): two keys masked to one are never merged.
      if (err instanceof KeyClash) return this.withhold(KEY_CLASH)
      throw err
    }
  }

  private async afterResult(
    tool: string,
    args: ToolEvent,
    received: { deny?: string; result?: unknown; text?: string; isError?: boolean },
    deadline: number,
    budget: RuleBudget
  ): Promise<ToolOutcome> {
    let outcome = received
    // First, whatever the outcome: a failed command may have moved the shell.
    if (tool === 'Bash' && typeof args.command === 'string' && MOVES.test(args.command))
      this.shellMoved = true
    if ((tool === 'Bash' || tool === 'PowerShell') && typeof args.command === 'string')
      await this.shellRan(tool, args.command)
    // A denial reaches the model as text, like an error's: masked the same way.
    if (outcome.deny !== undefined) return this.maskMessage(outcome.deny, args, deadline, budget)
    // Round 3 #5: the map as read before this result's saves, for seeMinted.
    const readBefore = this.onDisk
    // Spec 085 L16: an MCP result's keys are data, read and masked as its strings.
    const keys = isMcpTool(tool) ? mcpDataKeys : undefined
    // Spec 050: the files this result names are indexed before it is masked,
    // so their names are in the map even if Claude never read them.
    const texts: string[] = []
    deepRewrite(
      outcome.isError ? (outcome.text ?? outcome.result ?? '') : outcome.result,
      (s) => {
        texts.push(s)
        return s
      },
      undefined,
      keys
    )
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
    // A shell's stdout, read now or later from a background shell (review round 1 item 5).
    const shell = SHELL_OUTPUT.has(tool)
    // An error's text never fits the tool's output schema, which Claude Code
    // checks a hook's `{ result }` against: it goes back as the error text the
    // model reads, masked.
    if (outcome.isError) {
      const raw = typeof outcome.text === 'string' ? outcome.text : String(outcome.result ?? '')
      // A failed command's text reaches the model too (security review of
      // the encoded-name check).
      const runs = new DecodedOnce()
      if (shell && encodedName(raw, this.map, () => runs.of(raw)) !== null)
        return this.withhold(ENCODED_NAME)
      this.destroyed.learn(destroyedValues([raw], this.map))
      const stripped = strip(raw)
      if (this.destroyed.reshaped(stripped, () => runs.of(stripped)))
        return this.withhold(RESHAPED_CREDENTIAL)
      return this.maskMessage(strip(raw), args, deadline, budget, true)
    }
    const filePath = typeof args.file_path === 'string' ? args.file_path : ''
    // The file's kind, never its path (engine spec 013 R19): the
    // environment-style credential rules apply, the test-file relaxation does not.
    const fileKind = filePath ? fileKindOf(filePath) : undefined
    outcome = {
      ...outcome,
      result: this.dropRawOnly(tool, outcome.result, await this.searchedThrough(tool, args)),
    }
    const policy = resultPolicy(tool, outcome.result, filePath)
    if (policy.kind === 'withhold') return this.withhold(policy.reason)
    const sent: string[] = []
    deepRewrite(
      outcome.result,
      (s) => {
        sent.push(s)
        return s
      },
      undefined,
      keys
    )
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
                new Set(policy.kind === 'fields' ? policy.keep : []),
                keys
              ),
      }

    // Spec 078 FR-005: what the sweep above removed whole may still be here
    // reformatted, sliced or encoded; read before masking, which would mint
    // a slice as a name.
    // Spec 078 FR-018a: a shell can print a project name encoded, which
    // masking does not read; read before masking, which would mint it. Each
    // string's base64 and hex runs are decoded once for both checks (review
    // round 1 item (f)).
    const runs = new DecodedOnce()
    let reshaped = false
    let encoded = false
    deepRewrite(
      outcome.result,
      (s) => {
        // Exact copies left in a kept field are the last scan's (it names them).
        const stripped = strip(s)
        reshaped ||= this.destroyed.reshaped(stripped, () => runs.of(stripped))
        if (shell) encoded ||= encodedName(s, this.map, () => runs.of(s)) !== null
        return s
      },
      undefined,
      keys
    )
    if (reshaped) return this.withhold(RESHAPED_CREDENTIAL)
    if (encoded) return this.withhold(ENCODED_NAME)

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
      else if (policy.kind === 'deep') value = deepRewrite(value, apply, undefined, keys)
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
        value = deepRewritePaths(value, again, new Set(policy.keep), keys)
      }
      // A name shaped like an identifier that is still here - in a file the
      // index has not reached - is masked and added (spec 050 R1).
      const keep = policy.kind === 'fields' ? new Set(policy.keep) : new Set<string>()
      value = rewriteKeyed(
        value,
        (s, key, at) => {
          if (keep.has(key)) return s
          // An enum is one bare token at the top of a record; a sentence under
          // `status`, or a value deeper down, is masked like any other. In an
          // MCP result only a content block's `type` is one (review round 1 #4).
          const enumKey = keys ? MCP_BLOCK_TYPE.test(at) : ENUM_KEYS.has(key)
          if (policy.kind !== 'text' && enumKey && /^[\w$.-]+$/.test(s)) return s
          return perLine(s, (t, c) => {
            const shaped = maskShaped(t, working, c, this.numbering)
            grow(working, shaped.additions)
            grow(additions, shaped.additions)
            return shaped.text
          })
        },
        keys
      )

      if (Object.keys(additions).length > 0) {
        const { status: saved } = await this.save(additions, deadline)
        if (saved === 'conflict') continue
      }

      const left: string[] = []
      deepRewrite(
        value,
        (s) => {
          left.push(...survivingSecrets(s, working))
          return s
        },
        undefined,
        keys
      )
      if (left.length > 0)
        return this.withhold(`a secret remained after masking (${[...new Set(left)].join(', ')})`)
      const given = texts.join('\n')
      deepRewrite(value, (s) => this.see(s, given), undefined, keys)
      await this.seeMinted(tool, texts, args, readBefore)
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
  private dropRawOnly(
    tool: string,
    result: unknown,
    link: { as: string[]; real: string } | null = null
  ): unknown {
    if ((tool !== 'Grep' && tool !== 'Glob') || !result || typeof result !== 'object') return result
    const record = result as Record<string, unknown>
    // Spec 085 R2-14: under a searched link, a path is also read as where the
    // link leads (`docs/s/db.yml` is `secrets/db.yml`).
    const through = (p: string) => {
      const n = p.replace(/\\/g, '/')
      for (const prefix of link?.as ?? [])
        if (n === prefix || n.startsWith(`${prefix}/`)) return link!.real + n.slice(prefix.length)
      return null
    }
    const raw = (p: string) => {
      if (isRawOnly(p, this.extraRawOnly)) return true
      const real = through(p)
      return real !== null && isRawOnly(real, this.extraRawOnly)
    }
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

  /** Spec 085 R2-14: the path a Grep or Glob searched, when it is (or runs
   *  through) a link: its spellings as a result prints them, and where it
   *  leads. Null when there is no such path, or it leads where it says. */
  private async searchedThrough(
    tool: string,
    args: Record<string, unknown>
  ): Promise<{ as: string[]; real: string } | null> {
    if ((tool !== 'Grep' && tool !== 'Glob') || typeof args.path !== 'string') return null
    const written = normalisePath(args.path.replace(/\\/g, '/')).replace(/\/+$/, '')
    const absolute = normalisePath(this.here(written))
    const real = await this.io.realPath(absolute)
    if (real === undefined || this.samePath(real, absolute)) return null
    const rel = absolute.startsWith(`${this.root}/`) ? absolute.slice(this.root.length + 1) : null
    return { as: [...new Set([written, absolute, ...(rel ? [rel] : [])])], real }
  }

  /** Adds entries to the map file: read what is there now, merge, write.
   *  Says how many names went to the quarantine instead
   *  (review of 6e14ec6: returned, not shared through guard state). */
  private save(
    additions: SymbolMap,
    deadline?: number
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
          // Minted before any text holds the engine's number: only indexing
          // raw files sends a name here.
          this.quarantineName(name)
          quarantined++
        } else kept[placeholder] = name
      }
      additions = kept
    }
    const attempt = async (
      retries: number
    ): Promise<{ status: 'saved' | 'conflict'; quarantined: number }> => {
      await this.refuseLinks()
      let onDisk: StoredMap = { version: 1, map: {} }
      const existed = await this.io.exists(this.mapPath)
      const mapText = existed ? await this.io.read(this.mapPath) : ''
      if (existed) {
        const parsed = parseMapFile(mapText)
        if (!parsed.ok) {
          this.stop(`the map at .veilio/map.json could not be read: ${parsed.reason}`)
          throw new Error(this.stoppedReason)
        }
        onDisk = parsed.stored
      }
      const aliases = this.aliases
      const aliasesText = this.aliasesText
      await this.reloadSideFiles()
      // Spec 085 L12: entries another program wrote (a git pull) are checked
      // against git before any of them is merged; so is any change to either
      // file, new names or not (review round 1 #1).
      const adopted = this.adopt(onDisk.map, aliases)
      if (adopted || this.recheck || mapText !== this.mapText || this.aliasesText !== aliasesText) {
        const tracked = await this.trackedVeilioFiles(deadline)
        // Review round 2 #2: a git that did not answer leaves it open; the
        // next save asks again (what arrived stays shown-gated meanwhile).
        this.recheck = tracked === null && this.listed
        this.stopIfTracked(tracked)
        if (this.state === 'stopped') throw new Error(this.stoppedReason)
      }
      this.onDisk = onDisk.map
      this.mapText = mapText
      // Everything this guard knows, not only the new entries: a writer that
      // dropped ours (two programs saving at once) gets them back.
      const { merged, conflicts } = mergeAdditions(onDisk.map, { ...this.stored.map, ...additions })
      if (conflicts.length > 0) {
        this.stored = onDisk
        return { status: 'conflict' as const, quarantined }
      }
      const next: StoredMap = { ...onDisk, map: merged }
      // Spec 085 R2-3: what the store held before this write decides whether
      // the write is recorded (no laundering a planted map). An empty store
      // counts only when this session never held an unrecorded one (review:
      // emptying the file must not launder it). Hashed after the git check,
      // and only with a record to keep: nothing between a save and git's answer.
      const recordable = this.recordPath() !== undefined
      const before = recordable ? await this.recordEntry(mapText, this.aliasesText) : null
      const matched = before !== null && (await this.readRecord())[before[0]] === before[1]
      const recordedBefore =
        matched ||
        (Object.keys(onDisk.map).length === 0 && this.aliasesText === '' && !this.unrecordedAtLoad)
      // Never recorded while what is written holds a name not yet shown-trusted.
      // A matched record vouches for what the disk held; anything else adopted
      // (held in memory only) is not laundered into it.
      const vouched = (p: string) => matched && onDisk.map[p] === next.map[p]
      const wasRecorded =
        recordedBefore &&
        !Object.keys(next.map).some((p) => this.adopted.has(p) && !vouched(p)) &&
        (matched || !Object.keys(this.aliases).some((p) => this.adopted.has(p)))
      if (existed && this.mapReadable && this.io.chmod) {
        await this.io.chmod(this.mapPath).catch(() => undefined)
        if (!(await this.ownerOnly(this.mapPath))) {
          this.stopReadable()
          throw new Error(this.stoppedReason)
        }
        this.mapReadable = false
      }
      await this.ensureIgnored()
      // Spec 093 item 6: read again right before the write. Another session
      // that saved since this one read the file had its entries dropped, and
      // a placeholder both had minted then meant two names. A changed file is
      // read, checked and merged again from the start.
      // shortcut: the file API a mod gets has no rename and no lock, so a write
      // that lands between this read and the write below is still lost
      // (COVERAGE.md); write beside and rename when the host offers one.
      const now = (await this.io.exists(this.mapPath)) ? await this.io.read(this.mapPath) : ''
      if (now !== mapText && retries > 0) return attempt(retries - 1)
      if (!existed)
        await this.createOwnerOnly(this.mapPath, serialiseMapFile({ version: 1, map: {} }))
      const written = serialiseMapFile(next)
      await this.io.write(this.mapPath, written)
      this.onDisk = next.map
      this.mapText = written
      this.stored = next
      if (wasRecorded) await this.recordWrite(written)
      return { status: 'saved' as const, quarantined }
    }
    const run = this.writes.then(() => attempt(MAX_RETRIES))
    // A failed write must not wedge every later one.
    this.writes = run.catch(() => undefined)
    return run
  }
}

/** Each text's decoded base64 and hex runs, decoded when a check first asks
 *  (one that needs none never does), and once for two checks of one text. */
class DecodedOnce {
  private last: { text: string; runs: string[] } | null = null
  of(text: string): readonly string[] {
    if (this.last?.text !== text) this.last = { text, runs: decodedRuns(text) }
    return this.last.runs
  }
}

/** Review round 1 #6 (strings.md, pending): the stop while /veilio on checks. */
const SWITCHING_ON = 'Veilio is checking the map before it switches back on; try again in a moment'

/** Round 3 #6 (strings.md, pending): a read failed while /veilio on checked. */
const ON_FAILED =
  'the settings or the map could not be read when the guard was switched back on. Fix that, then /veilio on'

/** strings.md #12 (spec 085 L16), as `withheld` completes it. */
const KEY_CLASH =
  'two keys of its result would read the same once masked, so they could not both be sent. Nothing from it was sent'

/** strings.md #11 (spec 085 L20), said once a session per tool. */
const ambiguousServer = (tool: string) =>
  `Veilio: ${tool} could belong to more than one MCP server, so it gets placeholders, not real names.`

/** strings.md #9 (spec 085 L4), as the band completes it. */
const IGNORE_STOP =
  '.veilio/.gitignore does not keep the map out of git (it must be a plain file whose only pattern is `*`). Fix it, then /veilio on'

/** The CLI's rule (packages/cli/src/store.ts onlyStar): `*` then `!map.json`
 *  would let git track the map. Blank lines and `#` comments allowed; only a
 *  line exactly `*` (CRLF accepted) counts, as git keeps spaces and tabs. */
function onlyStar(text: string): boolean {
  const patterns = text.split(/\r?\n/).filter((l) => l !== '' && !l.startsWith('#'))
  return patterns.length > 0 && patterns.every((l) => l === '*')
}

/** strings.md #61 (spec 085 R2-15, approved 2026-11-08), once per pattern. */
const unmatchableRawOnly = (pattern: string) =>
  `Veilio: rawOnly pattern \`${pattern}\` in .veilio/guard.json can never match a file, so it protects nothing. Write it relative to the project root, such as \`config/prod.yml\` or \`secrets/**\`.`

/** strings.md #59 (spec 085 R2-9, approved 2026-11-08). */
const mcpConfigProtected = (file: string) =>
  `Veilio refused this change: ${file} decides which MCP servers receive your real names, so the agent may not change it. Ask the user to make this change`

/** Why a listed server's declaration is in doubt (mcpDoubts). */
type Doubt = 'project' | 'twice' | 'unreadable'

/** strings.md #57c (review of the run-2 guard branch, pending). */
const claudeJsonUnread = (server: string) =>
  `Veilio: ~/.claude.json could not be read, so \`${server}\` gets placeholders, not real names.`

/** strings.md #57b (review of the run-2 guard branch, pending), once a
 *  session per server. */
const declaredTwice = (server: string) =>
  `Veilio: \`${server}\` is declared more than once in ~/.claude.json (for you and for this project), so its tools get placeholders, not real names.`

/** strings.md #57 (spec 085 R2-9), said once a session per server. */
const redeclaredServer = (server: string) =>
  `Veilio: \`${server}\` is also declared in this project's .mcp.json, so its tools get placeholders, not real names.`

/** strings.md #51r (spec 085 R2-3, approved 2026-11-09). */
const NOT_RECORDED =
  'Veilio: `.veilio/map.json` here was not written by Veilio on this machine, or was changed since, so its names are put back only after this session has shown them. If it is yours, run `veilio maps adopt` in this project.'

/** Review round 2 #7: said once, when a map with no names cannot be made 0600. */
const EMPTY_MAP_READABLE =
  'Veilio: .veilio/map.json is readable by other users and could not be made owner-only. It holds no names yet; Veilio will stop before it writes one there.'

/** The tools whose result is a shell's output. */
const SHELL_OUTPUT = new Set(['Bash', 'PowerShell', 'BashOutput', 'TaskOutput'])

/** A command that changes the shell's directory: `cd`, `pushd` or `popd`
 *  at its start or after `&&`, `||`, `;`, `|`, a lone `&`, a newline or `(`. */
/** PowerShell's location commands, named anywhere in a command's text. */
const PS_LOCATION =
  /set-location|push-location|pop-location|(?<![\w-])(?:sl|cd|chdir|pushd|popd)(?![\w-])/i
/** A PowerShell command the reader cannot read is refused when its text has
 *  any of these (review of the PowerShell path); otherwise main's verdict:
 *  a location command, a backtick, `&` or `.` as a command, code run from a
 *  string, the session state, a new drive, a command run elsewhere. */
const PS_UNREADABLE = new RegExp(
  [
    PS_LOCATION.source,
    '`',
    String.raw`(?:^|[;|{(\n])\s*(?:&|\.(?=[\s'"$]))`,
    String.raw`(?<![\w-])(?:iex|ndr|mount|icm)(?![\w-])`,
    String.raw`invoke-expression|sessionstate|new-psdrive|invoke-command|start-process|\$executioncontext`,
  ].join('|'),
  'i'
)
/** PowerShell running text as code, or the session's location by method. */
// A backstop to the walk's checks, by shape: a member invoked (`.M(`, `::M(`)
// or built (`.$x`, `."x"`), a script block cast or invoked, any Invoke-*,
// a function:/variable: path, the session state (the second T029 review).
const PS_CODE = new RegExp(
  [
    String.raw`(?<![\w-])(?:iex|icm)(?![\w-])|invoke-\w|sessionstate|\$executioncontext`,
    String.raw`[\w\])}'"]\s*(?:\.|::)\s*\w+\s*\(`,
    String.raw`[\w\])}]\.\s*[$("']`,
    String.raw`\[\s*scriptblock\s*\]`,
    String.raw`(?:^|[;|({\s])[&.]\s*\{`,
    String.raw`(?<![\w-])(?:function|variable):`,
  ].join('|'),
  'i'
)
/** PowerShell giving a command a new name. */
const PS_ALIAS = /\w-alias\b|(?<![\w-])(?:sal|nal|ipal|epal)(?![\w-])|alias:/i
/** A drive the command makes: with a location command beside it, refused. */
const PS_DRIVE = /new-psdrive|(?<![\w-])(?:ndr|mount)(?![\w-])/i
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
