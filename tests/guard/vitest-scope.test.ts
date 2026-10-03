import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// The plugin's own tests import `claude-code/testing`, which only exists inside
// `claude plugin test`. Collected by vitest they fail on that import, so the
// root run must leave plugins/ alone - and still run this directory.
describe('vitest scope for the Claude Code guard', () => {
  const config = readFileSync(join(__dirname, '../../vite.config.ts'), 'utf8')

  it('excludes the plugin directory, whose tests run under claude plugin test', () => {
    expect(config).toMatch(/'plugins\/\*\*'/)
  })

  it('does not exclude tests/guard', () => {
    expect(config).not.toMatch(/'tests\/\*\*'|'tests\/guard/)
  })
})
