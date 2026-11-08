import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

// Spec 085 L1 (security audit run-1): the shipped hook scanned the rendered
// staged diff on stdin, so a staged .env next to a TypeScript change, or one
// a .gitattributes `-diff` hid, was committed. The hook now scans each staged
// file's blob under its own name. Run here as git runs it, with `veilio` on
// PATH a shim to the built CLI.

const HOOK = resolve(import.meta.dirname, '..', 'hooks', 'pre-commit')
const CLI = resolve(import.meta.dirname, '..', 'dist', 'index.js')
const ENV = 'DB_PASSWORD=NotARealPass9\n'
const TS = 'export const PaymentGateway = (x: number) => x\n'

let bin: string
let home: string
let repo: string
beforeAll(() => {
  bin = mkdtempSync(join(tmpdir(), 'veilio-hook-bin-'))
  writeFileSync(join(bin, 'veilio'), `#!/bin/sh\nexec "${process.execPath}" "${CLI}" "$@"\n`)
  chmodSync(join(bin, 'veilio'), 0o755)
})
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'veilio-hook-home-'))
  repo = mkdtempSync(join(tmpdir(), 'veilio-hook-repo-'))
  git('init', '-q')
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(repo, { recursive: true, force: true })
})

const env = () => ({
  ...process.env,
  HOME: home,
  PATH: `${bin}:${process.env.PATH}`,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.invalid',
})
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: repo, env: env(), stdio: 'ignore' })
function stage(files: Record<string, string | Buffer>) {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(repo, name, '..'), { recursive: true })
    writeFileSync(join(repo, name), text)
  }
  git('add', '--', ...Object.keys(files))
}
const hook = (path = bin) =>
  spawnSync('sh', [HOOK], {
    cwd: repo,
    env: { ...env(), PATH: `${path}:${process.env.PATH}` },
    encoding: 'utf8',
  })

describe('the pre-commit hook scans each staged file under its own name (L1)', () => {
  it('a staged .env beside a TypeScript change blocks the commit', () => {
    stage({ '.env': ENV, 'src/gateway.ts': TS })
    const r = hook()
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('Commit blocked')
  })

  it('a .env hidden from the diff by `*.env -diff` still blocks', () => {
    stage({ '.gitattributes': '*.env -diff\n', 'config/prod.env': ENV, 'src/gateway.ts': TS })
    const r = hook()
    expect(r.status).toBe(1)
    // The finding names the staged file, not stdin.
    expect(r.stderr).toContain('config/prod.env')
    expect(r.stderr).not.toContain('<stdin>')
  })

  it('what is staged is scanned, not the working tree', () => {
    stage({ '.env': 'APP_ENV=production\n' })
    writeFileSync(join(repo, '.env'), ENV) // dirty, not staged
    expect(hook().status).toBe(0)
    stage({ 'b.env': ENV })
    writeFileSync(join(repo, 'b.env'), 'APP_ENV=production\n') // the staged blob holds it
    expect(hook().status).toBe(1)
  })

  // A submodule entry is a commit of another repository: there is no blob
  // here to scan, and it must not block the commit.
  it('a staged submodule is skipped, and a credential beside it still blocks', () => {
    git(
      'update-index',
      '--add',
      '--cacheinfo',
      `160000,${'0123456789abcdef'.repeat(2)}01234567,sub`
    )
    stage({ 'src/gateway.ts': TS })
    expect(hook().status).toBe(0)
    stage({ '.env': ENV })
    expect(hook().status).toBe(1)
  })

  it('a staged binary file is skipped', () => {
    stage({ 'logo.bin': Buffer.concat([Buffer.from([0, 1, 2, 0]), Buffer.from(ENV)]) })
    expect(hook().status).toBe(0)
  })

  it('a staged path with a newline in its name is scanned like any other', () => {
    stage({ 'odd\nname.ts': TS })
    expect(hook().status).toBe(0)
    stage({ 'odd\nname.env': ENV })
    expect(hook().status).toBe(1)
  })

  // Security review: `--diff-filter=ACM` left out renames and type changes.
  it('a credential added to a file the commit renames blocks', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `SETTING_${i}=value${i}`).join('\n')
    stage({ 'old.env': `${lines}\n` })
    git('commit', '-qm', 'one')
    git('mv', 'old.env', 'new.env')
    writeFileSync(join(repo, 'new.env'), `${lines}\n${ENV}`)
    git('add', 'new.env')
    expect(hook().status).toBe(1)
  })

  it('a credential in a file that was a link and is now a plain file blocks', () => {
    symlinkSync('elsewhere.txt', join(repo, 'config.env'))
    git('add', 'config.env')
    git('commit', '-qm', 'one')
    unlinkSync(join(repo, 'config.env'))
    stage({ 'config.env': ENV })
    expect(hook().status).toBe(1)
  })

  it('a staged path that starts with a dash is scanned', () => {
    stage({ '-notes.ts': TS })
    expect(hook().status).toBe(0)
    stage({ '-x.env': ENV })
    expect(hook().status).toBe(1)
  })

  it('a clean change passes, and so does nothing staged', () => {
    expect(hook().status).toBe(0)
    stage({ 'src/gateway.ts': TS, 'README.md': '# PaymentGateway\n' })
    expect(hook().status).toBe(0)
  })

  // Review round 1 (#1): the hook read `:<path>`, which git parses as a
  // revision: a staged `0:foo` scanned foo's blob instead.
  it('a staged path that reads as revision syntax is scanned as itself', () => {
    stage({ foo: 'nothing here\n' })
    git('commit', '-qm', 'one')
    stage({ '0:foo': ENV })
    expect(hook().status).toBe(1)
    git('reset', '-q')
    stage({ '1:x': ENV })
    expect(hook().status).toBe(1)
  })

  // Review round 1 (#2): one veilio process for the whole commit.
  it('300 staged files are checked in one go', () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < 300; i++) files[`src/m${i}.ts`] = `export const v${i} = ${i}\n`
    stage(files)
    const started = Date.now()
    expect(hook().status).toBe(0)
    // One node start; a process per file took about 0.3 s each here.
    expect(Date.now() - started).toBeLessThan(20_000)
  }, 60_000)

  // Review round 1 (#9): a finding and a failure to check say different things.
  it('a finding says credentials; a failure to check says it could not check, and both block', () => {
    stage({ '.env': ENV })
    const found = hook()
    expect(found.status).toBe(1)
    expect(found.stderr).toContain('Commit blocked: credentials detected in the staged changes.')
    const broken = mkdtempSync(join(tmpdir(), 'veilio-hook-broken-'))
    writeFileSync(
      join(broken, 'veilio'),
      '#!/bin/sh\necho "veilio: something broke here" >&2\nexit 2\n'
    )
    chmodSync(join(broken, 'veilio'), 0o755)
    const failed = hook(broken)
    expect(failed.status).toBe(1)
    expect(failed.stderr).toContain(
      'Commit blocked: veilio could not check the staged files: veilio: something broke here'
    )
    expect(failed.stderr).not.toContain('credentials detected')
  })

  // Review round 1 (#10): the header named a .pre-commit-hooks.yaml the
  // repository does not have. A file the hook names must exist.
  it('the hook names no pre-commit framework file that is not there', () => {
    const text = readFileSync(HOOK, 'utf8')
    const named = text.includes('.pre-commit-hooks.yaml')
    expect(
      named && !existsSync(resolve(import.meta.dirname, '..', '..', '..', '.pre-commit-hooks.yaml'))
    ).toBe(false)
  })
})
