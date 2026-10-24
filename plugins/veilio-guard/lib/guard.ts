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
import { deepRewrite, rewriteFields } from './fields.ts'
import {
  mergeAdditions,
  parseMapFile,
  serialiseMapFile,
  type StoredMap,
  type SymbolMap,
} from './mapfile.ts'
import { isRawOnly, pathsInCommand } from './paths.ts'
import { ProjectIndex } from './index.ts'
import {
  argumentPolicy,
  isSourcePath,
  languageOf,
  languageOfCommand,
  resultPolicy,
} from './policy.ts'
import {
  applyMap,
  maskShaped,
  NO_CONTEXT,
  restoreArgs,
  scrubSource,
  survivingSecrets,
} from './scrub.ts'
import type { MaskContext } from './scrub.ts'
import { restore } from '../vendor/engine/index.js'

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
      },
      async (_rel, text, language) => {
        const { additions } = scrubSource(text, { ...this.map, ...this.unsaved }, language)
        Object.assign(this.unsaved, additions)
        this.batch.push(_rel)
      },
      (rel) => isRawOnly(join(this.root, rel), this.extraRawOnly)
    )
  }

  // ── project index (spec 050) ──────────────────────────────────────────────

  /** Indexes `paths` before `deadline` and saves what they add, in one write.
   *  Returns the paths it could not index. One batch at a time: the map's
   *  placeholders are numbered from what the last batch saved. */
  indexFiles(paths: readonly string[], deadline: number): Promise<string[]> {
    const run = this.indexing.then(() => this.indexBatch(() => this.index!.index(paths, deadline)))
    this.indexing = run.catch(() => undefined)
    return run
  }

  /** Continues through the project's files not indexed yet, until `deadline`. */
  indexProject(deadline: number): Promise<string[]> {
    const run = this.indexing.then(() =>
      this.indexBatch(async () => {
        await this.index!.run(deadline)
        return []
      })
    )
    this.indexing = run.catch(() => undefined)
    return run
  }

  private async indexBatch(work: () => Promise<string[]>): Promise<string[]> {
    if (!this.index) return []
    await this.index.start()
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
   *  prints. Paths outside the project, or not source, are left out. */
  private namedSources(args: ToolEvent, texts: string[]): string[] {
    const found = new Set<string>()
    const consider = (raw: string) => {
      let p = raw.replace(/^['"(]+|['"),:]+$/g, '').replace(/:\d+(?::\d+)?$/, '')
      if (p.startsWith(`${this.root}/`)) p = p.slice(this.root.length + 1)
      p = p.replace(/^\.\//, '')
      if (!p || p.startsWith('/') || p.startsWith('..') || !isSourcePath(p)) return
      found.add(this.index?.resolve(p) ?? p)
    }
    for (const text of texts)
      for (const m of text.matchAll(
        /(?:^|[\s('"`=])((?:\.{0,2}\/|\/)?[\w@.$-]+(?:\/[\w@.$-]+)*\.[A-Za-z0-9]+)(?=$|[\s:)'"`,])/gm
      ))
        consider(m[1]!)
    if (typeof args.command === 'string') {
      const one = languageOfCommand(args.command)
      if (one !== 'unknown') for (const word of pathsInCommand(args.command)) consider(word)
    }
    return [...found]
  }

  /** Index what a result names, and say why not when it cannot. */
  private async indexNamed(
    args: ToolEvent,
    texts: string[],
    deadline: number
  ): Promise<string | null> {
    if (!this.index) return null
    const named = this.namedSources(args, texts)
    if (named.length === 0) return null
    const exist = []
    for (const rel of named) if (await this.io.exists(join(this.root, rel))) exist.push(rel)
    const missed = await this.indexFiles(exist, deadline)
    if (missed.length === 0) return null
    const unread = missed.filter((rel) => this.index!.failed.has(rel))
    const list = (xs: string[]) =>
      xs.slice(0, 3).join(', ') + (xs.length > 3 ? ` and ${xs.length - 3} more` : '')
    return unread.length
      ? `it names ${list(unread)}, which Veilio could not read to check`
      : `Veilio is still indexing the project and has not checked ${list(missed)} yet`
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
  applyText(text: string, kind: MaskContext['kind'] = 'result'): string {
    return applyMap(text, this.map, this.context('unknown', kind))
  }

  /** What masking knows about a text of `language` (spec 050). */
  context(language: MaskContext['language'], kind: MaskContext['kind'] = 'result'): MaskContext {
    return { ...NO_CONTEXT, language, kind }
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

  /** After the tool ran: the listed fields scrubbed, new names saved, then the secret re-scan. */
  async afterTool(
    tool: string,
    args: ToolEvent,
    received: { deny?: string; result?: unknown; text?: string; isError?: boolean },
    deadline = Date.now() + 6_000
  ): Promise<ToolOutcome> {
    let outcome = received
    if (outcome.deny !== undefined) return { deny: this.applyText(outcome.deny) }
    // Spec 050: the files this result names are indexed before it is masked,
    // so their names are in the map even if Claude never read them.
    const texts: string[] = []
    deepRewrite(outcome.isError ? (outcome.text ?? outcome.result ?? '') : outcome.result, (s) => {
      texts.push(s)
      return s
    })
    const unchecked = await this.indexNamed(args, texts, deadline)
    if (unchecked) return this.withhold(unchecked)
    // An error's text never fits the tool's output schema, which Claude Code
    // checks a hook's `{ result }` against: it goes back as the error text the
    // model reads, masked.
    if (outcome.isError) {
      const raw = typeof outcome.text === 'string' ? outcome.text : String(outcome.result ?? '')
      const ctx = this.context('unknown')
      const shaped = maskShaped(applyMap(raw, this.map, ctx), this.map, ctx)
      if (
        Object.keys(shaped.additions).length > 0 &&
        (await this.save(shaped.additions)) === 'conflict'
      )
        return this.withhold(
          'another program changed .veilio/map.json while Veilio was writing to it'
        )
      const text = shaped.text
      const left = survivingSecrets(text)
      if (left.length > 0)
        return this.withhold(`a secret remained after masking (${[...new Set(left)].join(', ')})`)
      return { deny: text }
    }
    const filePath = typeof args.file_path === 'string' ? args.file_path : ''
    outcome = { ...outcome, result: this.dropRawOnly(tool, outcome.result) }
    const policy = resultPolicy(tool, outcome.result, filePath)
    if (policy.kind === 'withhold') return this.withhold(policy.reason)

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const working: SymbolMap = { ...this.map }
      const additions: SymbolMap = {}
      let value: unknown = outcome.result
      const ctx = this.context('unknown')
      if (policy.kind === 'text') value = applyMap(value as string, working, ctx)
      else if (policy.kind === 'deep') value = deepRewrite(value, (s) => applyMap(s, working, ctx))
      else {
        for (const field of policy.fields) {
          const r = rewriteFields(value, [field.path], (s) => {
            if (field.mode === 'apply') return applyMap(s, working, ctx)
            const scrubbed = scrubSource(s, working, languageOf(filePath))
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
        value = deepRewrite(value, (s) => applyMap(s, working, ctx), new Set(policy.keep))
      }
      // A name shaped like an identifier that is still here - in a file the
      // index has not reached - is masked and added (spec 050 R1).
      const keep = policy.kind === 'fields' ? new Set(policy.keep) : undefined
      // In a record, a string that is one bare token is a field's value - a
      // status, an enum (`async_launched`) - and Claude Code refuses a record
      // whose enum changed. The index and the map still cover a declared name
      // there; only the shape fallback skips it.
      const record = policy.kind !== 'text'
      value = deepRewrite(
        value,
        (s) => {
          if (record && /^[\w$.-]+$/.test(s)) return s
          const shaped = maskShaped(s, working, ctx)
          Object.assign(working, shaped.additions)
          Object.assign(additions, shaped.additions)
          return shaped.text
        },
        keep
      )

      if (Object.keys(additions).length > 0) {
        const saved = await this.save(additions)
        if (saved === 'conflict') continue
      }

      const left: string[] = []
      deepRewrite(value, (s) => {
        left.push(...survivingSecrets(s))
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
