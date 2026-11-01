import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { writeCredential } from '@veilio-inc/cli/credential'
import { writeRules } from '@veilio-inc/cli/rules'
import { RULES_STOPPED_NOTE, type CustomRule } from '@veilio-inc/engine'
import { primeRules, resetRulesCache } from '../src/rules.js'
import { callTool } from '../src/tools.js'
import { holdKeys } from '../../cli/tests/helpers/fake-cloud.js'

// Security audit: anonymize_text says when custom rules stopped matching.
const INSTANCE = 'https://veilio.test'
const ACCOUNT = 'a@example.test'
const HOSTILE = Array.from({ length: 20 }, (_, i): CustomRule => ({
  id: `h${i}`,
  scope: 'team',
  team_id: 't1',
  sort_order: i,
  name: `h${i}`,
  type: 'whitelist',
  pattern: `(\\w?\\w?){50}#|x${i}`,
  enabled: true,
}))
const SOURCE = Array.from({ length: 5000 }, (_, i) => `const identifier_name_${i}abc = 1`).join(
  '\n'
)

let home: string
let cwd: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'veilio-mcp-rb-home-'))
  cwd = mkdtempSync(join(tmpdir(), 'veilio-mcp-rb-'))
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))
  resetRulesCache()
  writeCredential({ token: 'session', account: ACCOUNT, instance: INSTANCE }, home)
  holdKeys(home, ACCOUNT, INSTANCE)
})
afterEach(() => {
  vi.unstubAllGlobals()
  resetRulesCache()
  rmSync(home, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
})

describe('anonymize_text and the rule budget', () => {
  it('warns when custom rules stopped matching', async () => {
    writeRules(
      { instance: INSTANCE, account: ACCOUNT, pulledAt: new Date().toISOString(), rules: HOSTILE },
      home
    )
    expect((await primeRules(home)).source).toBe('cached')
    const r = callTool('anonymize_text', { text: SOURCE }, { cwd, mapPath: null })
    expect(r.text).toContain(`WARNING: ${RULES_STOPPED_NOTE}`)
  })
})
