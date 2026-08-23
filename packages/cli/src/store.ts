// Symbol-map persistence.
//
// The map is what makes the round trip work: scrub writes it, restore reads it.
// It lives in the project, not a global cache, because placeholder numbering is
// only meaningful within one codebase — sharing `__CLS__1` across unrelated
// projects would collide names and restore the wrong identifiers.
//
// The map holds real identifier names, so it is written 0600 and the store
// directory carries a .gitignore. Committing it would undo the anonymization
// for anyone reading the repo.

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { STORE_DIR, type SymbolMap } from '@veilio-inc/engine'

export { STORE_DIR }
export const STORE_FILE = 'map.json'

/** Walk up from `from` looking for an existing store or a repo root, so running
 *  the CLI in a subdirectory still finds the project's map. Falls back to
 *  `from` when neither is found. */
export function findProjectRoot(from: string): string {
  let dir = resolve(from)
  for (;;) {
    if (existsSync(join(dir, STORE_DIR)) || existsSync(join(dir, '.git'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return resolve(from)
    dir = parent
  }
}

/** Resolve the map file path: explicit override, else the project store. */
export function resolveMapPath(override: string | null, cwd: string): string {
  if (override !== null) return resolve(cwd, override)
  return join(findProjectRoot(cwd), STORE_DIR, STORE_FILE)
}

export interface StoredMap {
  map: SymbolMap
  /** Schema marker so a future format change can be detected rather than
   *  silently misread as a map. */
  version: 1
}

function isSymbolMap(value: unknown): value is SymbolMap {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  return Object.values(value).every((v) => typeof v === 'string')
}

/** Read the stored map, or an empty map when there is none. Throws only when a
 *  file exists but cannot be understood — silently starting from empty there
 *  would orphan every placeholder the user already has in flight. */
export function loadMap(path: string): SymbolMap {
  if (!existsSync(path)) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new Error(`map file at ${path} is not valid JSON`)
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`map file at ${path} is malformed`)
  }
  const map = (parsed as { map?: unknown }).map
  if (!isSymbolMap(map)) {
    throw new Error(`map file at ${path} is malformed`)
  }
  return map
}

export function saveMap(path: string, map: SymbolMap): void {
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true })
  // A store directory inside a repo must never be committed — it holds the real
  // names the anonymization exists to hide.
  const ignore = join(dir, '.gitignore')
  if (dir.endsWith(STORE_DIR) && !existsSync(ignore)) {
    writeFileSync(ignore, '*\n', { mode: 0o600 })
  }
  const payload: StoredMap = { version: 1, map }
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 })
  // writeFileSync only applies `mode` when creating the file; enforce it on
  // rewrite too so a pre-existing world-readable map gets locked down.
  chmodSync(path, 0o600)
}

export function clearMap(path: string): boolean {
  if (!existsSync(path)) return false
  rmSync(path)
  return true
}
