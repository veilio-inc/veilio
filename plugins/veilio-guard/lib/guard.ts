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
import { argumentPolicy, resultPolicy } from './policy.ts'
import { applyMap, restoreArgs, scrubSource, survivingSecrets } from './scrub.ts'
import { restore } from '../vendor/engine/index.js'

export interface GuardIO {
  read(path: string): Promise<string>
  write(path: string, text: string): Promise<void>
  exists(path: string): Promise<boolean>
  /** Where a path really leads (symbolic links followed), or undefined. */
  realPath(path: string): Promise<string | undefined>
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
  private writes: Promise<unknown> = Promise.resolve()

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
  applyText(text: string): string {
    return applyMap(text, this.map)
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

    // A redaction token written to a file would replace the real credential
    // for good: refused, so the line is edited by a person.
    if (policy.mode === 'strict') {
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

    if (policy.mode === 'strict' && (unresolved.size > 0 || altered.size > 0)) {
      const names = [...unresolved, ...altered].join(', ')
      return this.deny(
        `the call names ${names}, which the project's map does not have` +
          (altered.size ? ' (a placeholder was changed: keep its exact spelling)' : '') +
          '. Read the file again and use the placeholders it shows'
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
    received: { deny?: string; result?: unknown; isError?: boolean }
  ): Promise<ToolOutcome> {
    let outcome = received
    if (outcome.deny !== undefined) return { deny: this.applyText(outcome.deny) }
    const filePath = typeof args.file_path === 'string' ? args.file_path : ''
    outcome = { ...outcome, result: this.dropRawOnly(tool, outcome.result) }
    const policy = resultPolicy(tool, outcome.result, filePath)
    if (policy.kind === 'withhold') return this.withhold(policy.reason)

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const working: SymbolMap = { ...this.map }
      const additions: SymbolMap = {}
      let value: unknown = outcome.result
      if (policy.kind === 'text') value = applyMap(value as string, working)
      else if (policy.kind === 'deep') value = deepRewrite(value, (s) => applyMap(s, working))
      else {
        for (const field of policy.fields) {
          const r = rewriteFields(value, [field.path], (s) => {
            if (field.mode === 'apply') return applyMap(s, working)
            const scrubbed = scrubSource(s, working)
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
        // The fields the list does not name: known names replaced too.
        // Applying the map twice to a listed field changes nothing.
        value = deepRewrite(value, (s) => applyMap(s, working), new Set(policy.keep))
      }

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
      return outcome.isError ? { result: value, isError: true } : { result: value }
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
