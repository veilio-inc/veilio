// Spec 078 review round 2 #10: the Claude Code guard and the MCP server read
// `.veilio/guard.json`'s rawOnly through one engine loader, so they refuse the
// same files.
import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Guard, type GuardIO } from '../../plugins/veilio-guard/lib/guard.ts'
import { projectRawOnly } from '../../packages/mcp/src/tools.ts'

let root: string
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'veilio-guard-json-')))
  mkdirSync(join(root, '.veilio'))
  writeFileSync(
    join(root, '.veilio', 'guard.json'),
    '{"rawOnly":["secrets/**",7,"!keep/**","notes/*.txt"],"mcpRestore":[]}\n'
  )
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

it('the guard and the MCP server read the same raw-only patterns from guard.json', async () => {
  const io: GuardIO = {
    read: async (p) => readFileSync(p, 'utf8'),
    write: async () => undefined,
    exists: async (p) => existsSync(p),
    realPath: async (p) => (existsSync(p) ? realpathSync(p) : undefined),
  }
  const guard = new Guard(io, { rawOnly: [], mcpRestore: [] })
  await guard.load(root, join(root, 'home'))
  expect(guard.extraRawOnly).toEqual(['secrets/**', '!keep/**', 'notes/*.txt'])
  expect(projectRawOnly(root)).toEqual(guard.extraRawOnly)
})
