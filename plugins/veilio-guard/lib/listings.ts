// Guard decision 1 (spec 050 amendment R7): which entries of Claude Code's
// skill and agent listings are public, and so go to the model as written.
//
// An entry is public when the engine says where it comes from and that place
// is public: Claude Code itself, or a plugin installed in the plugin cache
// from a public marketplace, whose cached file declares the same description
// (as YAML reads it). A marketplace is public when its name and the source
// Claude Code records for it match the official Anthropic one, or one the
// user pins in the guard's settings (`<name>=<source>`). The project's
// and the user's own skills and agents, MCP skills, --plugin-dir and synced
// plugins, private marketplaces, and anything the guard cannot place are not.
// Provenance is never read from the text.

import type { AgentOfferInput } from './host.ts'
import { frontmatterDescription } from './frontmatter.ts'

/** The attachment types that are listings, and what each lists. */
const LISTING_TYPES: Readonly<Record<string, 'skills' | 'agents'>> = {
  skill_listing: 'skills',
  agent_listing_delta: 'agents',
}

/** What a `prompt.attachment` type lists, if it is a listing: by the table's
 *  own keys only, so `constructor` or `toString` is no listing (code review
 *  of d705b14). */
export function listingKind(type: string): 'skills' | 'agents' | undefined {
  return Object.hasOwn(LISTING_TYPES, type) ? LISTING_TYPES[type] : undefined
}

/** One row of `$.command.list()`: skills are commands to the engine. */
export type CommandRow = {
  name: string
  description: string
  source: string
  plugin?: string | null
}

/** The rows of `$.command.list()` that have the shape the listing rule
 *  reads; anything else is dropped, so it can only mask. */
export function commandRows(value: unknown): CommandRow[] {
  if (!Array.isArray(value)) return []
  return value.filter(
    (r): r is CommandRow =>
      !!r &&
      typeof r === 'object' &&
      typeof (r as CommandRow).name === 'string' &&
      typeof (r as CommandRow).description === 'string' &&
      typeof (r as CommandRow).source === 'string'
  )
}

export interface ListingIO {
  /** A file's text; rejects when it cannot be read. */
  read(path: string): Promise<string>
  /** A file's modification time, or undefined when it cannot be had: the
   *  file is then read again each time. */
  mtime(path: string): Promise<number | undefined>
}

/** Claude Code's configuration directory: CLAUDE_CONFIG_DIR, or .claude in
 *  the home directory. Undefined when neither is known: no plugin passes. */
export function configDirOf(env: {
  CLAUDE_CONFIG_DIR?: string
  HOME?: string
  USERPROFILE?: string
}): string | undefined {
  const dir = env.CLAUDE_CONFIG_DIR?.trim()
  if (dir) return slashes(dir)
  const home = (env.HOME ?? env.USERPROFILE)?.trim()
  return home ? `${slashes(home)}/.claude` : undefined
}

function slashes(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '')
}

// A plugin's own part of a name: no path separators, no dot segments.
const PART = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/

/** A marketplace that counts as public, by its name and the source Claude
 *  Code records for it (`github:<owner>/<repo>`, `git:<url>`, `url:<url>`,
 *  `directory:<path>`). Both must match exactly. */
export type PublicMarketplace = { readonly name: string; readonly source: string }

/** The official Anthropic marketplace, pinned to its repository (research
 *  R7: the curated list in Claude Code 2.1.310, and known_marketplaces.json).
 *  One that takes its name from anywhere else is not public. */
export const OFFICIAL_MARKETPLACES: readonly PublicMarketplace[] = [
  { name: 'claude-plugins-official', source: 'github:anthropics/claude-plugins-official' },
]

/** The user's `publicMarketplaces` setting: each entry `<name>=<source>`
 *  (or `{ name, source }`). An entry that does not pin a source, a name or a
 *  source that is not plain, is ignored, and returned to be said. */
export function parsePublicMarketplaces(entries: readonly unknown[]): {
  pinned: PublicMarketplace[]
  ignored: string[]
} {
  const pinned: PublicMarketplace[] = []
  const ignored: string[] = []
  for (const entry of entries) {
    let name: unknown
    let source: unknown
    if (typeof entry === 'string') {
      const at = entry.indexOf('=')
      if (at > 0) {
        name = entry.slice(0, at).trim()
        source = entry.slice(at + 1).trim()
      } else name = entry
    } else if (entry && typeof entry === 'object') {
      ;({ name, source } = entry as { name?: unknown; source?: unknown })
    }
    if (
      typeof name === 'string' &&
      PART.test(name) &&
      typeof source === 'string' &&
      /^(github|git|url|directory):\S+$/.test(source)
    )
      pinned.push({ name, source })
    else ignored.push(typeof entry === 'string' ? entry : JSON.stringify(entry))
  }
  return { pinned, ignored }
}

