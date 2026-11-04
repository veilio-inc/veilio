import { describe, it, expect } from 'vitest'
import { LINE_A, LINE_B } from '@veilio-inc/cli/guard-hint'
import { handleMessage } from '../src/server.js'
import type { ToolContext } from '../src/tools.js'

// Spec 070 US1/US2: the agent is told too, in the instructions it gets once.
const instructions = (ctx: Partial<ToolContext>) =>
  (
    handleMessage(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { cwd: '/', mapPath: null, ...ctx }
    ) as { result: { instructions: string } }
  ).result.instructions

const sentence = (line: string) => line.replace(/^veilio: /, '')

describe('the MCP instructions carry the hint', () => {
  it.each([
    ['Line A', LINE_A],
    ['Line B', LINE_B],
  ])('%s, once, without the stderr prefix', (_, line) => {
    const text = instructions({ guardHint: line })
    expect(text.split(sentence(line)).length - 1).toBe(1)
    expect(text).not.toContain('veilio: ')
  })
  it('nothing extra when there is no hint', () => {
    const base = instructions({})
    expect(instructions({ guardHint: null })).toBe(base)
    expect(base).not.toContain(sentence(LINE_A))
    expect(base).not.toContain(sentence(LINE_B))
  })
})
