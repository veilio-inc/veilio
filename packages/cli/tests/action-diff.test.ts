import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { parse } from 'yaml'

// Review round 1 (#11): the GitHub Action's diff mode piped a rendered diff
// into `veilio scan`, the same blind spot the pre-commit hook had (spec 085
// L1): no file names, and a `-diff` attribute hid a file. It now scans each
// changed file's blob under its name, as the hook does. The action's own two
// scripts are run here, as the runner would, with `npx` a shim to the built CLI.

const ACTION = resolve(import.meta.dirname, '..', 'action.yml')
const CLI = resolve(import.meta.dirname, '..', 'dist', 'index.js')
const ENV = ['DB', 'PASSWORD=NotARealPass9'].join('_') + '\n'
const TS = 'export const PaymentGateway = (x: number) => x\n'
const steps = (
  parse(readFileSync(ACTION, 'utf8')) as { runs: { steps: { name: string; run?: string }[] } }
).runs.steps
const script = (name: string) => steps.find((s) => s.name === name)!.run!

let bin: string
let repo: string
let work: string
beforeAll(() => {
  bin = mkdtempSync(join(tmpdir(), 'veilio-action-bin-'))
  // npx --yes @veilio-inc/cli@<version> <args>: run the built CLI with <args>.
  writeFileSync(join(bin, 'npx'), `#!/bin/sh\nshift 2\nexec "${process.execPath}" "${CLI}" "$@"\n`)
  chmodSync(join(bin, 'npx'), 0o755)
  // npm view <spec> version: the registry answers, or (NPM_VIEW_FAILS) does not.
  writeFileSync(
    join(bin, 'npm'),
    '#!/bin/sh\n[ -n "$NPM_VIEW_FAILS" ] && exit 1\n[ -n "$NPM_VIEW_EMPTY" ] && exit 0\necho 1.0.0\n'
  )
  chmodSync(join(bin, 'npm'), 0o755)
})
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'veilio-action-repo-'))
  work = mkdtempSync(join(tmpdir(), 'veilio-action-work-'))
  git('init', '-q')
})
afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
  rmSync(work, { recursive: true, force: true })
})

const env = () => ({
  ...process.env,
  HOME: work,
  PATH: `${bin}:${process.env.PATH}`,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.invalid',
})
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: repo, env: env() }).toString().trim()
function commit(files: Record<string, string>): string {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(repo, name, '..'), { recursive: true })
    writeFileSync(join(repo, name), text)
  }
  git('add', '--', ...Object.keys(files))
  git('commit', '-qm', 'c')
  return git('rev-parse', 'HEAD')
}
/** The two steps, as a push of before..head runs them (or another event,
 *  with the pull request's base and head, or `paths`). */
function action(
  before: string,
  head: string,
  ev: { name?: string; prBase?: string; prHead?: string; paths?: string } = {}
) {
  const out = join(work, 'out')
  writeFileSync(out, '')
  const targets = script('Resolve scan targets')
    .replaceAll('${{ github.event_name }}', ev.name ?? 'push')
    .replaceAll('${{ github.event.before }}', before)
    .replaceAll('${{ github.sha }}', head)
    .replaceAll('${{ github.event.pull_request.base.sha }}', ev.prBase ?? '')
    .replaceAll('${{ github.event.pull_request.head.sha }}', ev.prHead ?? '')
  const t = spawnSync('bash', ['-c', targets], {
    cwd: repo,
    env: { ...env(), PATHS: ev.paths ?? '', GITHUB_OUTPUT: out },
    encoding: 'utf8',
  })
  if (t.status !== 0) return { status: t.status, json: '[]', log: t.stderr + t.stdout }
  const mode = /mode=(\w+)/.exec(readFileSync(out, 'utf8'))![1]!
  const summary = join(work, 'summary')
  const scan = spawnSync('bash', ['-c', script('Scan')], {
    cwd: repo,
    env: {
      ...env(),
      PATHS: ev.paths ?? '',
      STRICT: 'false',
      VERSION: 'latest',
      MODE: mode,
      GITHUB_OUTPUT: out,
      GITHUB_STEP_SUMMARY: summary,
    },
    encoding: 'utf8',
  })
  return { status: scan.status, json: readFileSync('/tmp/veilio.json', 'utf8'), log: scan.stderr }
}

describe('the GitHub Action scans each changed file under its own name', () => {
  it('a .env beside a TypeScript change fails the step, and the finding names the file', () => {
    const base = commit({ 'README.md': '# PaymentGateway\n' })
    const head = commit({ '.env': ENV, 'src/gateway.ts': TS })
    const r = action(base, head)
    expect(r.status).toBe(1)
    expect((JSON.parse(r.json) as { file: string }[]).map((f) => f.file)).toContain('.env')
  })

  it('a .env hidden from the diff by `*.env -diff` still fails it', () => {
    const base = commit({ '.gitattributes': '*.env -diff\n' })
    const head = commit({ 'config/prod.env': ENV, 'src/gateway.ts': TS })
    expect(action(base, head).status).toBe(1)
  })

  it('a new branch (all-zero base) scans its one commit, a root commit included', () => {
    const head = commit({ '.env': ENV })
    expect(action('0'.repeat(40), head).status).toBe(1)
  })

  // Review round 2 (#2): for a merge, diff-tree with one commit prints
  // nothing, so a new branch whose tip is a merge was not scanned at all.
  it('a new branch whose tip is a merge scans what the merge brings in', () => {
    commit({ 'README.md': '# PaymentGateway\n' })
    const main = git('rev-parse', '--abbrev-ref', 'HEAD')
    git('checkout', '-q', '-b', 'side')
    commit({ '.env': ENV })
    git('checkout', '-q', main)
    commit({ 'src/gateway.ts': TS })
    git('merge', '-q', '--no-ff', '-m', 'merge side', 'side')
    const head = git('rev-parse', 'HEAD')
    expect(git('rev-list', '--parents', '-n', '1', head).split(' ')).toHaveLength(3)
    expect(action('0'.repeat(40), head).status).toBe(1)
  })

  it('a change that deletes a file passes', () => {
    const base = commit({ 'old.ts': TS })
    git('rm', '-q', 'old.ts')
    const head = commit({ 'src/gateway.ts': TS })
    expect(action(base, head).status).toBe(0)
  })

  it('a clean change passes', () => {
    const base = commit({ 'README.md': '# PaymentGateway\n' })
    const head = commit({ 'src/gateway.ts': TS })
    expect(action(base, head).status).toBe(0)
  })
})

