import { describe, expect, it } from 'vitest'
import {
  cdTargets,
  DEFAULT_RAW_ONLY,
  isRawOnly,
  normalisePath,
  normaliseRawOnlyPattern,
  pathsInCommand,
  rawOnlyDirectories,
  shortNameAlias,
  windowsAlias,
} from '../../plugins/veilio-guard/lib/paths.ts'

// FR-004: files that must never reach the model are refused before the tool
// runs. A project can add patterns; it cannot remove the built-in ones.
describe('isRawOnly', () => {
  it.each([
    '.env',
    '/work/project/.env',
    'config/.env.local',
    '.env.production',
    'keys/server.pem',
    'tls/private.key',
    '/home/dev/.ssh/id_rsa',
    '/home/dev/.ssh/id_ed25519.pub',
    '.veilio/map.json',
    '/work/project/.veilio/guard.json',
    'certs/client.p12',
    '.npmrc',
    '/home/dev/.netrc',
    '/home/dev/.pgpass',
    // Credential stores and keystores (security review of the guard's path change).
    '/home/dev/.git-credentials',
    'deploy/.htpasswd',
    'android/release.jks',
    'certs/server.keystore',
    'keys/AuthKey_ABC123.p8',
    'ops/kubeconfig',
    '/home/dev/kubeconfig',
    '/home/dev/.docker/config.json',
    '.docker/config.json',
    'CERTS/SERVER.KEYSTORE',
    // Cloud and cluster credentials where their tools keep them.
    '/home/dev/.kube/config',
    '.kube/config',
    '/home/dev/.kube/cache/discovery/servers.json',
    '/home/dev/.aws/credentials',
    '~/.aws/credentials',
    '/home/dev/.azure/msal_token_cache.json',
    '/home/dev/.config/gcloud/application_default_credentials.json',
  ])('refuses %s', (p) => {
    expect(isRawOnly(p, [])).toBe(true)
  })

  it.each([
    'src/env.ts',
    'docs/environment.md',
    'src/keys.ts',
    'veilio/map.json',
    'src/.envelope.ts',
    'README.md',
    'src/kubeconfig.ts',
    'docs/kubeconfig.md',
    'config.json',
    'docker/config.json',
    'src/keystore.ts',
    'src/jks.ts',
    'src/kube/config.ts',
    'docs/aws/credentials.md',
    'config/gcloud.ts',
  ])('lets %s through', (p) => {
    expect(isRawOnly(p, [])).toBe(false)
  })

  it('adds a project pattern', () => {
    expect(isRawOnly('secrets/prod.yaml', ['secrets/**'])).toBe(true)
    expect(isRawOnly('/work/project/secrets/prod.yaml', ['secrets/**'])).toBe(true)
    expect(isRawOnly('src/a.ts', ['*.sqlite'])).toBe(false)
    expect(isRawOnly('data/app.sqlite', ['*.sqlite'])).toBe(true)
  })

  it('a project pattern cannot remove a built-in one', () => {
    expect(isRawOnly('.env', ['!.env'])).toBe(true)
    expect(DEFAULT_RAW_ONLY).toContain('.env')
  })

  it('matches Windows separators too', () => {
    expect(isRawOnly('C:\\work\\project\\.env', [])).toBe(true)
  })
})

describe('pathsInCommand', () => {
  it('finds the path-like words of a shell command', () => {
    expect(pathsInCommand('cat .env')).toContain('.env')
    expect(pathsInCommand('grep -rn KEY config/.env.local src')).toEqual(
      expect.arrayContaining(['config/.env.local', 'src'])
    )
    expect(pathsInCommand("cat '.env'")).toContain('.env')
    expect(pathsInCommand('cat <.env')).toContain('.env')
    expect(pathsInCommand('head -1 ./.env|wc')).toContain('./.env')
    expect(pathsInCommand('cp ~/.ssh/id_rsa /tmp/x')).toContain('~/.ssh/id_rsa')
  })
})

describe('pathsInCommand: flags that carry a path', () => {
  it('checks the value of --flag=path', () => {
    expect(pathsInCommand('node --env-file=.env -e x')).toContain('.env')
    expect(pathsInCommand('docker run --env-file=config/.env.local alpine env')).toContain(
      'config/.env.local'
    )
  })
})

