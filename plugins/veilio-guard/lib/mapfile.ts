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

const ROLE = /^__(?:CLS|FN|PKG|VAR|STR)__\d+$/

export function mergeAdditions(
  onDisk: SymbolMap,
  additions: SymbolMap
): { merged: SymbolMap; conflicts: string[] } {
  const merged: SymbolMap = { ...onDisk }
  // A name's non-role placeholder wins the lookup, so a second rule
  // placeholder for it is still a clash whatever the key order.
  const entries = Object.entries(onDisk)
  const byName = new Map(
    [...entries.filter(([p]) => ROLE.test(p)), ...entries.filter(([p]) => !ROLE.test(p))].map(
      ([p, v]) => [v, p]
    )
  )
  const conflicts: string[] = []
  for (const [placeholder, name] of Object.entries(additions)) {
    const there = onDisk[placeholder]
    if (there === name) continue
    const other = byName.get(name)
    // Spec 064/065: a custom rule's placeholder for a name the engine once
    // gave a role placeholder (an ordinary word, now readable) is the engine's
    // own behaviour, not a clash: the old entry stays, so old text restores.
    const ruleOverEngine = other !== undefined && ROLE.test(other) && !ROLE.test(placeholder)
    if (there !== undefined || (other !== undefined && other !== placeholder && !ruleOverEngine)) {
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

// Spec 063: this member's blocks of the team's placeholder numbers, written by
// the CLI or the MCP server (`veilio maps pull`, `veilio team unlock`) to
// .veilio/reserved.json beside the map. The guard only reads it, and numbers
// new names inside a block offline; it never asks for numbers itself.

export type Block = { start: number; end: number }
export type Reserved = { ok: true; blocks: Record<string, Block> } | { ok: false; reason: string }

const BASE = /^__[A-Z][A-Z0-9_]*__$/

export function parseReservedFile(text: string): Reserved {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'it is not valid JSON' }
  }
  const r = parsed as { version?: unknown; blocks?: unknown }
  if (r?.version !== 1)
    return { ok: false, reason: `its version is ${JSON.stringify(r?.version)}, not 1` }
  if (typeof r.blocks !== 'object' || r.blocks === null || Array.isArray(r.blocks))
    return { ok: false, reason: 'it has no blocks' }
  const blocks: Record<string, Block> = {}
  for (const [base, b] of Object.entries(r.blocks as Record<string, Partial<Block>>)) {
    // Quoted and cut short: a planted file's key must not put control
    // characters into the band (security review, 2026-10-30).
    if (!BASE.test(base))
      return { ok: false, reason: `${JSON.stringify(base).slice(0, 40)} is not a placeholder kind` }
    if (
      !Number.isInteger(b?.start) ||
      !Number.isInteger(b?.end) ||
      b!.start! < 1 ||
      b!.end! < b!.start!
    )
      return { ok: false, reason: `the ${base} block is not a run of whole numbers` }
    blocks[base] = { start: b!.start!, end: b!.end! }
  }
  return { ok: true, blocks }
}