// Spec 085 part 3, R2-20 (security audit run-2): every event but pull_request
// was read as a push, so under pull_request_target (github.sha the base tip,
// no before) the step scanned the base branch's last commit and passed.
describe('the Action scans the pull request, and only on events it knows (R2-20)', () => {
  function pr() {
    const base = commit({ 'README.md': '# PaymentGateway\n' })
    git('checkout', '-qb', 'feature')
    const head = commit({ '.env': ENV })
    git('checkout', '-q', '-')
    return { base, head }
  }

  it('pull_request_target scans the pull request', () => {
    const { base, head } = pr()
    const r = action('', base, { name: 'pull_request_target', prBase: base, prHead: head })
    expect(r.status).toBe(1)
    expect((JSON.parse(r.json) as { file: string }[]).map((f) => f.file)).toContain('.env')
  })

  it('pull_request scans it, as before', () => {
    const { base, head } = pr()
    expect(action('', base, { name: 'pull_request', prBase: base, prHead: head }).status).toBe(1)
  })

  it('an event it does not support fails the step and scans nothing', () => {
    const { base } = pr()
    const r = action('', base, { name: 'workflow_dispatch' })
    expect(r.status).toBe(1)
    expect(r.log).toContain(
      'veilio action: the `workflow_dispatch` event is not supported (push, pull_request, pull_request_target). Nothing was scanned, so this step fails. Use `mode: paths` to scan named files on other events.'
    )
  })
})

// Spec 085 part 3, R2-21: with `paths: '*'`, a committed file named `-h`
// turned the scan into help, which exits 0.
describe('globbed paths are passed as paths (R2-21)', () => {
  it('a file named -h does not turn the scan into help', () => {
    writeFileSync(join(repo, '-h'), '')
    writeFileSync(join(repo, 'README.md'), '# notes\n')
    writeFileSync(join(repo, '.env'), ENV)
    const r = action('', '', { paths: '* .env' })
    expect(r.status).toBe(1)
    expect((JSON.parse(r.json) as { file: string }[]).some((f) => f.file.endsWith('.env'))).toBe(
      true
    )
  })

  it('without it, the same scan fails on the .env', () => {
    writeFileSync(join(repo, 'README.md'), '# notes\n')
    writeFileSync(join(repo, '.env'), ENV)
    expect(action('', '', { paths: '* .env' }).status).toBe(1)
  })
})

describe('a blank paths input scans the diff (R2-21 review)', () => {
  it('whitespace only is no paths', () => {
    const base = commit({ 'README.md': '# notes\n' })
    const head = commit({ '.env': ENV })
    expect(action(base, head, { paths: '   ' }).status).toBe(1)
  })
})

describe('the version the Action runs must be on the registry', () => {
  const scan = (extra: Record<string, string>) => {
    writeFileSync(join(work, 'ran'), '')
    // Records that npx was reached.
    writeFileSync(
      join(bin, 'npx'),
      `#!/bin/sh\necho ran >> "${join(work, 'ran')}"\nshift 2\nexec "${process.execPath}" "${CLI}" "$@"\n`
    )
    return spawnSync('bash', ['-c', script('Scan')], {
      cwd: repo,
      env: {
        ...env(),
        PATHS: '.',
        STRICT: 'false',
        MODE: 'paths',
        GITHUB_OUTPUT: join(work, 'out'),
        GITHUB_STEP_SUMMARY: join(work, 'summary'),
        ...extra,
      },
      encoding: 'utf8',
    })
  }
  it('fails, naming the version, when the registry does not have it, and runs nothing', () => {
    const r = scan({ VERSION: '9.9.9', NPM_VIEW_FAILS: '1' })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('@veilio-inc/cli@9.9.9')
    expect(readFileSync(join(work, 'ran'), 'utf8')).toBe('')
  })
  it('fails when npm exits 0 and prints nothing', () => {
    const r = scan({ VERSION: '9.9.9', NPM_VIEW_EMPTY: '1' })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('could not be found on the npm registry')
    expect(readFileSync(join(work, 'ran'), 'utf8')).toBe('')
  })
  it('runs the CLI when the registry has it', () => {
    const r = scan({ VERSION: '0.12.1' })
    expect(r.stderr).not.toContain('could not be found')
    expect(readFileSync(join(work, 'ran'), 'utf8')).toContain('ran')
  })
})
