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
  serialiseMapFile,
  type StoredMap,
  type SymbolMap,
} from './mapfile.ts'
import { isRawOnly, pathsInCommand } from './paths.ts'
import { bounded, LATE, ProjectIndex } from './index.ts'
import {
  argumentPolicy,
  isSourcePath,
  languageOf,
  languageOfCommand,
  languageOfGrepLine,
  resultPolicy,
} from './policy.ts'
import {
  applyMap,
  Destroyed,
  destroyedValues,
  redactKnown,
  maskShaped,
  NO_CONTEXT,
  restoreArgs,
  scrubSource,
  survivingSecrets,
} from './scrub.ts'
import type { MaskContext, ScanResult } from './scrub.ts'
import { restore, scanSecrets } from '../vendor/engine/index.js'
import { MODEL_NOTE } from './ui.ts'

export interface GuardIO {
  read(path: string): Promise<string>
  write(path: string, text: string): Promise<void>
  exists(path: string): Promise<boolean>
  /** Where a path really leads (symbolic links followed), or undefined. */
  realPath(path: string): Promise<string | undefined>
  /** The project's tracked files, relative to `root` (`git ls-files`), or null
   *  when it cannot be listed. Absent: the project is never listed, and only
   *  the files a result names are indexed. */
  list?(root: string): Promise<string[] | null>
  /** Resolves after `ms` ($.clock.sleep): bounds a read or `git` that hangs. */
  sleep?(ms: number): Promise<void>
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

export type GuardState = 'on' | 'off' | 'stopped'
export type ToolEvent = Record<string, unknown> & { tool: string }
export type ToolOutcome = { deny: string } | { result: unknown; isError?: true }

// Keys Claude Code adds to a tool call's event; none of them is the tool's own.
const RESERVED = new Set(['tool', 'tool_use_id', 'consent', 'agentId'])
const MAX_RETRIES = 3

export const WITHHELD_FAILED =
  'Veilio withheld this result: the guard failed while checking it. Nothing from it was sent.'
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

export class Guard {
  state: GuardState = 'on'
  stoppedReason = ''
  root = ''
  stored: StoredMap = { version: 1, map: {} }
  extraRawOnly: string[] = []
  mcpRestore: string[] = []
  counts = { withheld: 0, denied: 0 }
  /** Credentials destroyed this session, in memory only: removed from
   *  everything masked after, under one token each (review of 8aed5e8). */
  readonly destroyed = new Destroyed()
  /** The project's source files, indexed so a result is masked by what it
   *  contains (spec 050). Created when the guard loads. */
  index: ProjectIndex | null = null
  private writes: Promise<unknown> = Promise.resolve()
  private indexing: Promise<unknown> = Promise.resolve()
  private unsaved: SymbolMap = {}
  private batch: string[] = []

  constructor(
    private readonly io: GuardIO,
    private readonly config: GuardConfig
  ) {}

  get mapPath(): string {
    return join(this.root, '.veilio', 'map.json')
  }

  get settingsPath(): string {
    return join(this.root, '.veilio', 'guard.json')
  }

  get map(): SymbolMap {
    return this.stored.map
  }

  /** The project root: the nearest directory with .veilio or .git, as the CLI finds it. */
  async load(cwd: string): Promise<void> {
    let dir: string | null = cwd
    this.root = cwd
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
    await this.readSettings()
    await this.reloadMap()
    this.index = new ProjectIndex(
      {
        list: () => (this.io.list ? this.io.list(this.root) : Promise.resolve(null)),
        read: (rel) => this.io.read(join(this.root, rel)),
        now: () => Date.now(),
        wait: this.io.sleep ? (ms) => this.io.sleep!(ms) : undefined,
      },
      async (rel, text, language) => {
        const { additions } = scrubSource(text, { ...this.map, ...this.unsaved }, language)
        Object.assign(this.unsaved, additions)
        this.batch.push(rel)
      },
      (rel) => isRawOnly(join(this.root, rel), this.extraRawOnly)
    )
  }

  // ── project index (spec 050) ──────────────────────────────────────────────

