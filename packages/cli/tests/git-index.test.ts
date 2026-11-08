import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { trackedPaths } from '../src/git-index.js'

// Spec 085 R1: the CLI and the MCP server may not spawn git (offline.test.ts,
// MCP purity.test.ts), so the store reads the index file itself. The tests may
// spawn: they build each index with the real git.

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  HOME: tmpdir(),
}
const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    'git',
    [
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@example.invalid',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd, env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }
  ).toString()

function repo(files: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'veilio-gix-'))
  git(dir, 'init', '-q')
  for (const f of files) {
    mkdirSync(join(dir, f, '..'), { recursive: true })
    writeFileSync(join(dir, f), 'x\n')
  }
  if (files.length) git(dir, 'add', '--', ...files)
  return dir
}
const indexVersion = (dir: string) => readFileSync(join(dir, '.git', 'index')).readUInt32BE(4)

describe('the git index, read without git', () => {
  it('lists the paths of a version 2 index, case-folded', () => {
    const dir = repo(['src/a.ts', '.veilio/Map.json'])
    git(dir, 'update-index', '--index-version', '2')
    expect(indexVersion(dir)).toBe(2)
    const t = trackedPaths(dir)!
    expect(t.root).toBe(dir)
    expect([...t.paths].sort()).toEqual(['.veilio/map.json', 'src/a.ts'])
  })

  it('reads a version 3 index with an extended entry', () => {
    const dir = repo(['src/a.ts'])
    writeFileSync(join(dir, 'b.ts'), 'y\n')
    git(dir, 'add', '-N', 'b.ts') // intent-to-add sets an extended flag
    git(dir, 'update-index', '--index-version', '3')
    mkdirSync(join(dir, '.veilio'))
    writeFileSync(join(dir, '.veilio', 'map.json'), '{}')
    git(dir, 'add', '.veilio/map.json')
    expect(indexVersion(dir)).toBe(3)
    expect([...trackedPaths(dir)!.paths].sort()).toEqual(['.veilio/map.json', 'b.ts', 'src/a.ts'])
  })

  it('reads a version 4 index, whose paths are prefix-compressed', () => {
    const dir = repo(['.veilio/aliases.json', '.veilio/map.json', 'src/a.ts', 'src/ab.ts'])
    git(dir, 'update-index', '--index-version', '4')
    expect(indexVersion(dir)).toBe(4)
    expect([...trackedPaths(dir)!.paths].sort()).toEqual([
      '.veilio/aliases.json',
      '.veilio/map.json',
      'src/a.ts',
      'src/ab.ts',
    ])
  })

  it('finds the index from a subdirectory', () => {
    const dir = repo(['src/deep/a.ts'])
    const t = trackedPaths(join(dir, 'src', 'deep'))!
    expect(t.root).toBe(dir)
    expect(t.paths.has('src/deep/a.ts')).toBe(true)
  })

  it('follows a worktree .git file to its own index', () => {
    const dir = repo(['src/a.ts'])
    git(dir, 'commit', '-qm', 'one')
    const wt = join(mkdtempSync(join(tmpdir(), 'veilio-gix-wt-')), 'wt')
    git(dir, 'worktree', 'add', '-q', wt)
    mkdirSync(join(wt, '.veilio'))
    writeFileSync(join(wt, '.veilio', 'map.json'), '{}')
    git(wt, 'add', '.veilio/map.json')
    expect(trackedPaths(wt)!.paths.has('.veilio/map.json')).toBe(true)
    expect(trackedPaths(dir)!.paths.has('.veilio/map.json')).toBe(false)
  })

  it('answers unknown (null) for a split index', () => {
    const dir = repo(['src/a.ts', '.veilio/map.json'])
    git(dir, 'update-index', '--split-index')
    expect(trackedPaths(dir)).toBeNull()
  })

  it('answers unknown (null) for a truncated index', () => {
    const dir = repo(['src/a.ts', '.veilio/map.json'])
    truncateSync(join(dir, '.git', 'index'), 40)
    expect(trackedPaths(dir)).toBeNull()
  })

  it('answers unknown (null) for a file that is not an index', () => {
    const dir = repo(['src/a.ts'])
    writeFileSync(join(dir, '.git', 'index'), 'not an index at all, just text')
    expect(trackedPaths(dir)).toBeNull()
  })

  it('answers null outside a git checkout', () => {
    expect(trackedPaths(mkdtempSync(join(tmpdir(), 'veilio-gix-none-')))).toBeNull()
  })

  it('an empty repository lists nothing, which is not unknown', () => {
    const dir = repo([])
    expect(trackedPaths(dir)?.paths.size ?? 0).toBe(0)
  })

  it('reads 2000 entries, the store last', () => {
    const files = Array.from({ length: 1999 }, (_, i) => `src/f${String(i).padStart(4, '0')}.ts`)
    const dir = repo([...files, 'zz/.veilio/map.json'])
    for (const v of ['2', '4']) {
      git(dir, 'update-index', '--index-version', v)
      const t = trackedPaths(dir)!
      expect(t.paths.size).toBe(2000)
      expect(t.paths.has('zz/.veilio/map.json')).toBe(true)
    }
  })
})

// Review round 2 (#9): an index rewritten in place with the same size and
// mtime (an editor, a tool, a coarse clock) must not be answered from the
// cache: the stamp also holds ctime and the index's own trailing checksum.
describe('the parsed index is not reused for a different index', () => {
  it('two indexes of one size, written over each other with the same mtime', () => {
    const a = repo(['.veilio/map.json'])
    const b = repo(['.veilio/map.jsox'])
    const indexA = readFileSync(join(a, '.git', 'index'))
    const indexB = readFileSync(join(b, '.git', 'index'))
    expect(indexA.length).toBe(indexB.length)
    const target = join(a, '.git', 'index')
    const second = 1_700_000_000 // a whole second, so it can be set again exactly
    utimesSync(target, second, second)
    expect(trackedPaths(a)!.paths.has('.veilio/map.json')).toBe(true)
    writeFileSync(target, indexB) // same inode, same size
    utimesSync(target, second, second) // same mtime
    expect(statSync(target).mtimeMs).toBe(second * 1000)
    expect(trackedPaths(a)!.paths.has('.veilio/map.json')).toBe(false)
    expect(trackedPaths(a)!.paths.has('.veilio/map.jsox')).toBe(true)
  })
})
