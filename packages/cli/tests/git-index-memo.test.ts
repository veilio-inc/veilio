import { describe, it, expect, vi, beforeEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { tmpdir } from 'node:os'

// Review round 1 (#5): every store read parsed the whole git index again; one
// scrub read it several times, and the MCP server once per tool call. It is
// now parsed once per process while the index file is unchanged.
const reads = vi.hoisted(() => ({ n: 0 }))
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  return {
    ...real,
    readFileSync: ((path: unknown, ...rest: unknown[]) => {
      if (typeof path === 'string' && path.endsWith(`${sep}.git${sep}index`)) reads.n++
      return (real.readFileSync as (...a: unknown[]) => unknown)(path, ...rest)
    }) as typeof real.readFileSync,
  }
})
const { main } = await import('../src/index.js')

const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
let cwd: string
let home: string
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd, env: { ...GIT_ENV, HOME: home }, stdio: 'ignore' })
const scrub = () =>
  main(['scrub'], {
    cwd,
    home,
    stdin: async () => 'export class QuasarLedger {}\n',
    stdout: () => {},
    stderr: () => {},
  })
beforeEach(() => {
  reads.n = 0
  home = mkdtempSync(join(tmpdir(), 'veilio-gim-home-'))
  cwd = mkdtempSync(join(tmpdir(), 'veilio-gim-'))
  git('init', '-q')
  writeFileSync(join(cwd, 'a.ts'), 'x\n')
  git('add', 'a.ts')
})

describe('the git index is read once while it is unchanged', () => {
  it('one scrub parses the index once', async () => {
    expect(await scrub()).toBe(0)
    expect(reads.n).toBe(1)
  })

  it('a second scrub with the index unchanged reads it no more', async () => {
    await scrub()
    await scrub()
    expect(reads.n).toBe(1)
  })

  it('a changed index is read again', async () => {
    await scrub()
    writeFileSync(join(cwd, 'b.ts'), 'y\n')
    git('add', 'b.ts')
    await scrub()
    expect(reads.n).toBe(2)
  })
})
