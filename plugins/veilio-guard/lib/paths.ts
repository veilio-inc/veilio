// Files the model must never read (spec 033, FR-004).
//
// Refused before the tool runs, on the path the model wrote and on the path
// after its placeholders are restored. A project adds patterns in
// .veilio/guard.json or the plugin's settings; it cannot remove these.
//
// For shell commands this is a check on the words of the command, not a
// sandbox: `cat .env` is refused, a script that opens .env is not. The
// coverage statement says so; strict mode (a later spec) is the answer to it.

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
]

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
  return new RegExp(`^${re}$`)
}

function matches(path: string, pattern: string): boolean {
  const re = globToRegExp(pattern)
  const parts = path.split('/').filter((p) => p !== '' && p !== '.')
  // A pattern with no slash matches a file name anywhere; one with a slash
  // matches any tail of the path, so `secrets/**` holds at any depth.
  if (!pattern.includes('/')) return parts.some((p) => re.test(p))
  for (let i = 0; i < parts.length; i++) if (re.test(parts.slice(i).join('/'))) return true
  return false
}

export function isRawOnly(path: string, extra: readonly string[]): boolean {
  const normal = path.replace(/\\/g, '/')
  const patterns = [...DEFAULT_RAW_ONLY, ...extra.filter((p) => p && !p.startsWith('!'))]
  return patterns.some((p) => matches(normal, p))
}

/** The words of a shell command that could name a file: unquoted, split on
 *  whitespace, shell operators, braces and commas, flags dropped but the value
 *  of a `--flag=value` or PowerShell `-Path:value` kept (`--env-file=.env`).
 *  Braces and commas cover a PowerShell script block and argument list
 *  (`{ gc .env }`, `gc a,.env`) and a Bash brace expansion. Over-inclusive on
 *  purpose. */
export function pathsInCommand(command: string): string[] {
  return command
    .split(/[\s|&;<>()`$,{}]+/)
    .map((w) => w.replace(/^['"]+|['"]+$/g, ''))
    .map((w) => {
      if (!w.startsWith('-')) return w
      const at = w.search(/[=:]/)
      return at === -1 ? w : w.slice(at + 1).replace(/^['"]+|['"]+$/g, '')
    })
    .filter((w) => w !== '' && !w.startsWith('-'))
}
