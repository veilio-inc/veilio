import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { main } from '../src/index.js'
import { EXIT_ERROR, EXIT_FINDINGS, EXIT_OK, type Io } from '../src/commands.js'

// Review round 1 (#1, #2): `veilio scan --blobs <listing>` scans every file a
// `git diff --raw --no-abbrev` listing names, its content read by object id
// from `git cat-file --batch` on stdin: one process for the whole commit, and
// no `:path` revision syntax (a staged `0:foo` is not foo's stage-0 blob).

const ENV = ['DB', 'PASSWORD=NotARealPass9'].join('_') + '\n'
const TS = 'export const PaymentGateway = (x: number) => x\n'
const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
let repo: string
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: repo, env: { ...GIT_ENV, HOME: repo } })
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'veilio-blobs-'))
  git('init', '-q')
})
afterEach(() => rmSync(repo, { recursive: true, force: true }))

function stage(files: Record<string, string | Buffer>) {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(repo, name, '..'), { recursive: true })
    writeFileSync(join(repo, name), text)
  }
  git('add', '--', ...Object.keys(files))
}
/** The listing and the batch, as the hook builds them. */
function staged(): { raw: string; batch: Buffer } {
  const listing = git(
    '-c',
    'core.quotepath=true',
    'diff',
    '--cached',
    '--raw',
    '--no-abbrev',
    '--no-renames',
    '--diff-filter=d'
  ).toString()
  const raw = join(repo, '.git', 'veilio-raw')
  writeFileSync(raw, listing)
  const ids =
    listing
      .split('\n')
      .filter(Boolean)
      .map((l) => l.split(' ')[3])
      .join('\n') + '\n'
  const batch = execFileSync('git', ['cat-file', '--batch'], {
    cwd: repo,
    env: { ...GIT_ENV, HOME: repo },
    input: ids,
  })
  return { raw, batch }
}
async function scan(argv: string[], batch: Buffer) {
  let out = ''
  let err = ''
  const io: Io = {
    cwd: repo,
    home: repo,
    stdin: async () => batch.toString('utf8'),
    stdinBytes: async () => batch,
    stdout: (t) => (out += t),
    stderr: (t) => (err += t),
  }
  return { code: await main(['scan', ...argv], io), out, err }
}

describe('veilio scan --blobs', () => {
  it('scans each listed blob under its own name', async () => {
    stage({ '.env': ENV, 'src/gateway.ts': TS })
    const { raw, batch } = staged()
    const r = await scan(['--blobs', raw], batch)
    expect(r.code).toBe(EXIT_FINDINGS)
    expect(r.err).toContain('.env')
    expect(r.err).not.toContain('<stdin>')
  })

  it('a clean commit passes', async () => {
    stage({ 'src/gateway.ts': TS, 'README.md': '# PaymentGateway\n' })
    const { raw, batch } = staged()
    expect((await scan(['--quiet', '--blobs', raw], batch)).code).toBe(EXIT_OK)
  })

  it('a path that reads as revision syntax is scanned as itself', async () => {
    stage({ foo: 'nothing here\n', '0:foo': ENV, '1:x': ENV })
    const { raw, batch } = staged()
    const r = await scan(['--blobs', raw], batch)
    expect(r.code).toBe(EXIT_FINDINGS)
    expect(r.err).toContain('0:foo')
    expect(r.err).toContain('1:x')
  })

  it('a quoted path (a newline, a non-ASCII letter) is read back as the name it is', async () => {
    stage({ 'odd\nname.env': ENV, 'Zahlungsdienst-ü.env': ENV })
    const { raw, batch } = staged()
    const r = await scan(['--json', '--blobs', raw], batch)
    expect(r.code).toBe(EXIT_FINDINGS)
    const files = new Set((JSON.parse(r.out) as { file: string }[]).map((f) => f.file))
    expect(files).toEqual(new Set(['odd\nname.env', 'Zahlungsdienst-ü.env']))
  })

  it('binary blobs and submodules are skipped', async () => {
    stage({ 'logo.bin': Buffer.concat([Buffer.from([0, 1, 2, 0]), Buffer.from(ENV)]) })
    git(
      'update-index',
      '--add',
      '--cacheinfo',
      `160000,${'0123456789abcdef'.repeat(2)}01234567,sub`
    )
    const { raw, batch } = staged()
    expect((await scan(['--quiet', '--blobs', raw], batch)).code).toBe(EXIT_OK)
  })

  it('a deleted file in the listing has no blob and is skipped', async () => {
    stage({ 'old.ts': TS })
    git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'one')
    git('rm', '-q', 'old.ts')
    stage({ 'src/gateway.ts': TS })
    const listing = git('diff', '--cached', '--raw', '--no-abbrev', '--no-renames').toString()
    expect(listing).toMatch(/\tD?old\.ts|D\told\.ts/)
    const raw = join(repo, '.git', 'veilio-raw-d')
    writeFileSync(raw, listing)
    const ids =
      listing
        .split('\n')
        .filter(Boolean)
        .map((l) => l.split(' ')[3])
        .join('\n') + '\n'
    const batch = execFileSync('git', ['cat-file', '--batch'], {
      cwd: repo,
      env: { ...GIT_ENV, HOME: repo },
      input: ids,
    })
    expect((await scan(['--quiet', '--blobs', raw], batch)).code).toBe(EXIT_OK)
  })

  it('a blob missing from the batch is an error, never a pass', async () => {
    stage({ '.env': ENV, 'src/gateway.ts': TS })
    const { raw, batch } = staged()
    const cut = batch.subarray(0, batch.indexOf(0x0a) + 5)
    const r = await scan(['--quiet', '--blobs', raw], cut)
    expect(r.code).toBe(EXIT_ERROR)
    expect(r.err).toMatch(/cut short/)
    const none = await scan(['--quiet', '--blobs', raw], Buffer.alloc(0))
    expect(none.code).toBe(EXIT_ERROR)
    expect(none.err).toContain('could not read the staged')
  })

  it('a listing line that is not git raw output is an error', async () => {
    const raw = join(repo, 'bad-raw')
    writeFileSync(raw, 'not a listing\n')
    const r = await scan(['--quiet', '--blobs', raw], Buffer.alloc(0))
    expect(r.code).toBe(EXIT_ERROR)
  })

  it('--blobs with file names, or with --name, is a usage error', async () => {
    writeFileSync(join(repo, 'a.ts'), TS)
    expect((await scan(['--blobs', 'x', 'a.ts'], Buffer.alloc(0))).code).toBe(EXIT_ERROR)
    expect((await scan(['--blobs', 'x', '--name', 'a.ts'], Buffer.alloc(0))).code).toBe(EXIT_ERROR)
  })
})
