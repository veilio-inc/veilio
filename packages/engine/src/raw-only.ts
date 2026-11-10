// Files a model must never read (guard spec 033 FR-004; spec 078 FR-016).
//
// One list for every tool that reads files on an agent's behalf: the Claude
// Code guard refuses them before a tool runs, and the MCP server refuses to
// read them. A project adds patterns; it cannot remove these.

export const DEFAULT_RAW_ONLY: readonly string[] = [
  '.env',
  '.env.*',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  'id_rsa*',
  'id_dsa*',
  'id_ecdsa*',
  'id_ed25519*',
  '.veilio/**',
  '.npmrc',
  '.netrc',
  '.pgpass',
  // Credential stores and keystores.
  '.git-credentials',
  '.htpasswd',
  '*.jks',
  '*.keystore',
  '*.p8',
  'kubeconfig',
  '.docker/config.json',
  // Cloud and cluster credentials, where their tools keep them.
  '.kube/config',
  '.kube/**',
  '.aws/credentials',
  '.azure/**',
  '.config/gcloud/**',
]

// Matched ignoring case: NTFS and APFS, the default file systems on Windows and
// macOS, open `.ENV` as `.env`. On a case-sensitive one this refuses a little
// more than it must, which is the side to err on.
function globToRegExp(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob.charAt(i)
    if (c === '*' && glob[i + 1] === '*') {
      re += '.*'
      i++
      if (glob[i + 1] === '/') i++
    } else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`, 'i')
}

function matches(path: string, pattern: string): boolean {
  const re = globToRegExp(pattern)
  // NTFS opens `.env::$DATA`, `.env:x` and `.env.` as `.env`: a segment is
  // read without its stream and trailing dots or spaces (spec 078 review).
  const parts = path
    .split('/')
    .map((p) => (p === '..' ? p : p.replace(/:.*$/, '').replace(/[. ]+$/, '')))
    .filter((p) => p !== '' && p !== '.')
  // A pattern with no slash matches a file name anywhere; one with a slash
  // matches any tail of the path, so `secrets/**` holds at any depth.
  if (!pattern.includes('/')) return parts.some((p) => re.test(p))
  for (let i = 0; i < parts.length; i++) if (re.test(parts.slice(i).join('/'))) return true
  return false
}

/** A path no name match can judge on Windows: a segment holding a stream
 *  (`a:b`, past a drive letter) or shaped like an 8.3 short name (`ENV~1`),
 *  which may stand for any long name. Callers that read files refuse it. */
export function windowsAlias(path: string): boolean {
  return (
    SHORT_NAME(path) ||
    path.split(/[\\/]/).some((seg, i) => seg.includes(':') && !(i === 0 && /^[A-Za-z]:$/.test(seg)))
  )
}

const SHORT_NAME = (path: string) =>
  path.split(/[\\/]/).some((seg) => /^[^~]{1,6}~\d+(\.[^.]*)?$/.test(seg))

const onWindows = () =>
  (globalThis as { process?: { platform?: string } }).process?.platform === 'win32'

/** A segment shaped like an 8.3 short name (`ENV~1`): the part of
 *  windowsAlias that also holds for a shell word, where a colon is common.
 *  On Windows only (review round 2 of spec 078): elsewhere `HEAD~1` and
 *  `main~3` are git's. `windows`: the platform, when the caller knows it. */
export function shortNameAlias(path: string, windows = onWindows()): boolean {
  return windows && SHORT_NAME(path)
}

export function isRawOnly(path: string, extra: readonly string[]): boolean {
  const normal = path.replace(/\\/g, '/')
  const patterns = [
    ...DEFAULT_RAW_ONLY,
    ...extra.filter((p) => p && !p.startsWith('!')).map((p) => normaliseRawOnlyPattern(p) ?? p),
  ]
  return patterns.some((p) => matches(normal, p))
}

/**
 * A project's rawOnly pattern read the way a path is (spec 085 R2-15):
 * backslashes as `/`, a leading `/` or `./` dropped (patterns are relative to
 * the project root), a trailing `/` as `/**` (the folder's files), `.` and
 * empty parts dropped, `..` resolved. `**` and `/**` stay match-all. Null for a pattern
 * that can never match a file in the project - one that climbs above the
 * root, names a drive (`C:`) or a home (`~`), or names nothing (`/`, `./`) - which the
 * caller reports (#61) and still applies as written, as before.
 */
export function normaliseRawOnlyPattern(pattern: string): string | null {
  const p = pattern.replace(/\\/g, '/')
  if (/^[A-Za-z]:/.test(p) || p.startsWith('~')) return null
  // A bare `/`, `./` or `.` names no folder: reported, not read as `**`.
  const bare = p.replace(/^(\.?\/)+/, '').replace(/\/+$/, '')
  if (bare === '' || bare === '.') return null
  const parts: string[] = []
  for (const part of (p.endsWith('/') ? `${bare}/**` : bare).split('/')) {
    if (part === '' || part === '.') continue
    if (part !== '..') parts.push(part)
    else if (parts.length === 0) return null
    else parts.pop()
  }
  return parts.length > 0 ? parts.join('/') : null
}

/** The project's own raw-only patterns in `.veilio/guard.json` (`rawOnly`):
 *  its strings, as written. One reader for the Claude Code guard and the MCP
 *  server (spec 078 review round 2), so both refuse the same files. Throws a
 *  SyntaxError when the file is not JSON; the caller fails closed. */
export function guardJsonRawOnly(text: string): string[] {
  return rawOnlyOf(JSON.parse(text))
}

/** `rawOnly` of an already parsed guard.json. */
export function rawOnlyOf(settings: unknown): string[] {
  const list = (settings as { rawOnly?: unknown } | null)?.rawOnly
  return Array.isArray(list) ? list.filter((p): p is string => typeof p === 'string') : []
}

/** guardJsonRawOnly per project root, read again only when the file's mtime
 *  changes. `mtimeMs` undefined: there is no file, and no patterns. */
export class GuardJsonCache {
  private byRoot = new Map<string, { mtimeMs: number; patterns: string[] }>()
  get(root: string, mtimeMs: number | undefined, read: () => string): string[] {
    if (mtimeMs === undefined) {
      this.byRoot.delete(root)
      return []
    }
    const hit = this.byRoot.get(root)
    if (hit && hit.mtimeMs === mtimeMs) return hit.patterns
    const patterns = guardJsonRawOnly(read())
    this.byRoot.set(root, { mtimeMs, patterns })
    return patterns
  }
}
