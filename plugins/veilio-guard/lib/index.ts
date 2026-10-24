// The project's tracked source files, indexed so that a result is masked by
// what it contains (spec 050 R1). Before this, a result was masked only
// against names already in the map, and the map grew only through Read: a
// session that ran the tests and searched sent every name as written.
//
// Each file is read once. Its imports and declarations are collected (what the
// project takes from outside, and what is its own), then the guard scrubs it
// into the map through `onFile`. The guard hands every call a deadline: a file
// it cannot read, or cannot reach in time, comes back so the result that named
// it can be withheld rather than sent.
import { externalNames, parseDeclarations } from '../vendor/engine/index.js'
import type { Language, ProjectShape } from '../vendor/engine/index.js'
import { isSourcePath, languageOf } from './policy.ts'

export type IndexIO = {
  /** The project's tracked files, relative to its root; null when it cannot list them. */
  list: () => Promise<string[] | null>
  read: (rel: string) => Promise<string>
  now: () => number
}

export type FileIndexed = (
  rel: string,
  text: string,
  language: Language | 'auto',
  external: Set<string>
) => Promise<void>

export type IndexState = 'new' | 'indexing' | 'complete' | 'unavailable'

// A parsed JSON file, read field by field with optional chaining.
type Json = { [key: string]: Json } | undefined

// Read at most this many package.json files for workspace names.
const MAX_MANIFESTS = 200

export class ProjectIndex {
  state: IndexState = 'new'
  reason = ''
  pending: string[] = []
  total = 0
  readonly indexed = new Set<string>()
  readonly failed = new Map<string, string>()
  readonly languages = new Set<Language>()
  readonly declared = new Set<string>()
  private readonly imported = new Set<string>()
  private shape: ProjectShape = {}
  private tracked: string[] = []
  private starting: Promise<void> | null = null

  constructor(
    private readonly io: IndexIO,
    private readonly onFile: FileIndexed,
    private readonly skip: (rel: string) => boolean = () => false
  ) {}

  /** What the project takes from outside, less every name it declares
   *  anywhere: a word imported in one file and declared in another is the
   *  project's (spec 050 data-model, Exemptions rule 1). */
  get external(): Set<string> {
    return new Set([...this.imported].filter((name) => !this.declared.has(name)))
  }

  /** Lists the project once; later calls wait for the first. */
  start(): Promise<void> {
    this.starting ??= this.list()
    return this.starting
  }

  private async list(): Promise<void> {
    let files: string[] | null
    try {
      files = await this.io.list()
    } catch (err) {
      files = null
      this.reason = String(err instanceof Error ? err.message : err)
    }
    if (!files) {
      this.state = 'unavailable'
      this.reason ||= 'the project could not be listed'
      return
    }
    this.tracked = files
    this.shape = await this.readShape(files)
    this.pending = files.filter((f) => isSourcePath(f) && !this.skip(f))
    this.total = this.pending.length
    this.state = this.pending.length ? 'indexing' : 'complete'
  }

  private async readShape(files: string[]): Promise<ProjectShape> {
    const tops = new Set(files.filter((f) => f.includes('/')).map((f) => f.split('/')[0]!))
    const pythonModules = new Set(tops)
    for (const f of files) {
      if (/^[^/]+\.py$/.test(f)) pythonModules.add(f.replace(/\.py$/, ''))
      const underSrc = /^src\/([^/]+)\//.exec(f)
      if (underSrc) pythonModules.add(underSrc[1]!)
    }
    const workspaces: string[] = []
    for (const manifest of files
      .filter((f) => /(^|\/)package\.json$/.test(f))
      .slice(0, MAX_MANIFESTS)) {
      const name = await this.readJson(manifest, (j) => j?.name)
      if (typeof name === 'string') workspaces.push(name)
    }
    const pathAliases: string[] = []
    for (const config of files.filter((f) => /^tsconfig[^/]*\.json$/.test(f))) {
      const paths = await this.readJson(config, (j) => j?.compilerOptions?.paths)
      if (paths && typeof paths === 'object')
        for (const key of Object.keys(paths)) {
          const prefix = key.replace(/\*.*$/, '')
          if (prefix) pathAliases.push(prefix)
        }
    }
    let goModule: string | undefined
    if (files.includes('go.mod')) {
      const text = await this.io.read('go.mod').catch(() => '')
      goModule = /^module\s+(\S+)/m.exec(text)?.[1]
    }
    return {
      baseDirs: [...tops],
      pythonModules: [...pythonModules],
      workspaces,
      pathAliases,
      goModule,
    }
  }

  // tsconfig allows comments and trailing commas; this reads the common case
  // and gives up quietly on the rest, which only leaves more names masked.
  private async readJson(rel: string, pick: (j: Json) => unknown): Promise<unknown> {
    try {
      const text = (await this.io.read(rel))
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
        .replace(/,(\s*[}\]])/g, '$1')
      return pick(JSON.parse(text))
    } catch {
      return undefined
    }
  }

  /** Indexes `paths` (relative to the root) that are not indexed yet, until
   *  `deadline`. Returns the ones it could not index: unreadable, or not
   *  reached in time. */
  async index(paths: readonly string[], deadline: number): Promise<string[]> {
    const missed: string[] = []
    for (const rel of new Set(paths)) {
      if (this.indexed.has(rel)) continue
      if (this.io.now() >= deadline) {
        missed.push(rel)
        continue
      }
      if (!(await this.indexOne(rel))) missed.push(rel)
    }
    this.settle()
    return missed
  }

  /** Continues through the files not indexed yet, until `deadline`. */
  async run(deadline: number): Promise<void> {
    await this.start()
    while (this.pending.length && this.io.now() < deadline) {
      const rel = this.pending[0]!
      if (!this.indexed.has(rel)) await this.indexOne(rel)
      this.pending.shift()
    }
    this.settle()
  }

  /** Marks `rel` as not indexed, so it is indexed again: its map entries were
   *  not saved. What it declared and imported is kept; that only masks more. */
  forget(rel: string): void {
    if (this.indexed.delete(rel) && !this.pending.includes(rel)) this.pending.unshift(rel)
    if (this.state === 'complete') this.state = 'indexing'
  }

  /** A path as the project lists it. Output printed from a subdirectory
   *  (`cd packages/engine && npx vitest`) names `tests/a.test.ts`; when exactly
   *  one tracked file ends that way, that is the one. */
  resolve(path: string): string {
    if (this.tracked.length === 0 || this.tracked.includes(path)) return path
    const matches = this.tracked.filter((f) => f.endsWith(`/${path}`))
    return matches.length === 1 ? matches[0]! : path
  }

  private async indexOne(rel: string): Promise<boolean> {
    let text: string
    try {
      text = await this.io.read(rel)
    } catch (err) {
      this.failed.set(rel, String(err instanceof Error ? err.message : err))
      return false
    }
    const language = languageOf(rel)
    let external = new Set<string>()
    if (language !== 'auto') {
      this.languages.add(language)
      for (const name of parseDeclarations(text, language)) this.declared.add(name)
      external = externalNames(text, language, this.shape)
      for (const name of external) this.imported.add(name)
    }
    await this.onFile(rel, text, language, external)
    this.indexed.add(rel)
    this.failed.delete(rel)
    return true
  }

  private settle(): void {
    this.pending = this.pending.filter((rel) => !this.indexed.has(rel))
    if (this.state === 'indexing' && this.pending.length === 0) this.state = 'complete'
  }
}
