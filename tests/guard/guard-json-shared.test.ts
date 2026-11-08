// Spec 078 review round 2 #10: the Claude Code guard reads `.veilio/guard.json`'s
// rawOnly through the engine's one loader. The MCP server's half, which needs
// the built CLI, is in packages/mcp/tests/guard-json-shared.test.ts.
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
import { guardJsonRawOnly } from '../../packages/engine/src/index.ts'

const TEXT = '{"rawOnly":["secrets/**",7,"!keep/**","notes/*.txt"],"mcpRestore":[]}\n'
let root: string
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'veilio-guard-json-')))
  mkdirSync(join(root, '.veilio'))
  writeFileSync(join(root, '.veilio', 'guard.json'), TEXT)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

it("the guard reads guard.json's raw-only patterns as the engine's loader does", async () => {
  const io: GuardIO = {
    read: async (p) => readFileSync(p, 'utf8'),
    write: async () => undefined,
    exists: async (p) => existsSync(p),
    realPath: async (p) => (existsSync(p) ? realpathSync(p) : undefined),
  }
  const guard = new Guard(io, { rawOnly: [], mcpRestore: [] })
  await guard.load(root, join(root, 'home'))
  expect(guard.extraRawOnly).toEqual(['secrets/**', '!keep/**', 'notes/*.txt'])
  expect(guard.extraRawOnly).toEqual(guardJsonRawOnly(TEXT))
})
