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
    shortNameAlias(path) ||
    path.split(/[\\/]/).some((seg, i) => seg.includes(':') && !(i === 0 && /^[A-Za-z]:$/.test(seg)))
  )
}

/** A segment shaped like an 8.3 short name (`ENV~1`): the part of
 *  windowsAlias that also holds for a shell word, where a colon is common. */
export function shortNameAlias(path: string): boolean {
  return path.split(/[\\/]/).some((seg) => /^[^~]{1,6}~\d+(\.[^.]*)?$/.test(seg))
}

export function isRawOnly(path: string, extra: readonly string[]): boolean {
  const normal = path.replace(/\\/g, '/')
  const patterns = [...DEFAULT_RAW_ONLY, ...extra.filter((p) => p && !p.startsWith('!'))]
  return patterns.some((p) => matches(normal, p))
}
