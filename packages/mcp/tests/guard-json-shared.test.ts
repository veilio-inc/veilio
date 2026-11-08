// Spec 078 review round 2 #10: the MCP server reads `.veilio/guard.json`'s
// rawOnly through the engine's one loader, the one the guard uses (the
// guard's half is in tests/guard/guard-json-shared.test.ts).
import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { guardJsonRawOnly } from '@veilio-inc/engine'
import { projectRawOnly } from '../src/tools.js'

const TEXT = '{"rawOnly":["secrets/**",7,"!keep/**","notes/*.txt"],"mcpRestore":[]}\n'
let root: string
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'veilio-mcp-guard-json-')))
  mkdirSync(join(root, '.veilio'))
  writeFileSync(join(root, '.veilio', 'guard.json'), TEXT)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

it("the MCP server reads guard.json's raw-only patterns as the engine's loader does", () => {
  expect(projectRawOnly(root)).toEqual(['secrets/**', '!keep/**', 'notes/*.txt'])
  expect(projectRawOnly(root)).toEqual(guardJsonRawOnly(TEXT))
})
