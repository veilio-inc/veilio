// Guard decision 1 (spec 050 amendment R7): which entries of Claude Code's
// skill and agent listings are public, and so go to the model as written.
//
// An entry is public when the engine says where it comes from and that place
// is public: Claude Code itself, or a plugin installed in the plugin cache
// whose cached file holds the same words. The project's and the user's own
// skills and agents, MCP skills, --plugin-dir and synced plugins, and anything
// the guard cannot place are not. Provenance is never read from the text.

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

/** Each installed plugin (`<name>@<marketplace>`) and its install paths that
 *  lie inside the plugin cache. Unreadable or malformed: none. */
export async function installedInCache(
  io: ListingIO,
  configDir: string | undefined
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  if (!configDir) return out
  const cache = `${configDir}/plugins/cache/`
  let parsed: unknown
  try {
    parsed = JSON.parse(await io.read(`${configDir}/plugins/installed_plugins.json`))
  } catch {
    return out
  }
  const plugins = (parsed as { plugins?: unknown })?.plugins
  if (!plugins || typeof plugins !== 'object') return out
  for (const [key, installs] of Object.entries(plugins as Record<string, unknown>)) {
    const at = key.lastIndexOf('@')
    if (at <= 0 || !PART.test(key.slice(0, at)) || !Array.isArray(installs)) continue
    const paths = installs
      .map((i) => (i as { installPath?: unknown })?.installPath)
      .filter((p): p is string => typeof p === 'string')
      .map(slashes)
      .filter((p) => p.startsWith(cache) && !p.split('/').some((s) => s === '..' || s === '.'))
    if (paths.length > 0) out.set(key, paths)
  }
  return out
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

function rootsOf(installed: Map<string, string[]>, plugin: string): string[] {
  const out: string[] = []
  for (const [key, paths] of installed)
    if (key.slice(0, key.lastIndexOf('@')) === plugin) out.push(...paths)
  return out
}

/** The entries of a listing that may go as written: `- <name>: <description>`
 *  exactly as the engine reports them, and `- <name>` alone. */
export async function publicEntries(
  kind: 'skills' | 'agents',
  given: { commands?: readonly CommandRow[]; offers?: readonly AgentOffer[] },
  installed: Map<string, string[]>,
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
    const roots = installed.get(provider)
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
