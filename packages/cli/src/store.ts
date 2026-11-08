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

import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { randomBytes } from 'node:crypto'
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { STORE_DIR, type SymbolMap } from '@veilio-inc/engine'
import { trackedPaths } from './git-index.js'

export { STORE_DIR }
export const STORE_FILE = 'map.json'

/** Walk up from `from` looking for an existing store or a repo root, so running
 *  the CLI in a subdirectory still finds the project's map. Falls back to
 *  `from` when neither is found. */
export function findProjectRoot(from: string): string {
  let dir = resolve(from)
  for (;;) {
    // Another user's .veilio is not this project's store (spec 085 L2): on a
    // shared machine anyone can make /tmp/.veilio.
    const store = join(dir, STORE_DIR)
    if (
      (existsSync(store) && (ownerOf(store) !== 'other' || trustedStore(store))) ||
      existsSync(join(dir, '.git'))
    )
      return dir
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
  /**
   * Where this map came from in Cloud, if it came from Cloud.
   *
   * Present only for a map that was pulled or pushed. Its whole purpose is to
   * make divergence DETECTABLE: without it, `pull` cannot tell "this is the map
   * I pulled and have not touched" from "this is a different map with the same
   * name", and the only safe behaviour left would be to overwrite or to refuse
   * always. Neither is the answer — the contract says a conflict is reported.
   */
  remote?: {
    id: string
    /** Cloud's `updated_at` at the moment we pulled. */
    updatedAt: string
    pulledAt?: string
    pushedAt?: string
  }
}

/** The longest real name kept, as for aliases.json (reservations.ts). */
const MAX_NAME = 100_000

// C0 and C1 controls (line feed, tab, NEL, escape, ...) and the Unicode line
// and paragraph separators. A map value is not always an identifier (a manual
// mark can be words with spaces, spec 082 adds non-ASCII letters), so no exact
// name pattern exists; a character that breaks a line or drives a terminal is
// never part of a name.
const NOT_IN_A_NAME = /[\p{Cc}\u2028\u2029]/u

/** What a map or aliases.json may restore: 1 to 100000 characters, none of them a control or line separator. */
export function isName(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_NAME && !NOT_IN_A_NAME.test(v)
}

function isSymbolMap(value: unknown): value is SymbolMap {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  return Object.values(value).every(isName)
}

/**
 * Refuses to write a value the store would not read back (review round 1):
 * a map with one would be refused whole on its next read. Refused, not
 * dropped, so a pull never quietly loses a teammate's entry.
 */
export function refuseNonNames(what: string, map: SymbolMap): void {
  const bad = Object.keys(map).find((k) => !isName(map[k]))
  if (bad !== undefined)
    throw new StoreRefusal(
      `refusing to write ${what}: the value of ${bad.replace(new RegExp(NOT_IN_A_NAME.source, 'gu'), '').slice(0, 60)} is not a name (1 to 100000 characters, no control character or line break), so nothing was written.`
    )
}

/** A store the CLI will not use: exit 1 in the CLI, a tool error in the MCP server. */
export class StoreRefusal extends Error {}

/**
 * The one way a store file (map.json, aliases.json, reserved.json) is read
 * (spec 085 R1): its text, or null when there is none. Refused, whatever the
 * file: when `.veilio/` or the file is a link (a cloned repository can commit
 * one to another project's map), and when git tracks `.veilio`, map.json or
 * aliases.json (a map in the repository is not yours to restore from). Git is
 * asked first, so a tracked map is refused even where the file is absent under
 * this spelling. Outside git, or with an index this reader cannot follow, the
 * tracked check cannot answer and the file is read as before.
 */
export function openStoreFile(what: string, path: string): string | null {
  const dir = dirname(path)
  const found = trackedStoreFile(path)
  if (found !== null) {
    const { root, tracked } = found
    // The path comes from the checkout: shown without control characters. A
    // command only off Windows (its shells read quotes differently) and only
    // for a root and path of plain characters; both single-quoted.
    const shown = tracked.replace(new RegExp(NOT_IN_A_NAME.source, 'gu'), '')
    const plain = /^[A-Za-z0-9._/ -]+$/
    const how =
      process.platform !== 'win32' && plain.test(root) && plain.test(tracked)
        ? ` (\`git -C ${shellQuote(root)} rm --cached -- ${shellQuote(tracked)}\`)`
        : ''
    throw new StoreRefusal(
      `\`${shown}\` is tracked by git: a map in the repository is not yours to restore from. ` +
        `Remove it from git${how}, then scrub again to build your own.`
    )
  }
  for (const p of [dir, path])
    if (isLink(p))
      throw new StoreRefusal(
        `refusing to read ${what}: ${p} is a link. The map is read only where it appears to be.`
      )
  refuseOthers(dir, path)
  if (!existsSync(path)) return null
  return readFileSync(path, 'utf8')
}

/**
 * Whose `path` is: 'me' for the running user, 'other' for anyone else, 'none'
 * when it is not there. Windows (no uid): always 'me'. Under sudo (root, with
 * SUDO_UID), a file of the user who ran sudo is 'sudo': readable, not writable
 * (security review: a file root writes there would be root's).
 */
function ownerOf(path: string): 'me' | 'sudo' | 'other' | 'none' {
  const me = process.getuid?.()
  let uid: number
  try {
    uid = lstatSync(path).uid
  } catch {
    return 'none'
  }
  if (me === undefined || uid === me) return 'me'
  return me === 0 && process.env.SUDO_UID === String(uid) ? 'sudo' : 'other'
}

/**
 * The stores VEILIO_TRUST_STORE_OWNER lists (absolute paths, separated as in
 * PATH), by real path, as git's safe.directory: each one exactly, no other.
 */
function trustedStore(dir: string): boolean {
  const listed = (process.env.VEILIO_TRUST_STORE_OWNER ?? '').split(delimiter).filter(isAbsolute)
  if (listed.length === 0) return false
  const real = (p: string) => {
    try {
      return realpathSync(p)
    } catch {
      return resolve(p)
    }
  }
  const here = real(dir)
  return listed.some((p) => real(p) === here)
}

/** The store directory and its file are this user's, or not used (spec 085 L2, Q2 = A). */
function refuseOthers(dir: string, path: string, write = false): void {
  const owners = [ownerOf(dir), ownerOf(path)]
  if (owners.includes('sudo') && write && !trustedStore(dir))
    throw new StoreRefusal(
      `refusing to write ${dir} as root: it belongs to the user who ran sudo, and a file root writes there would be root's. Run veilio without sudo.`
    )
  if (owners.includes('other') && !trustedStore(dir))
    throw new StoreRefusal(
      `refusing to use ${dir}: it belongs to another user on this machine. Run veilio inside your own project, or remove that directory. If you trust it, add its full path to VEILIO_TRUST_STORE_OWNER.`
    )
}

/**
 * Write a store file as a new file beside it, then rename it into place
 * (spec 085 L2): never written through the file already there, which may be
 * another name for a file elsewhere (a hard link) or another user's.
 */
export function writeStoreFile(what: string, path: string, text: string): void {
  checkStoreWrite(what, path)
  const tmp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`)
  const fd = openSync(tmp, 'wx', 0o600)
  try {
    try {
      writeSync(fd, text)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, path)
  } catch (err) {
    rmSync(tmp, { force: true })
    throw err
  }
}

/** One POSIX shell word, for a string of plain characters (no quote in it). */
const shellQuote = (s: string): string => `'${s}'`

/** The store path git tracks, as git names it, with its work tree root; null when none, or no way to tell. */
function trackedStoreFile(path: string): { root: string; tracked: string } | null {
  const dir = dirname(path)
  const git = trackedPaths(dir)
  if (!git) return null
  const rel = (p: string) => relative(git.root, p).split(sep).join('/')
  const candidates = [path]
  if (basename(dir) === STORE_DIR)
    candidates.unshift(dir, join(dir, STORE_FILE), join(dir, 'aliases.json'))
  for (const p of candidates) {
    const name = rel(p)
    if (name && !name.startsWith('..') && git.paths.has(name.toLowerCase()))
      return { root: git.root, tracked: name }
  }
  return null
}

/**
 * The Cloud provenance recorded alongside the local map, if any.
 *
 * Separate from `loadMap` because every existing caller wants the map and
 * nothing else, and because a store written before this existed simply has no
 * `remote` — which reads correctly as "this map did not come from Cloud".
 */
export function loadRemote(path: string): StoredMap['remote'] | undefined {
  const text = openStoreFile('the map', path)
  if (text === null) return undefined
  try {
    const parsed = JSON.parse(text) as { remote?: StoredMap['remote'] }
    const remote = parsed.remote
    if (!remote || typeof remote.id !== 'string' || typeof remote.updatedAt !== 'string') {
      return undefined
    }
    return remote
  } catch {
    return undefined
  }
}

/** Read the stored map, or an empty map when there is none. Throws only when a
 *  file exists but cannot be understood — silently starting from empty there
 *  would orphan every placeholder the user already has in flight. */
export function loadMap(path: string): SymbolMap {
  const text = openStoreFile('the map', path)
  if (text === null) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
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

export class MapOverwriteError extends Error {}

/**
 * Write the map, refusing a write that would lose entries already on disk.
 *
 * Not a guard on every write. `scrub` loads the existing map, hands it to
 * `anonymize` as `existingMap` and saves the union, so the normal path only ever
 * grows the file — demanding a flag for that would mean typing `--force` on
 * every second command, which is how a safety prompt becomes muscle memory and
 * stops being read.
 *
 * What it refuses is the write that actually destroys something: one whose map
 * no longer explains a placeholder the file already had. That map is the only
 * means of restoring output produced with it, and once the entry is gone the
 * text that used it can never be read back. Reachable by pointing `--map` at
 * another session's store, or by a future caller that forgets to load first.
 */
export function saveMap(
  path: string,
  map: SymbolMap,
  options: { force?: boolean; remote?: StoredMap['remote'] } = {}
): void {
  refuseNonNames('the map', map)
  if (!options.force && existsSync(path)) {
    const dropped = Object.entries(loadMap(path)).filter(
      ([placeholder, real]) => map[placeholder] !== real
    )
    if (dropped.length > 0) {
      const shown = dropped
        .slice(0, 3)
        .map(([p]) => p)
        .join(', ')
      throw new MapOverwriteError(
        `refusing to overwrite ${path}: ${dropped.length} existing placeholder${dropped.length === 1 ? '' : 's'} ` +
          `(${shown}${dropped.length > 3 ? ', …' : ''}) would be lost, and text already anonymized with them ` +
          `could never be restored. Pass --force to overwrite anyway.`
      )
    }
  }
  prepareStoreWrite('the map', path)
  // Carried forward when the caller does not supply one, so an ordinary `scrub`
  // does not quietly erase the provenance a `pull` recorded.
  const remote = options.remote ?? loadRemote(path)
  const payload: StoredMap = { version: 1, map, ...(remote ? { remote } : {}) }
  // A new 0600 file each time, so a world-readable map already there is replaced too.
  writeStoreFile('the map', path, `${JSON.stringify(payload, null, 2)}\n`)
}

/**
 * Everything that must hold before a store file is written: neither the store
 * directory nor the file is a link (security audit 2026-11-01: a link a
 * repository committed would put the real names outside the project), and a
 * `.veilio` directory carries a `.gitignore` that keeps it out of git. One
 * there already must be a plain file whose only pattern is `*` (spec 085 L4: a
 * repository can commit its own, which ignores nothing); a missing one is
 * written. It is never rewritten: it may be tracked, and a silent change to a
 * tracked file is worse than a refusal.
 */
export function prepareStoreWrite(what: string, path: string): void {
  const dir = dirname(path)
  checkStoreWrite(what, path)
  // Made 0700 and not recursively, so a directory already there is checked
  // again rather than taken: another user may have swapped it in meanwhile.
  mkdirSync(dirname(dir), { recursive: true })
  try {
    mkdirSync(dir, { mode: 0o700 })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
  }
  checkStoreWrite(what, path)
  if (basename(dir) !== STORE_DIR) return
  const ignore = join(dir, '.gitignore')
  let st
  try {
    st = lstatSync(ignore)
  } catch {
    // None there: written, and never through a link planted after the check.
    writeFileSync(ignore, '*\n', { mode: 0o600, flag: 'wx' })
    return
  }
  if (!st.isFile() || !onlyStar(readFileSync(ignore, 'utf8')))
    throw new StoreRefusal(
      `refusing to write ${what}: ${dir}/.gitignore does not keep it out of git (it must be a plain file whose only pattern is \`*\`). Fix that file, then run again.`
    )
}

/**
 * The store directory is a real directory and neither it nor the file is a
 * link or another user's. Run before mkdir, after it, and again right before
 * the rename (security review). Node has no openat, so a window remains
 * between the last check and the rename; the 0700 directory bounds it.
 */
function checkStoreWrite(what: string, path: string): void {
  const dir = dirname(path)
  refuseLinks(what, dir, path)
  let st
  try {
    st = lstatSync(dir)
  } catch {
    st = null // not made yet
  }
  if (st && !st.isDirectory())
    throw new StoreRefusal(`refusing to write ${what}: ${dir} is not a directory`)
  refuseOthers(dir, path, true)
}

/**
 * A .gitignore whose only pattern is `*` (security review): `*` then
 * `!map.json` would let git track the map, and the CLI cannot ask git which
 * files it ignores. Blank lines and `#` comments are allowed. No trimming:
 * git keeps leading spaces and a trailing tab (`  *`, `*\t` match nothing), so
 * only a line that is exactly `*` (CRLF accepted) counts.
 */
function onlyStar(text: string): boolean {
  const patterns = text.split(/\r?\n/).filter((l) => l !== '' && !l.startsWith('#'))
  return patterns.length > 0 && patterns.every((l) => l === '*')
}

/** Throws when any of `paths` is a link: the store's files are written only
 *  where they appear to be (security audit 2026-11-01). */
export function refuseLinks(what: string, ...paths: string[]): void {
  for (const p of paths)
    if (isLink(p)) throw new StoreRefusal(`refusing to write ${what}: ${p} is a link`)
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false // not there yet
  }
}

export function clearMap(path: string): boolean {
  if (!existsSync(path)) return false
  rmSync(path)
  return true
}