/** The source Claude Code records for a marketplace, in PublicMarketplace's
 *  words; undefined for a record of any other shape. */
export function recordedSource(record: unknown): string | undefined {
  const source = (record as { source?: Record<string, unknown> } | undefined)?.source
  if (!source || typeof source !== 'object') return undefined
  const kind = source.source
  const where =
    kind === 'github'
      ? source.repo
      : kind === 'git' || kind === 'url'
        ? source.url
        : kind === 'directory'
          ? source.path
          : undefined
  return typeof kind === 'string' && typeof where === 'string' ? `${kind}:${where}` : undefined
}

/** The installed plugins: every `<name>@<marketplace>` key, and the install
 *  paths in the plugin cache of those whose marketplace is public. */
export type Installed = { keys: readonly string[]; public: Map<string, string[]> }

const NONE: Installed = { keys: [], public: new Map() }

/** Whether a marketplace is public: an official one or one the user pinned,
 *  whose name and recorded source both match. */
export function publicMarketplace(
  name: string,
  known: Record<string, unknown>,
  pinned: readonly PublicMarketplace[]
): boolean {
  if (!Object.hasOwn(known, name)) return false
  const source = recordedSource(known[name])
  if (source === undefined) return false
  return [...OFFICIAL_MARKETPLACES, ...pinned].some((m) => m.name === name && m.source === source)
}

/** What was read of the plugin cache this session, by file and mtime, so a
 *  listing round reads only what changed (code review of d705b14). */
export class ListingCache {
  private installed: { key: string; value: Installed } | null = null
  private files = new Map<string, { mtime: number; description: string | undefined | null }>()

  /** A cached file's frontmatter description; null when it cannot be read. */
  async description(io: ListingIO, path: string): Promise<string | undefined | null> {
    const mtime = await io.mtime(path).catch(() => undefined)
    const hit = this.files.get(path)
    if (mtime !== undefined && hit && hit.mtime === mtime) return hit.description
    let description: string | undefined | null
    try {
      description = frontmatterDescription(await io.read(path))
    } catch {
      description = null
    }
    if (mtime !== undefined) this.files.set(path, { mtime, description })
    return description
  }

  async installedInCache(
    io: ListingIO,
    configDir: string | undefined,
    pinned: readonly PublicMarketplace[]
  ): Promise<Installed> {
    if (!configDir) return NONE
    const files = [
      `${configDir}/plugins/installed_plugins.json`,
      `${configDir}/plugins/known_marketplaces.json`,
    ]
    const mtimes = await Promise.all(files.map((f) => io.mtime(f).catch(() => undefined)))
    const key = mtimes.every((m) => m !== undefined)
      ? JSON.stringify([configDir, mtimes, pinned])
      : null
    if (key !== null && this.installed?.key === key) return this.installed.value
    const value = await installedInCache(io, configDir, pinned)
    if (key !== null) this.installed = { key, value }
    return value
  }
}

