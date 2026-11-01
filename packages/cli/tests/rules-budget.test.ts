import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RULES_STOPPED_NOTE, type CustomRule } from '@veilio-inc/engine'
import { main } from '../src/index.js'
import { EXIT_OK, type Io } from '../src/commands.js'
import { writeCredential } from '../src/credential.js'
import { writeRules } from '../src/rules.js'
import { holdKeys } from './helpers/fake-cloud.js'

// Security audit: one anonymize call spends at most a budget of matching
// steps on custom rules; past it rules answer no-match, and scrub says so.
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
  home = mkdtempSync(join(tmpdir(), 'veilio-rb-home-'))
  cwd = mkdtempSync(join(tmpdir(), 'veilio-rb-work-'))
  mkdirSync(join(cwd, '.git'), { recursive: true })
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
  writeCredential({ token: 'session', account: ACCOUNT, instance: INSTANCE }, home)
  holdKeys(home, ACCOUNT, INSTANCE)
})
afterEach(() => {
  vi.unstubAllGlobals()
  rmSync(home, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
})

async function scrub(): Promise<{ code: number; out: string; err: string }> {
  let out = ''
  let err = ''
  const io: Io = {
    cwd,
    home,
    stdin: async () => SOURCE,
    stdout: (t) => (out += t),
    stderr: (t) => (err += t),
    prompt: async () => '',
    password: async () => '',
  }
  return { code: await main(['scrub', '--quiet'], io), out, err }
}

describe('scrub and the rule budget', () => {
  it('says when custom rules stopped matching, even under --quiet', async () => {
    writeRules(
      { instance: INSTANCE, account: ACCOUNT, pulledAt: new Date().toISOString(), rules: HOSTILE },
      home
    )
    const res = await scrub()
    expect(res.code, res.err).toBe(EXIT_OK)
    expect(res.err).toContain(RULES_STOPPED_NOTE)
    expect(res.out).not.toMatch(/identifier_name_/)
  })

  it('says nothing with ordinary rules', async () => {
    writeRules(
      {
        instance: INSTANCE,
        account: ACCOUNT,
        pulledAt: new Date().toISOString(),
        rules: [{ ...HOSTILE[0]!, pattern: '^acme_' }],
      },
      home
    )
    const res = await scrub()
    expect(res.err).not.toContain(RULES_STOPPED_NOTE)
  })
})
