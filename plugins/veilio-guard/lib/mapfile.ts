// The project's symbol map, .veilio/map.json, in the format the CLI and the
// MCP server use (packages/cli/src/store.ts). The guard shares the file with
// them and with other sessions, so it reads what is on disk now, adds only its
// own new entries, and treats a placeholder that would mean two names as a
// conflict to resolve by masking again - never by overwriting.

export type SymbolMap = Record<string, string>
export type StoredMap = {
  version: 1
  map: SymbolMap
  remote?: { id: string; updatedAt: string; pulledAt?: string; pushedAt?: string }
}

export type Parsed = { ok: true; stored: StoredMap } | { ok: false; reason: string }

export function parseMapFile(text: string): Parsed {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'it is not valid JSON' }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'it is not a map file' }
  }
  const { version, map, remote } = parsed as Record<string, unknown>
  if (version !== 1)
    return { ok: false, reason: `its version is ${JSON.stringify(version)}, not 1` }
  if (typeof map !== 'object' || map === null || Array.isArray(map)) {
    return { ok: false, reason: 'it has no map' }
  }
  if (!Object.values(map).every((v) => typeof v === 'string')) {
    return { ok: false, reason: 'a map entry is not text' }
  }
  const stored: StoredMap = { version: 1, map: map as SymbolMap }
  if (remote && typeof remote === 'object') stored.remote = remote as StoredMap['remote']
  return { ok: true, stored }
}

export function mergeAdditions(
  onDisk: SymbolMap,
  additions: SymbolMap
): { merged: SymbolMap; conflicts: string[] } {
  const merged: SymbolMap = { ...onDisk }
  const byName = new Map(Object.entries(onDisk).map(([p, v]) => [v, p]))
  const conflicts: string[] = []
  for (const [placeholder, name] of Object.entries(additions)) {
    const there = onDisk[placeholder]
    if (there === name) continue
    const other = byName.get(name)
    if (there !== undefined || (other !== undefined && other !== placeholder)) {
      conflicts.push(placeholder)
      continue
    }
    merged[placeholder] = name
    byName.set(name, placeholder)
  }
  return { merged, conflicts }
}

export function serialiseMapFile(stored: StoredMap): string {
  const payload: StoredMap = {
    version: 1,
    map: stored.map,
    ...(stored.remote ? { remote: stored.remote } : {}),
  }
  return `${JSON.stringify(payload, null, 2)}\n`
}
