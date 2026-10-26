// Guard decision 1 (spec 050 amendment R7): which entries of Claude Code's
// skill and agent listings are public, and so go to the model as written.
//
// An entry is public when the engine says where it comes from and that place
// is public: Claude Code itself, or a plugin installed in the plugin cache
// from a public marketplace, whose cached file holds the same words. A
// marketplace is public when it is an official Anthropic one recorded with
// Anthropic's own repository as its source, or one the user names in the
// guard's settings, by its exact name, that Claude Code knows. The project's
// and the user's own skills and agents, MCP skills, --plugin-dir and synced
// plugins, private marketplaces, and anything the guard cannot place are not.
// Provenance is never read from the text.

/** The attachment types that are listings, and what each lists. */
export const LISTING_TYPES: Readonly<Record<string, 'skills' | 'agents'>> = {
  skill_listing: 'skills',
  agent_listing_delta: 'agents',
}

/** One row of `$.command.list()`: skills are commands to the engine. */
export type CommandRow = {
  name: string
  description: string
  source: string
  plugin?: string | null
}

/** What `agent.offer` reports for one agent type. */
export type AgentOffer = {
  agent: string
  description: string
  source: string
  provider?: { plugin?: string; tier?: string }
}

export interface ListingIO {
  /** A file's text; rejects when it cannot be read. */
  read(path: string): Promise<string>
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

/** The official Anthropic marketplaces, by the name Claude Code records, and
 *  the GitHub repository each must be recorded as coming from (research R7:
 *  the curated list and reserved names in Claude Code 2.1.310, and
 *  known_marketplaces.json). A marketplace that takes an official name from
 *  anywhere else is not public. */
export const OFFICIAL_MARKETPLACES: Readonly<Record<string, string>> = {
  'claude-plugins-official': 'anthropics/claude-plugins-official',
}

/** The installed plugins: every `<name>@<marketplace>` key, and the install
 *  paths in the plugin cache of those whose marketplace is public. */
export type Installed = { keys: readonly string[]; public: Map<string, string[]> }

const NONE: Installed = { keys: [], public: new Map() }

async function readJson(io: ListingIO, path: string): Promise<Record<string, unknown> | null> {
  try {
    const v: unknown = JSON.parse(await io.read(path))
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** Whether a marketplace is public: official and recorded from its own
 *  repository, or named exactly in `named` and known to Claude Code. */
export function publicMarketplace(
  name: string,
  known: Record<string, unknown>,
  named: readonly string[]
): boolean {
  if (!Object.hasOwn(known, name)) return false
  const record = known[name] as { source?: { source?: unknown; repo?: unknown } } | undefined
  if (Object.hasOwn(OFFICIAL_MARKETPLACES, name)) {
    const source = record?.source
    return (
      source?.source === 'github' &&
      typeof source.repo === 'string' &&
      source.repo.toLowerCase() === OFFICIAL_MARKETPLACES[name]
    )
  }
  return PART.test(name) && named.includes(name)
}

/** The installed plugins, from installed_plugins.json and the marketplaces'
 *  sources in known_marketplaces.json. Either unreadable: none is public. */
export async function installedInCache(
  io: ListingIO,
  configDir: string | undefined,
  named: readonly string[] = []
): Promise<Installed> {
  if (!configDir) return NONE
  const cache = `${configDir}/plugins/cache/`
  const installed = await readJson(io, `${configDir}/plugins/installed_plugins.json`)
  const known = await readJson(io, `${configDir}/plugins/known_marketplaces.json`)
  const plugins = installed?.plugins
  if (!known || !plugins || typeof plugins !== 'object') return NONE
  const keys: string[] = []
  const out = new Map<string, string[]>()
  for (const [key, installs] of Object.entries(plugins as Record<string, unknown>)) {
    keys.push(key)
    const at = key.lastIndexOf('@')
    if (at <= 0 || !PART.test(key.slice(0, at)) || !Array.isArray(installs)) continue
    if (!publicMarketplace(key.slice(at + 1), known, named)) continue
    const paths = installs
      .map((i) => (i as { installPath?: unknown })?.installPath)
      .filter((p): p is string => typeof p === 'string')
      .map(slashes)
      .filter((p) => p.startsWith(cache) && !p.split('/').some((s) => s === '..' || s === '.'))
    if (paths.length > 0) out.set(key, paths)
  }
  return { keys, public: out }
}

/** Words in order, whitespace folded as YAML folds a long description. */
function fold(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** Whether one of the cached copies has a file for this skill or agent that
 *  holds the description's words in order. */
async function cachedHolds(
  io: ListingIO,
  roots: readonly string[],
  files: readonly string[],
  description: string
): Promise<boolean> {
  const want = fold(description)
  if (want.length === 0) return false
  for (const root of roots) {
    for (const file of files) {
      try {
        if (fold(await io.read(`${root}/${file}`)).includes(want)) return true
      } catch {
        // No such file in this copy: try the next.
      }
    }
  }
  return false
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

/** The entries of a listing that may go as written: `- <name>: <description>`
 *  exactly as the engine reports them, and `- <name>` alone. */
export async function publicEntries(
  kind: 'skills' | 'agents',
  given: { commands?: readonly CommandRow[]; offers?: readonly AgentOffer[] },
  installed: Installed,
  io: ListingIO
): Promise<string[]> {
  const out: string[] = []
  const add = (name: string, description: string) => {
    out.push(`- ${name}`)
    if (description.length > 0) out.push(`- ${name}: ${description}`)
  }
  if (kind === 'skills') {
    for (const c of given.commands ?? []) {
      if (typeof c?.name !== 'string' || typeof c.description !== 'string') continue
      if (c.source === 'builtin') {
        add(c.name, c.description)
        continue
      }
      if (c.source !== 'plugin' || typeof c.plugin !== 'string') continue
      const part = ownPart(c.name, c.plugin)
      if (!part) continue
      const files = [`skills/${part}/SKILL.md`, `commands/${part}.md`]
      if (await cachedHolds(io, rootsOf(installed, c.plugin), files, c.description))
        add(c.name, c.description)
    }
    return out
  }
  for (const o of given.offers ?? []) {
    if (typeof o?.agent !== 'string' || typeof o.description !== 'string') continue
    const provider = o.provider?.plugin
    if (o.source === 'built-in' && provider === 'engine' && o.provider?.tier === 'core') {
      add(o.agent, o.description)
      continue
    }
    if (o.source !== 'plugin' || typeof provider !== 'string') continue
    const roots = installed.public.get(provider)
    if (!roots) continue
    const part = ownPart(o.agent, provider.slice(0, provider.lastIndexOf('@')))
    if (!part) continue
    if (await cachedHolds(io, roots, [`agents/${part}.md`], o.description))
      add(o.agent, o.description)
  }
  return out
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
