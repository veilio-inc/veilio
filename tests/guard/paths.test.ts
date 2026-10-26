import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RAW_ONLY,
  isRawOnly,
  pathsInCommand,
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
