// Spec 078 US8 (B#7, FR-018, Q1 = A): restore_text puts the real names into
// the agent's context, so it is offered only when the person starts the
// server with VEILIO_MCP_RESTORE=1 - read once, at start, from the server's
// own environment.
import { describe, expect, it } from 'vitest'
import { contextFromArgv } from '../src/index.js'
import { handleMessage } from '../src/server.js'
import { callTool } from '../src/tools.js'
import { isolateHome } from './helpers/isolated-home.js'

isolateHome()

const names = (ctx: ReturnType<typeof contextFromArgv>) => {
  const r = handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, ctx) as {
    result: { tools: { name: string }[] }
  }
  return r.result.tools.map((t) => t.name)
}

describe('restore_text is opt-in (spec 078)', () => {
  it('without VEILIO_MCP_RESTORE=1 it is not listed, and a direct call is an unknown tool', () => {
    const ctx = contextFromArgv([], {})
    expect(names(ctx)).not.toContain('restore_text')
    expect(names(ctx)).toContain('anonymize_file')
    const r = callTool('restore_text', { text: 'new __CLS__1()' }, ctx)
    expect(r).toEqual({ text: 'Unknown tool "restore_text".', isError: true })
  })

  it('with VEILIO_MCP_RESTORE=1 it is listed and works', () => {
    const ctx = contextFromArgv([], { VEILIO_MCP_RESTORE: '1' })
    expect(names(ctx)).toContain('restore_text')
    expect(callTool('restore_text', { text: 'x' }, ctx).text).not.toContain('Unknown tool')
  })

  it('only an exact "1" turns it on', () => {
    for (const v of ['true', 'yes', '0', ''])
      expect(names(contextFromArgv([], { VEILIO_MCP_RESTORE: v }))).not.toContain('restore_text')
  })

  it('is read once, at start: not from a later change, a tool argument or VEILIO_PROJECT', () => {
    const env: Record<string, string | undefined> = { VEILIO_PROJECT: 'VEILIO_MCP_RESTORE=1' }
    const ctx = contextFromArgv([], env)
    env.VEILIO_MCP_RESTORE = '1'
    expect(names(ctx)).not.toContain('restore_text')
    const r = callTool('restore_text', { text: 'x', VEILIO_MCP_RESTORE: '1' }, ctx)
    expect(r.text).toBe('Unknown tool "restore_text".')
  })
})
