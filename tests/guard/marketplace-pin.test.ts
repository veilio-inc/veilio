import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// Spec 083 US2 (research R4): the marketplace names the guard by a release
// tag and its commit, and the plugin's version at that commit is the tag's.
const ROOT = join(__dirname, '../..')
const SCRIPT = join(ROOT, 'scripts/pin-guard.mjs')
const MANIFEST = 'plugins/veilio-guard/.claude-plugin/plugin.json'
const URL = 'https://github.com/veilio-inc/veilio.git'

let repo: string
const git = (...args: string[]) =>
  execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
const run = (...args: string[]) =>
  spawnSync('node', [SCRIPT, ...args], { cwd: repo, encoding: 'utf8' })

function version(v: string) {
  writeFileSync(join(repo, MANIFEST), JSON.stringify({ name: 'veilio-guard', version: v }))
  git('add', '-A')
  git('commit', '-qm', `guard ${v}`)
  return git('rev-parse', 'HEAD')
}
function entry(source: unknown) {
  writeFileSync(
    join(repo, '.claude-plugin/marketplace.json'),
    JSON.stringify({ name: 'veilio', plugins: [{ name: 'veilio-guard', source }] })
  )
}
const pinned = (ref: string, sha: string) => ({
  source: 'git-subdir',
  url: URL,
  path: 'plugins/veilio-guard',
  ref,
  sha,
})

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'guard-pin-'))
  mkdirSync(join(repo, 'plugins/veilio-guard/.claude-plugin'), { recursive: true })
  mkdirSync(join(repo, '.claude-plugin'))
  git('init', '-q')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'test')
  git('config', 'commit.gpgsign', 'false')
  git('config', 'tag.gpgsign', 'false')
})
afterEach(() => rmSync(repo, { recursive: true, force: true }))

describe('pin-guard --check', () => {
  it("passes when the tag names the pinned commit and its plugin.json has the tag's version", () => {
    const sha = version('0.8.0')
    git('tag', 'veilio-guard@0.8.0', sha)
    entry(pinned('veilio-guard@0.8.0', sha))
    const r = run('--check')
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
  })

  it("compares against the pinned commit's plugin.json, not the current one", () => {
    const sha = version('0.8.0')
    git('tag', 'veilio-guard@0.8.0', sha)
    version('0.9.0')
    entry(pinned('veilio-guard@0.8.0', sha))
    expect(run('--check').status).toBe(0)
  })

  it("fails when the pinned commit's version is not the tag's", () => {
    const sha = version('0.8.0')
    git('tag', 'veilio-guard@0.9.0', sha)
    entry(pinned('veilio-guard@0.9.0', sha))
    const r = run('--check')
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('is 0.8.0 at')
  })

  it('fails when the tag does not exist', () => {
    const sha = version('0.8.0')
    entry(pinned('veilio-guard@0.8.0', sha))
    const r = run('--check')
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('no tag veilio-guard@0.8.0')
  })

  it('fails when the tag points at another commit', () => {
    const first = version('0.8.0')
    const sha = version('0.8.0-b')
    git('tag', 'veilio-guard@0.8.0', first)
    entry(pinned('veilio-guard@0.8.0', sha))
    const r = run('--check')
    expect(r.status).toBe(1)
    expect(r.stderr).toContain(`points at ${first}`)
  })

  it('fails on a relative source', () => {
    version('0.8.0')
    entry('./plugins/veilio-guard')
    const r = run('--check')
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('not pinned')
  })
})

describe('pin-guard --pin', () => {
  it('tags the commit with its version and pins the marketplace entry to it', () => {
    const sha = version('0.8.0')
    version('0.9.0')
    entry('./plugins/veilio-guard')
    const r = run('--pin', sha)
    expect(r.stderr).toBe('')
    expect(git('rev-parse', 'veilio-guard@0.8.0^{commit}')).toBe(sha)
    const m = JSON.parse(readFileSync(join(repo, '.claude-plugin/marketplace.json'), 'utf8'))
    expect(m.plugins[0].source).toEqual(pinned('veilio-guard@0.8.0', sha))
    expect(m.plugins[0].name).toBe('veilio-guard')
    expect(run('--check').status).toBe(0)
  })

  it('refuses when the tag already names another commit', () => {
    const first = version('0.8.0')
    const sha = version('0.8.0-b')
    git('tag', 'veilio-guard@0.8.0-b', first)
    entry('./plugins/veilio-guard')
    expect(run('--pin', sha).status).toBe(1)
  })
})

describe('the real marketplace', () => {
  const source = JSON.parse(readFileSync(join(ROOT, '.claude-plugin/marketplace.json'), 'utf8'))
    .plugins[0].source
  it.skipIf(typeof source === 'string')(
    'is pinned to a release tag whose plugin.json version matches (not pinned yet while the source is relative)',
    () => {
      const r = spawnSync('node', [SCRIPT, '--check'], { cwd: ROOT, encoding: 'utf8' })
      expect(r.stderr).toBe('')
      expect(r.status).toBe(0)
    }
  )
})