async function readJson(io: ListingIO, path: string): Promise<Record<string, unknown> | null> {
  try {
    const v: unknown = JSON.parse(await io.read(path))
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** The installed plugins, from installed_plugins.json and the marketplaces'
 *  sources in known_marketplaces.json. Either unreadable: none is public. */
export async function installedInCache(
  io: ListingIO,
  configDir: string | undefined,
  pinned: readonly PublicMarketplace[] = []
): Promise<Installed> {
  if (!configDir) return NONE
  const cache = `${configDir}/plugins/cache/`
  const [installed, known] = await Promise.all([
    readJson(io, `${configDir}/plugins/installed_plugins.json`),
    readJson(io, `${configDir}/plugins/known_marketplaces.json`),
  ])
  const plugins = installed?.plugins
  if (!known || !plugins || typeof plugins !== 'object') return NONE
  const keys: string[] = []
  const out = new Map<string, string[]>()
  for (const [key, installs] of Object.entries(plugins as Record<string, unknown>)) {
    keys.push(key)
    const at = key.lastIndexOf('@')
    if (at <= 0 || !PART.test(key.slice(0, at)) || !Array.isArray(installs)) continue
    if (!publicMarketplace(key.slice(at + 1), known, pinned)) continue
    const paths = installs
      .map((i) => (i as { installPath?: unknown })?.installPath)
      .filter((p): p is string => typeof p === 'string')
      .map(slashes)
      .filter((p) => p.startsWith(cache) && !p.split('/').some((s) => s === '..' || s === '.'))
    if (paths.length > 0) out.set(key, paths)
  }
  return { keys, public: out }
}

/** What the cached copies say of a skill or agent: whether one has its file,
 *  and whether one's frontmatter declares exactly this description, as YAML
 *  reads it (code review of d705b14: never a search of the file's text). */
async function cachedEntry(
  io: ListingIO,
  cache: ListingCache,
  roots: readonly string[],
  files: readonly string[],
  description: string
): Promise<{ exists: boolean; declared: boolean }> {
  let exists = false
  const want = description.trim()
  for (const root of roots) {
    for (const file of files) {
      const found = await cache.description(io, `${root}/${file}`)
      if (found === null) continue
      exists = true
      if (want !== '' && found !== undefined && found.trim() === want)
        return { exists, declared: true }
    }
  }
  return { exists, declared: false }
}

/** A plugin's own part of `<plugin>:<name>`, or null. */
function ownPart(name: string, plugin: string): string | null {
  if (!PART.test(plugin) || !name.startsWith(`${plugin}:`)) return null
  const part = name.slice(plugin.length + 1)
  return PART.test(part) ? part : null
}

/** The cached copies of the one installed plugin named `plugin`, when its
 *  full `<name>@<marketplace>` key is public. A name installed from more
 *  than one marketplace is ambiguous: Claude Code names a skill's plugin
 *  without its marketplace, so none of them is used. */
function rootsOf(installed: Installed, plugin: string): string[] {
  const keys = installed.keys.filter((k) => k.slice(0, k.lastIndexOf('@')) === plugin)
  return keys.length === 1 ? (installed.public.get(keys[0]!) ?? []) : []
}

/** The entries of a listing that may go as written: `- <name>` once the
 *  provenance is public (for a plugin, once its file is in the cache), and
 *  `- <name>: <description>` when the description is the declared one. */
export async function publicEntries(
  kind: 'skills' | 'agents',
  given: { commands?: readonly CommandRow[]; offers?: readonly AgentOfferInput[] },
  installed: Installed,
  io: ListingIO,
  cache: ListingCache = new ListingCache()
): Promise<string[]> {
  const entry = (name: string, description: string, declared: boolean) =>
    declared && description.length > 0 ? [`- ${name}`, `- ${name}: ${description}`] : [`- ${name}`]
  const plugin = async (
    name: string,
    description: string,
    roots: readonly string[],
    files: readonly string[]
  ) => {
    const found = await cachedEntry(io, cache, roots, files, description)
    return found.exists ? entry(name, description, found.declared) : []
  }
  const each =
    kind === 'skills'
      ? (given.commands ?? []).map(async (c) => {
          if (c.source === 'builtin') return entry(c.name, c.description, true)
          if (c.source !== 'plugin' || typeof c.plugin !== 'string') return []
          const part = ownPart(c.name, c.plugin)
          if (!part) return []
          const files = [`skills/${part}/SKILL.md`, `commands/${part}.md`]
          return plugin(c.name, c.description, rootsOf(installed, c.plugin), files)
        })
      : (given.offers ?? []).map(async (o) => {
          if (typeof o.agent !== 'string' || typeof o.description !== 'string') return []
          const provider = o.provider?.plugin
          if (o.source === 'built-in' && provider === 'engine' && o.provider?.tier === 'core')
            return entry(o.agent, o.description, true)
          if (o.source !== 'plugin' || typeof provider !== 'string') return []
          const roots = installed.public.get(provider)
          const part = ownPart(o.agent, provider.slice(0, provider.lastIndexOf('@')))
          if (!roots || !part) return []
          return plugin(o.agent, o.description, roots, [`agents/${part}.md`])
        })
  return (await Promise.all(each)).flat()
}

/** Where in `text` each public entry stands as a whole entry: at the start of
 *  a line, and followed by the end, a newline, or an agent's ` (Tools: `.
 *  The longest entry at a place wins; spans never overlap. */
export function wholeEntries(
  text: string,
  entries: readonly string[]
): { at: number; entry: string }[] {
  const byLength = [...new Set(entries)].sort((a, b) => b.length - a.length)
  const ends = (end: number) =>
    end === text.length || text[end] === '\n' || text.startsWith(' (Tools: ', end)
  const out: { at: number; entry: string }[] = []
  let at = 0
  while (at < text.length) {
    const entry = byLength.find((e) => text.startsWith(e, at) && ends(at + e.length))
    if (entry) out.push({ at, entry })
    const from = entry ? at + entry.length : at
    const nl = text.indexOf('\n', from)
    if (nl === -1) break
    at = nl + 1
  }
  return out
}