  /** Indexes `paths` before `deadline` and saves what they add, in one write.
   *  Returns the paths it could not index. One batch at a time: the map's
   *  placeholders are numbered from what the last batch saved. */
  indexFiles(paths: readonly string[], deadline: number): Promise<string[]> {
    const run = this.indexing.then(() =>
      this.indexBatch(deadline, () => this.index!.index(paths, deadline))
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
  indexProject(deadline: number): Promise<string[]> {
    const run = this.indexing.then(() =>
      this.indexBatch(deadline, async () => {
        await this.index!.run(deadline)
        return []
      })
    )
    this.indexing = run.catch(() => undefined)
    return run
  }

  private async indexBatch(deadline: number, work: () => Promise<string[]>): Promise<string[]> {
    if (!this.index) return []
    // The listing gives the project's shape (what is external); a late one
    // only means fewer names are exempt, so the batch goes on without it.
    await bounded(this.index.start(), deadline, this.clock)
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      this.unsaved = {}
      this.batch = []
      const missed = await work()
      if (Object.keys(this.unsaved).length === 0) return missed
      const saved = await this.save(this.unsaved)
      this.unsaved = {}
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
    deadline: number
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
    const missed = exist.length ? await this.indexFiles(exist, deadline) : []
    // A path the guard could not find may be in a file it has not indexed yet
    // (a name with a space, a form it does not read): the index is finished
    // first, or the result waits.
    if (missing > 0 && this.index.state === 'indexing') await this.indexProject(deadline)
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
    if (Array.isArray(settings.mcpRestore)) {
      this.mcpRestore.push(...settings.mcpRestore.filter((p): p is string => typeof p === 'string'))
    }
    if (settings.enabled === false) this.state = 'off'
  }

  async reloadMap(): Promise<void> {
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

  stop(reason: string): void {
    this.state = 'stopped'
    this.stoppedReason = reason
  }

  async setEnabled(enabled: boolean): Promise<void> {
    // Merged into what the file holds, so the project's own lists survive.
    let settings: Record<string, unknown> = {}
    if (await this.io.exists(this.settingsPath)) {
      try {
        const parsed: unknown = JSON.parse(await this.io.read(this.settingsPath))
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
          settings = parsed as Record<string, unknown>
      } catch {
        // An unreadable file is replaced; readSettings stopped the guard on it.
      }
    }
    const changedAt = new Date().toISOString().slice(0, 10)
    await this.io.write(
      this.settingsPath,
      `${JSON.stringify({ ...settings, enabled, changedAt }, null, 2)}\n`
    )
    await this.ensureIgnored()
    this.state = enabled ? 'on' : 'off'
    if (enabled) {
      this.stoppedReason = ''
      await this.readSettings()
      await this.reloadMap()
    }
  }

  private async ensureIgnored(): Promise<void> {
    // The store holds the real names; it must never be committed.
    const ignore = join(this.root, '.veilio', '.gitignore')
    if (!(await this.io.exists(ignore))) await this.io.write(ignore, '*\n')
  }

  // ── text ──────────────────────────────────────────────────────────────────

  /** Prompts, reminders, output: known names replaced, credentials removed. */
  applyText(text: string, kind: MaskContext['kind'] = 'result', scan?: ScanResult): string {
    return applyMap(text, this.map, this.context('unknown', kind), { known: this.destroyed, scan })
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
  applyContext(text: string): string {
    const held = [MODEL_NOTE, ...this.produced].filter((h) => text.includes(h))
    if (held.length === 0 || text.includes('\u0000') || text.includes('\u0001'))
      return this.applyText(text)
    const mark = (i: number) => `\u0000${'\u0001'.repeat(i + 1)}\u0000`
    let marked = text
    held.forEach((h, i) => {
      marked = marked.split(h).join(mark(i))
    })
    let out = this.applyText(marked)
    held.forEach((h, i) => {
      const back =
        h === MODEL_NOTE ? h : applyMap(h, this.map, this.context('unknown'), { scanned: true })
      out = out.split(mark(i)).join(back)
    })
    return out
  }

  /** What masking knows about a text of `language` (spec 050). */
  context(language: MaskContext['language'], kind: MaskContext['kind'] = 'result'): MaskContext {
    if (!this.index) return { ...NO_CONTEXT, language, kind }
    return {
      language,
      kind,
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
    if (isRawOnly(path, this.extraRawOnly)) return true
    const real = await this.io.realPath(path)
    return real !== undefined && isRawOnly(real, this.extraRawOnly)
  }

  /** Before the tool runs: the raw-only check, then the arguments restored. */
  async beforeTool(e: ToolEvent): Promise<{ deny: string } | { args: ToolEvent }> {
    const policy = argumentPolicy(e.tool, this.mcpRestore)
    const unresolved = new Set<string>()
    const altered = new Set<string>()
    const restoreOne = (s: string) => {
      const r = restoreArgs(s, this.map)
      // Only tokens Veilio could have minted end in a number: __DEV__,
      // __FILE__ and __CLASS__ belong to the language and stay as written.
      r.unresolved.filter((p) => /\d$/.test(p)).forEach((p) => unresolved.add(p))
      r.altered.forEach((p) => altered.add(p))
      return r.text
    }

    let args: ToolEvent = e
    if (policy.restore.includes('*')) {
      const own: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(e)) if (!RESERVED.has(k)) own[k] = v
      args = { ...e, ...(deepRewrite(own, restoreOne) as Record<string, unknown>) }
    } else if (policy.restore.length > 0) {
      const r = rewriteFields(e, policy.restore, restoreOne)
      if (!r.ok) return this.deny(`its arguments are not in the expected form (${r.reason})`)
      args = r.value as ToolEvent
    }

    for (const field of policy.paths) {
      for (const p of [e[field], args[field]]) {
        if (typeof p === 'string' && (await this.rawOnlyHit(p))) {
          return this.deny(
            `Veilio keeps ${this.applyText(p)} away from the model. Ask the user for what you need from it`,
            false
          )
        }
      }
    }
    if (policy.command) {
      for (const c of [e[policy.command], args[policy.command]]) {
        if (typeof c !== 'string') continue
        for (const word of pathsInCommand(c)) {
          if (await this.rawOnlyHit(word)) {
            return this.deny(
              `Veilio keeps ${this.applyText(word)} away from the model. Ask the user for what you need from it`,
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
              `Veilio keeps ${this.applyText(s)} away from the model. Ask the user for what you need from it`,
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
          `the call writes ${[...redacted].join(', ')}, a credential Veilio removed. Writing it would ` +
            'replace the real value in the file. Leave that line as it is, or ask the user to change it'
        )
      }
    }

    if (writes && (unresolved.size > 0 || altered.size > 0)) {
      const names = [...unresolved, ...altered].join(', ')
      return this.deny(
        `the call names ${names}, which the project's map does not have` +
          (altered.size ? ' (a placeholder was changed: keep its exact spelling)' : '') +
          '. Read the file again and use the placeholders it shows' +
          viaEdit
      )
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
    indexed = false
  ): Promise<ToolOutcome> {
    if (!indexed) {
      const unchecked = await this.indexNamed(args, [raw], deadline)
      if (unchecked) return this.withhold(unchecked)
    }
    const ctx = this.context('unknown')
    const shaped = maskShaped(
      applyMap(raw, this.map, ctx, { known: this.destroyed }),
      this.map,
      ctx
    )
    if (
      Object.keys(shaped.additions).length > 0 &&
      (await this.save(shaped.additions)) === 'conflict'
    )
      return this.withhold(
        'another program changed .veilio/map.json while Veilio was writing to it'
      )
    const left = survivingSecrets(shaped.text, { ...this.map, ...shaped.additions })
    if (left.length > 0)
      return this.withhold(`a secret remained after masking (${[...new Set(left)].join(', ')})`)
    return { deny: shaped.text }
  }

  /** After the tool ran: the listed fields scrubbed, new names saved, then the secret re-scan. */
  async afterTool(
    tool: string,
    args: ToolEvent,
    received: { deny?: string; result?: unknown; text?: string; isError?: boolean },
    deadline = Date.now() + 6_000
  ): Promise<ToolOutcome> {
    let outcome = received
    // A denial reaches the model as text, like an error's: masked the same way.
    if (outcome.deny !== undefined) return this.maskMessage(outcome.deny, args, deadline)
    // Spec 050: the files this result names are indexed before it is masked,
    // so their names are in the map even if Claude never read them.
    const texts: string[] = []
    deepRewrite(outcome.isError ? (outcome.text ?? outcome.result ?? '') : outcome.result, (s) => {
      texts.push(s)
      return s
    })
    const unchecked = await this.indexNamed(args, texts, deadline)
    if (unchecked) return this.withhold(unchecked)
    // What any scan of this result destroys is removed from all of it, as
    // written, before anything is masked: no repeat of a credential on
    // another line, in another field or in a source's literal can reach the
    // map or the model (security reviews of 75fe4c0 and fe5078c). Learned
    // from what the model would be sent, after raw-only lines are dropped
    // (review of 99325ba). Enum fields are left for the last scan, which
    // withholds the result.
    const strip = (s: string) => redactKnown(s, this.destroyed)
    // An error's text never fits the tool's output schema, which Claude Code
    // checks a hook's `{ result }` against: it goes back as the error text the
    // model reads, masked.
    if (outcome.isError) {
      const raw = typeof outcome.text === 'string' ? outcome.text : String(outcome.result ?? '')
      this.destroyed.learn(destroyedValues([raw], this.map))
      return this.maskMessage(strip(raw), args, deadline, true)
    }
    const filePath = typeof args.file_path === 'string' ? args.file_path : ''
    outcome = { ...outcome, result: this.dropRawOnly(tool, outcome.result) }
    const policy = resultPolicy(tool, outcome.result, filePath)
    if (policy.kind === 'withhold') return this.withhold(policy.reason)
    const sent: string[] = []
    deepRewrite(outcome.result, (s) => {
      sent.push(s)
      return s
    })
    this.destroyed.learn(destroyedValues(sent, this.map))
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

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const working: SymbolMap = { ...this.map }
      const additions: SymbolMap = {}
      let value: unknown = outcome.result
      const ctx = this.context(this.resultLanguage(tool, args, filePath))
      // A Grep result mixes files: each line is masked in its own file's language.
      const perLine = (s: string, fn: (line: string, c: MaskContext) => string) =>
        tool === 'Grep'
          ? s
              .split('\n')
              .map((line) => fn(line, this.context(languageOfGrepLine(line))))
              .join('\n')
          : fn(s, ctx)
      // Swept already, above: each string is scanned once here.
      const apply = (s: string) =>
        perLine(s, (t, c) => applyMap(t, working, c, { known: this.destroyed, swept: true }))
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
            const scrubbed = scrubSource(s, working, languageOf(filePath), ctx.external)
            Object.assign(working, scrubbed.additions)
            Object.assign(additions, scrubbed.additions)
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
          const shaped = maskShaped(t, working, c)
          Object.assign(working, shaped.additions)
          Object.assign(additions, shaped.additions)
          return shaped.text
        })
      })

      if (Object.keys(additions).length > 0) {
        const saved = await this.save(additions)
        if (saved === 'conflict') continue
      }

      const left: string[] = []
      deepRewrite(value, (s) => {
        left.push(...survivingSecrets(s, working))
        return s
      })
      if (left.length > 0)
        return this.withhold(`a secret remained after masking (${[...new Set(left)].join(', ')})`)
      return { result: value }
    }
    return this.withhold(
      'another program kept changing .veilio/map.json while Veilio was writing to it'
    )
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
      // `path:12:text` for a match, `path-12-text` for a context line.
      out.content = record.content
        .split('\n')
        .filter((line) => {
          const colon = line.indexOf(':')
          const context = /^(.+?)-\d+-/.exec(line)
          return !((colon > 0 && raw(line.slice(0, colon))) || (context?.[1] && raw(context[1])))
        })
        .join('\n')
    }
    return out
  }

  /** Adds entries to the map file: read what is there now, merge, write. */
  private save(additions: SymbolMap): Promise<'saved' | 'conflict'> {
    const run = this.writes.then(async () => {
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
      // Everything this guard knows, not only the new entries: a writer that
      // dropped ours (two programs saving at once) gets them back.
      const { merged, conflicts } = mergeAdditions(onDisk.map, { ...this.stored.map, ...additions })
      if (conflicts.length > 0) {
        this.stored = onDisk
        return 'conflict' as const
      }
      const next: StoredMap = { ...onDisk, map: merged }
      await this.io.write(this.mapPath, serialiseMapFile(next))
      if (!existed) await this.ensureIgnored()
      this.stored = next
      return 'saved' as const
    })
    // A failed write must not wedge every later one.
    this.writes = run.catch(() => undefined)
    return run
  }
}