// A command is refused when any of its words names a raw-only file. The check
// reads the words as written; it is not a shell (COVERAGE.md).
const refused = (command: string) => pathsInCommand(command).some((w) => isRawOnly(w, []))

describe('pathsInCommand: values, streams and lists', () => {
  it.each([
    'gc .\\.env::$DATA',
    'Get-Content -Path .env:Zone.Identifier',
    'Get-Content -Path:.env',
    'gc notes.md,.env',
    'cat {README.md,.env}',
    'node --opt:x=.env app.js',
    'FOO=.env ./run.sh',
  ])('refuses %s', (command) => {
    expect(refused(command)).toBe(true)
  })

  it.each([
    'cat src/env.ts',
    'ls -la',
    'git log --format=%h:%s',
    'echo {a,b}.ts',
    'gc notes.md',
    'grep -rn ".*env" src',
    'ls *.*',
    "grep -rn '[z-a]env' src",
  ])('lets %s through', (command) => {
    expect(refused(command)).toBe(false)
  })
})

describe('isRawOnly: case', () => {
  it.each(['.ENV', 'C:\\work\\.Env.Local', 'keys/SERVER.PEM', '.VEILIO/map.json', 'ID_RSA'])(
    'refuses %s: NTFS and APFS ignore case',
    (p) => {
      expect(isRawOnly(p, [])).toBe(true)
    }
  )
})

// Spec 078 R4: `.`/`..` resolved, and the directories a cd may not enter,
// derived from the patterns (never a hand-kept list).
describe('normalisePath, rawOnlyDirectories, cdTargets (spec 078)', () => {
  it.each([
    ['.aws/sso/../credentials', '.aws/credentials'],
    ['./.kube/./config', '.kube/config'],
    ['a/../../.veilio', '../.veilio'],
    ['/x/../.aws', '/.aws'],
    ['~/.aws/', '~/.aws'],
    ['..', '..'],
    ['.', '.'],
  ])('normalises %j to %j', (path, want) => {
    expect(normalisePath(path)).toBe(want)
  })

  it('derives the directories of the slash patterns, with each leading part', () => {
    const dirs = rawOnlyDirectories([...DEFAULT_RAW_ONLY, 'secrets/**', 'config/prod/*.yaml'])
    for (const d of ['.veilio', '.kube', '.aws', '.azure', '.config', '.config/gcloud', '.docker'])
      expect(dirs).toContain(d)
    expect(dirs).toContain('secrets')
    expect(dirs).toContain('config/prod')
    expect(dirs).toContain('config')
    expect(dirs).not.toContain('.env')
  })

  it.each([
    ['cd .aws', ['.aws']],
    ['ls && cd a; pushd b', ['a', 'b']],
    ['cd -P x', ['x']],
    ['cd', []],
    ['grep cd src', []],
    ['ls & cd y', ['y']],
    ['(cd z)', ['z']],
  ])('finds the cd targets of %j', (command, want) => {
    expect(cdTargets(command)).toEqual(want)
  })
})

// Security review of the MCP raw-only refusal: Windows spellings of a
// raw-only file. NTFS opens `.env::$DATA`, `.env:x` and `.env.` as `.env`, and
// `ENV~1` is its 8.3 short name. String-level here; a live Windows check is
// still owed.
describe('Windows spellings of a raw-only path (spec 078)', () => {
  it.each([
    '.env::$DATA',
    '.env:x',
    '.env.',
    '.env. .',
    'C:\\work\\.env::$DATA',
    'keys/id_rsa.',
    '.veilio./map.json',
  ])('isRawOnly(%j)', (path) => {
    expect(isRawOnly(path, [])).toBe(true)
  })
  it.each(['C:\\work\\a:b.txt', 'src/x.ts:stream', 'ENV~1', 'C:\\PROGRA~1\\x', 'keys/ID_RSA~2'])(
    'windowsAlias(%j): a stream or a short name, which no name match can judge',
    (path) => {
      expect(windowsAlias(path)).toBe(true)
    }
  )
  it.each(['C:\\work\\src\\a.ts', 'src/a.ts', '/home/dev/notes~.md', 'a~b/c.ts'])(
    'windowsAlias(%j) is false',
    (path) => {
      expect(windowsAlias(path)).toBe(false)
    }
  )
})

