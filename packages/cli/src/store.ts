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
import { createHash, randomBytes } from 'node:crypto'
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import {
  STORE_DIR,
  WRITTEN_RECORD_FILE,
  isName,
  parseWrittenRecord,
  writtenRecordValue,
  type SymbolMap,
} from '@veilio-inc/engine'
import { trackedPaths, type IndexUnreadable } from './git-index.js'

export { STORE_DIR }
export const STORE_FILE = 'map.json'

/** Walk up from `from` looking for an existing store or a repo root, so running
 *  the CLI in a subdirectory still finds the project's map. Falls back to
 *  `from` when neither is found. */
export function findProjectRoot(from: string): string {
  const start = resolve(from)
  let dir = start
  for (;;) {
    // Another user's .veilio is not this project's store (spec 085 L2): on a
    // shared machine anyone can make /tmp/.veilio.
    const store = join(dir, STORE_DIR)
    if (
      (existsSync(store) &&
        (ownerOf(store) !== 'other' || trustedStore(store)) &&
        withinProject(dir, start)) ||
      existsSync(join(dir, '.git'))
    )
      return dir
    const parent = dirname(dir)
    if (parent === dir) return resolve(from)
    dir = parent
  }
}

/**
 * Windows has no uid for the owner check (spec 085 R2-22): there a `.veilio`
 * is adopted only in the folder the CLI runs in or inside the git checkout
 * holding it, never one another user made higher up (`C:\\.veilio`).
 */
