import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { handleMessage } from '../src/server.js'

// Spec 067 benchmark (run 3): project names reached the model in 93-95 of 96 MCP
// and CLI sessions, because the agent also read files and test output with its own
// tools. MCP masks what passes through it and nothing else, so no published
// text may say the agent never sees the real names, and each says what it does
// not do.
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const TEXTS = {
  'packages/mcp/README.md': read('../README.md'),
  'packages/mcp/package.json description': JSON.parse(read('../package.json'))
    .description as string,
  'README.md': read('../../../README.md'),
  'docs/USING-THE-CLI-AND-MCP.md': read('../../../docs/USING-THE-CLI-AND-MCP.md'),
  'the server instructions (initialize)': (
    handleMessage(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { cwd: '/', mapPath: null }
    ) as { result: { instructions: string } }
  ).result.instructions,
}
// What the server tells a model about each tool, `restore_text` included.
const TOOL_TEXTS = Object.fromEntries(
  (
    handleMessage(
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { cwd: '/', mapPath: null, restoreText: true }
    ) as { result: { tools: { name: string; description: string }[] } }
  ).result.tools.map((t) => [`tool ${t.name} description`, t.description])
)
const OVERCLAIM =
  /only ever sees?|never enters? (your|the assistant'?s?) context|never sees `?PaymentGateway|without the real identifiers (ever )?entering its context|anonymize files before it reads them/i
const LIMIT = /(does not|not) stop (an|the) agent reading|own (file|file, search) and shell tools/i

describe('what MCP promises an agent (spec 067)', () => {
  it.each(Object.entries(TEXTS))(
    '%s does not say the agent never sees the real names',
    (_, text) => {
      expect(text).not.toMatch(OVERCLAIM)
    }
  )
  it('lists every tool, restore_text included', () => {
    expect(Object.keys(TOOL_TEXTS)).toEqual(
      expect.arrayContaining([
        'tool anonymize_file description',
        'tool anonymize_text description',
        'tool restore_text description',
      ])
    )
  })
  it.each(Object.entries(TOOL_TEXTS))(
    '%s does not say the model never sees the real names',
    (_, text) => {
      expect(text).not.toMatch(OVERCLAIM)
    }
  )
  it.each(Object.entries(TEXTS))('%s says what it does not stop', (_, text) => {
    expect(text).toMatch(LIMIT)
  })
  it.each(Object.entries(TEXTS))('%s names the guard', (_, text) => {
    expect(text).toMatch(/veilio-guard|the guard/i)
  })
})

// Founder, 4 Nov: Veilio is used as a set - the guard, the CLI and the MCP
// server together - and every README says so in the same words and figures.
const DOCS = {
  'README.md': read('../../../README.md'),
  'docs/USING-THE-CLI-AND-MCP.md': read('../../../docs/USING-THE-CLI-AND-MCP.md'),
  'packages/mcp/README.md': read('../README.md'),
  'packages/cli/README.md': read('../../cli/README.md'),
  'packages/engine/README.md': read('../../engine/README.md'),
  'plugins/veilio-guard/README.md': read('../../../plugins/veilio-guard/README.md'),
}
describe('every README presents Veilio as a set', () => {
  it.each(Object.entries(DOCS))('%s says to install all three together', (_, text) => {
    expect(text).toContain(
      'Veilio is a set: install the guard, the CLI and the MCP server together.'
    )
    expect(text).toContain(
      'Without the guard, the CLI and the MCP server protect only what passes through them.'
    )
    expect(text).toContain(
      '93-95 of 96 sessions with the MCP server or the CLI alone, and in 0 of 96 with the guard'
    )
  })
  it.each(Object.entries(DOCS))('%s no longer treats them as alternatives', (_, text) => {
    expect(text).not.toMatch(/with a coding agent, use the guard/i)
    expect(text).not.toMatch(/93-96 of 96/)
  })
})