// Review round 2 #2: an 8.3 short name is a Windows thing; elsewhere `~1` in
// a shell word is git's or a backup's (`HEAD~1`, `main~3`).
describe('shortNameAlias is Windows-only (spec 078 review round 2)', () => {
  it.each(['HEAD~1', 'main~3', 'ENV~1'])('%j is not a short name off Windows', (word) => {
    expect(shortNameAlias(word, false)).toBe(false)
  })
  it.each(['ENV~1', 'C:\\PROGRA~1\\x'])('%j is a short name on Windows', (word) => {
    expect(shortNameAlias(word, true)).toBe(true)
  })
  it('defaults to the platform it runs on', () => {
    expect(shortNameAlias('ENV~1')).toBe(process.platform === 'win32')
  })
})

// Spec 085 L19: the audit's spellings. Each component is read as the file it
// names on NTFS (stream and trailing dots or spaces dropped), not only the last.
describe('Windows names of a raw-only path (spec 085 L19)', () => {
  it.each([
    'C:/repo/.npmrc::$DATA',
    'C:/repo/.env::$DATA',
    'C:/repo/.veilio::$INDEX_ALLOCATION/map.json',
    'C:/repo/.npmrc.',
    'C:/repo/.env:notes',
    '/repo/.env. ',
  ])('isRawOnly(%j)', (path) => {
    expect(isRawOnly(path, [])).toBe(true)
  })
  it.each(['src/a.ts', 'C:/repo/src/time:12.ts'])('isRawOnly(%j) is false', (path) => {
    expect(isRawOnly(path, [])).toBe(false)
  })
})

// Spec 085 part 3, R2-15 (security audit run-2): a rawOnly pattern written
// with a leading `/` or `./`, a trailing `/`, or backslashes protected
// nothing, and the cd check read it differently. One normaliser, in the
// engine, for every reader; a pattern that can never match is reported.
describe('rawOnly patterns are read the way paths are (R2-15)', () => {
  it.each([
    ['/work/p/secrets/db.yml', 'secrets/'],
    ['/work/p/config/prod.yml', '/config/prod.yml'],
    ['/work/p/secrets/x', './secrets/x'],
    ['C:\\p\\secrets\\a.yml', 'secrets\\**'],
  ])('%s is raw-only under %s', (path, pattern) => {
    expect(isRawOnly(path, [pattern])).toBe(true)
  })

  it('the cd check reads them the same way', () => {
    expect(rawOnlyDirectories(['/config/prod.yml'])).toEqual(
      rawOnlyDirectories(['config/prod.yml'])
    )
    expect(rawOnlyDirectories(['secrets/'])).toEqual(rawOnlyDirectories(['secrets/**']))
    expect(rawOnlyDirectories(['secrets\\**'])).toEqual(rawOnlyDirectories(['secrets/**']))
  })

  it('a pattern that can never match is reported, and still applied as written', () => {
    for (const p of ['../x', 'C:/x', '.', '/', './', '~/.ssh/**', 'a/../..'])
      expect(normaliseRawOnlyPattern(p), p).toBeNull()
    expect(normaliseRawOnlyPattern('/config/prod.yml')).toBe('config/prod.yml')
    // As on main: a reported pattern loses nothing it matched before.
    expect(isRawOnly('/work/p/~/.ssh/id', ['~/.ssh/**'])).toBe(true)
    expect(rawOnlyDirectories(['~/.ssh/**'])).toEqual(['~', '~/.ssh'])
  })

  // Review of the run-2 guard branch: `**` stays match-all, and `..` inside
  // a pattern is resolved rather than refused.
  it.each([
    ['**', '/work/p/src/a.ts', true],
    ['/**', '/work/p/src/a.ts', true],
    ['secrets/../config/**', '/work/p/config/prod.yml', true],
    ['secrets/../config/**', '/work/p/secrets/db.yml', false],
  ])('%s against %s: %s', (pattern, path, raw) => {
    expect(isRawOnly(path, [pattern])).toBe(raw)
  })

  it('normal forms of **, /** and secrets/../config/**', () => {
    expect(normaliseRawOnlyPattern('**')).toBe('**')
    expect(normaliseRawOnlyPattern('/**')).toBe('**')
    expect(normaliseRawOnlyPattern('secrets/../config/**')).toBe('config/**')
    expect(rawOnlyDirectories(['secrets/../config/**'])).toEqual(['config'])
  })
})