function withinProject(dir: string, start: string): boolean {
  if (process.platform !== 'win32' || dir === start) return true
  for (let d = dir; ; d = dirname(d)) {
    if (existsSync(join(d, '.git'))) return true
    if (dirname(d) === d) return false
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

// C0 and C1 controls and the Unicode line and paragraph separators: never
// shown in a message. What a name is, is the engine's `isName` (spec 085 R2-6).
const NOT_IN_A_NAME = /[\p{Cc}\u2028\u2029]/u

export { isName }

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
 * this spelling. A checkout whose index this reader cannot follow is refused
 * too (spec 085 R2-2): git there may track the map. Outside git the tracked
 * check cannot answer and the file is read as before.
 */
export function openStoreFile(what: string, path: string): string | null {
  const dir = dirname(path)
  refuseTracked(path)
  for (const p of [dir, path])
    if (isLink(p))
      throw new StoreRefusal(
        `refusing to read ${what}: ${p} is a link. The map is read only where it appears to be.`
      )
  refuseOthers(dir, path)
  if (!existsSync(path)) return null
  return readFileSync(path, 'utf8')
}

const REMEDY: Record<IndexUnreadable, string> = {
  split: 'git update-index --no-split-index',
  sparse: 'git sparse-checkout disable',
  format: 'git status',
}

/** Refuses a store file git tracks, or one in a checkout whose index cannot be read. */
function refuseTracked(path: string): void {
  const found = trackedStoreFile(path)
  if (found === null) return
  if ('unreadable' in found) {
    const kind = found.unreadable === 'format' ? 'an unknown format' : `${found.unreadable} index`
    throw new StoreRefusal(
      `refusing to use \`${shownPath(path)}\`: this checkout's git index is in a form veilio cannot read (\`${kind}\`), so it cannot tell whether git tracks the map. Run \`${REMEDY[found.unreadable]}\`, then run again.`
    )
  }
  const { root, tracked } = found
  // reserved.json and the like hold the account, team and rule bases, not a
  // map (spec 085 R2-16): said as what they are.
  // The path comes from the checkout: shown without control characters.
  const shown = shownPath(tracked)
  const how = rmCommand(root, tracked)
  if (tracked === relativeName(root, path) && !MAP_FILES.has(basename(path).toLowerCase()))
    throw new StoreRefusal(
      `refusing to write \`${shown}\`: it is tracked by git, and what veilio keeps there (account, team and rule data) must not be committed. Remove it from git${how}, then run again.`
    )
  throw new StoreRefusal(
    `\`${shown}\` is tracked by git: a map in the repository is not yours to restore from. ` +
      `Remove it from git${how}, then scrub again to build your own.`
  )
}

/**
 * The command that untracks `tracked`, as text to paste: only off Windows (its
 * shells read quotes differently) and only for a root and path of plain
 * characters, both single-quoted; otherwise nothing (security review: a
 * repository chooses the path, and `x;curl …|sh` would be a command).
 */
function rmCommand(root: string, tracked: string): string {
  const plain = /^[A-Za-z0-9._/ -]+$/
  return process.platform !== 'win32' && plain.test(root) && plain.test(tracked)
    ? ` (\`git -C ${shellQuote(root)} rm --cached -- ${shellQuote(tracked)}\`)`
    : ''
}

const MAP_FILES = new Set([STORE_FILE, 'aliases.json'])
const relativeName = (root: string, p: string): string => relative(root, p).split(sep).join('/')
// Format characters too (bidi overrides), as the guard's printable() (review).
const shownPath = (p: string): string => p.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, '')

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

const sudoWriteRefusal = (dir: string) =>
  new StoreRefusal(
    `refusing to write ${dir} as root: it belongs to the user who ran sudo, and a file root writes there would be root's. Run veilio without sudo.`
  )

/** The store directory and its file are this user's, or not used (spec 085 L2, Q2 = A). */
function refuseOthers(dir: string, path: string, write = false): void {
  const owners = [ownerOf(dir), ownerOf(path)]
  if (owners.includes('sudo') && write && !trustedStore(dir)) throw sudoWriteRefusal(dir)
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

/** The store path git tracks, as git names it, with its work tree root; why the
 *  index could not be read; or null when nothing is tracked, or there is no checkout. */
function trackedStoreFile(
  path: string
): { root: string; tracked: string } | { unreadable: IndexUnreadable } | null {
  const dir = dirname(path)
  const git = trackedPaths(dir)
  if (!git) return null
  if ('unreadable' in git) return { unreadable: git.unreadable }
  const rel = (p: string) => relativeName(git.root, p)
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

// A run that died holding the lock must not stop every later save: its lock
// is taken over once it is this old. A save holds it for milliseconds.
const LOCK_STALE_MS = 10_000

/**
 * Run `work` while holding `<path>.lock` (spec 093 item 6). The lock is a
 * file made with an exclusive create, so only one process has it; another
 * waits for it. Every writer of the map in this package saves through here.
 *
 * shortcut: two waiting runs that find a dead run's lock stale in the same
 * instant can both take it, and the guard plugin writes the map without it
 * (COVERAGE.md); name the holder in the lock if either is ever seen.
 */
function withStoreLock(path: string, work: () => void): void {
  const lock = `${path}.lock`
  const pause = new Int32Array(new SharedArrayBuffer(4))
  for (;;) {
    try {
      closeSync(openSync(lock, 'wx', 0o600))
      break
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
    let age: number
    try {
      age = Date.now() - lstatSync(lock).mtimeMs
    } catch {
      continue // released meanwhile
    }
    // A time in the future is no younger: the clock moved.
    if (Math.abs(age) > LOCK_STALE_MS) rmSync(lock, { recursive: true, force: true })
    else Atomics.wait(pause, 0, 0, 10)
  }
  try {
    work()
  } finally {
    rmSync(lock, { force: true })
  }
}

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
  // Judged before anything is written (spec 085 R2-3 review).
  const ours = storeIsOurs(path)
  const refuseLoss = (): void => {
    if (options.force || !existsSync(path)) return
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
  refuseLoss()
  prepareStoreWrite('the map', path)
  // Spec 093 item 6: checked again and written as one step. Two runs that both
  // passed the check above each wrote, and the one that wrote first had
  // printed placeholders the file then gave to the other's names.
  withStoreLock(path, () => {
    refuseLoss()
    // Carried forward when the caller does not supply one, so an ordinary `scrub`
    // does not quietly erase the provenance a `pull` recorded.
    const remote = options.remote ?? loadRemote(path)
    const payload: StoredMap = { version: 1, map, ...(remote ? { remote } : {}) }
    // A new 0600 file each time, so a world-readable map already there is replaced too.
    writeStoreFile('the map', path, `${JSON.stringify(payload, null, 2)}\n`)
  })
  recordWritten(path, ours)
}

/** `~/.veilio/written.json`, or null when it may not be used (a linked
 *  folder, or a folder or file another user owns). */
function writtenRecordPath(): string | null {
  const dir = join(homedir(), STORE_DIR)
  const file = join(dir, WRITTEN_RECORD_FILE)
  // A new file renamed over the record never writes through a link at it;
  // a linked folder would put the record elsewhere.
  if (isLink(dir) || ownerOf(dir) === 'other' || ownerOf(file) === 'other') return null
  return file
}

function readRecord(file: string): Record<string, string> {
  try {
    return parseWrittenRecord(readFileSync(file, 'utf8')) ?? {}
  } catch {
    return {}
  }
}

/** The record's value for what the store holds now: the map's and the
 *  aliases file's hashes (an absent file hashes as the empty text). */
function storeValue(mapPath: string): string {
  const hash = (p: string) => {
    let text = ''
    try {
      text = readFileSync(p, 'utf8')
    } catch {
      // absent: hashed as the empty text
    }
    return createHash('sha256').update(text).digest('hex')
  }
  return writtenRecordValue(hash(mapPath), hash(join(dirname(mapPath), 'aliases.json')))
}

const EMPTY_STORE = writtenRecordValue(
  createHash('sha256').update('').digest('hex'),
  createHash('sha256').update('').digest('hex')
)

/**
 * Whether the store holds what Veilio last recorded writing, or nothing yet
 * (spec 085 R2-3, review): only then may a write be recorded. Otherwise the
 * map came with the files, or was changed since, and a write that merges it
 * must not launder it into "written by Veilio".
 */
export function storeIsOurs(mapPath: string): boolean {
  const store = dirname(mapPath)
  if (basename(store) !== STORE_DIR || basename(mapPath) !== STORE_FILE) return false
  try {
    const now = storeValue(mapPath)
    if (now === EMPTY_STORE) return true
    const file = writtenRecordPath()
    if (file === null) return false
    // Unrecorded and not empty: not ours until `veilio maps adopt` (founder,
    // 2026-11-09). No read, scrub or MCP call adopts it.
    return readRecord(file)[realpathSync(dirname(store))] === now
  } catch {
    return false
  }
}

/**
 * Trusts the map already in this project as one this machine wrote (founder,
 * 2026-11-09): what `veilio maps adopt` does, after the person saw what it
 * holds. The read refuses a map git tracks, or a checkout whose index cannot
 * be read. Throws when the record cannot be written; nothing is adopted then.
 */
export function adoptStore(mapPath: string): void {
  if (basename(mapPath) !== STORE_FILE || basename(dirname(mapPath)) !== STORE_DIR)
    throw new StoreRefusal(`only a project's ${STORE_DIR}/${STORE_FILE} can be adopted`)
  loadMap(mapPath)
  recordWritten(mapPath, true)
  const file = writtenRecordPath()
  if (
    file === null ||
    readRecord(file)[realpathSync(dirname(dirname(mapPath)))] !== storeValue(mapPath)
  )
    throw new StoreRefusal(
      `could not record the map in ~/${STORE_DIR}/${WRITTEN_RECORD_FILE}, so nothing was adopted.`
    )
}

/**
 * Records, in `~/.veilio/written.json`, the hashes of the map and aliases this
 * project's store now holds (spec 085 R2-3), when `ours` - the store held what
 * Veilio last recorded, or nothing, before this write (storeIsOurs). The guard
 * restores unseen only from a recorded map. Any failure is skipped: the map is
 * written, and without a record the guard asks for each name to be shown first.
 */
export function recordWritten(mapPath: string, ours: boolean): void {
  if (!ours) return
  try {
    const file = writtenRecordPath()
    if (file === null) return
    const dir = dirname(file)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    if (writtenRecordPath() === null) return
    const record = readRecord(file)
    record[realpathSync(dirname(dirname(mapPath)))] = storeValue(mapPath)
    const tmp = join(dir, `.${WRITTEN_RECORD_FILE}.${randomBytes(6).toString('hex')}.tmp`)
    const fd = openSync(tmp, 'wx', 0o600)
    try {
      writeSync(fd, `${JSON.stringify(record, null, 2)}\n`)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, file)
  } catch {
    // not recorded: the guard shows-gates this map, the safe side
  }
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
  // Under sudo, in a project the invoking user owns, root would make a store
  // that user cannot use (review round 2): refused before anything is made.
  if (ownerOf(dirname(dir)) === 'sudo' && !trustedStore(dir)) throw sudoWriteRefusal(dir)
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
  // Every store file, not only the map (spec 085 R2-16): git must not track it.
  refuseTracked(path)
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
