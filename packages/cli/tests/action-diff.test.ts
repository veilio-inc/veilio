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
/** The two steps, as a push of before..head runs them. */
function action(before: string, head: string) {
  const out = join(work, 'out')
  writeFileSync(out, '')
  const targets = script('Resolve scan targets')
    .replaceAll('${{ github.event_name }}', 'push')
    .replaceAll('${{ github.event.before }}', before)
    .replaceAll('${{ github.sha }}', head)
  const t = spawnSync('bash', ['-c', targets], {
    cwd: repo,
    env: { ...env(), PATHS: '', GITHUB_OUTPUT: out },
    encoding: 'utf8',
  })
  expect(t.status, t.stderr).toBe(0)
  const mode = /mode=(\w+)/.exec(readFileSync(out, 'utf8'))![1]!
  const summary = join(work, 'summary')
  const scan = spawnSync('bash', ['-c', script('Scan')], {
    cwd: repo,
    env: {
      ...env(),
      PATHS: '',
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
