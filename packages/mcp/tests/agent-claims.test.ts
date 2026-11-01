import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

// Spec 067 benchmark: project names reached the model in 93-96 of 96 MCP and
// CLI sessions, because the agent also read files and test output with its own
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
}
const OVERCLAIM =
  /only ever sees|never sees `?PaymentGateway|without the real identifiers (ever )?entering its context|anonymize files before it reads them/i
const LIMIT = /(does not|not) stop (an|the) agent reading|own (file|file, search) and shell tools/i

describe('what MCP promises an agent (spec 067)', () => {
  it.each(Object.entries(TEXTS))(
    '%s does not say the agent never sees the real names',
    (_, text) => {
      expect(text).not.toMatch(OVERCLAIM)
    }
  )
  it.each(Object.entries(TEXTS))('%s says what it does not stop', (_, text) => {
    expect(text).toMatch(LIMIT)
  })
})
