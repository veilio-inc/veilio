// Review round 3 #1: the host may answer "is this Windows?" with a plain
// boolean as well as a promise; the guard starts either way and uses it.
import { afterEach, beforeEach, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Guard, type GuardIO } from '../../plugins/veilio-guard/lib/guard.ts'

let root: string
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'veilio-host-windows-')))
  mkdirSync(join(root, '.veilio'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

for (const answer of [true, Promise.resolve(true)])
  it(`starts with the host's answer ${answer instanceof Promise ? 'as a promise' : 'as a plain boolean'}`, async () => {
    const io = {
      read: async (p: string) => readFileSync(p, 'utf8'),
      write: async () => undefined,
      exists: async (p: string) => existsSync(p),
      realPath: async (p: string) => (existsSync(p) ? realpathSync(p) : undefined),
      windows: () => answer,
    } as unknown as GuardIO
    const guard = new Guard(io, { rawOnly: [], mcpRestore: [] })
    await guard.load(root, join(root, 'home'))
    const out = await guard.beforeTool({ tool: 'Bash', command: 'cat ENV~1' })
    expect('deny' in out && out.deny).toContain('away from the model')
  })
